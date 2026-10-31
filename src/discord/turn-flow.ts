import { ackRunDeliveryWithRetry, type CoreTurnBody, type SurfaceCoreClient } from "../api/surface-core-client.ts";
import { GENERIC_FAILURE_TEXT } from "../../plugins/chassis/src/failure-copy.ts";
import { INTERNAL_ONLY_REFUSAL_REASON } from "../core/failure-copy.ts";
import type { TurnResult } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import { toDiscordFiles, type DiscordFile } from "./attachments.ts";
import { DISCORD_RUN_RECOVERY_GRACE_MS } from "./deliveries.ts";
import { chunkMessage } from "./format.ts";

export interface StatusMessage {
  id: string;
  edit(content: string): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface ReplyChannel {
  send(content: string, files?: DiscordFile[]): Promise<StatusMessage>;
  typing(): Promise<void>;
}

const TYPING_REFRESH_MS = 8_000;
const WORKING_TEXT = "⚙ Working…";
const REFUSED_GUEST_TEXT =
  "I can't answer here: people outside the organization can read this channel. Ask me in a private channel or a DM.";
const REFUSED_STREAM_TEXT = "I can't post this reply here right now.";
const EMPTY_REPLY_TEXT = "(no response)";
const APPROVAL_TEXT = "This needs an approval before I can continue. Approve it in the QM web app";
const APPROVAL_DM_TEXT =
  "This needs your approval — I sent you the buttons in a direct message. If they don't arrive, approve it in the QM web app";
const STREAM_EDIT_INTERVAL_MS = 1500;

export type ReactHandler = (names: readonly string[]) => Promise<void>;

export type TurnInput =
  | {
      core: SurfaceCoreClient;
      channel: ReplyChannel;
      body: CoreTurnBody;
      mode: "spine";
      ownedRuns: Set<string>;
      mayPost: () => Promise<boolean>;
      onReact?: ReactHandler;
      onNoReply?: () => Promise<void>;
    }
  | {
      core: SurfaceCoreClient;
      channel: ReplyChannel;
      body: CoreTurnBody;
      mode: "stream";
      onReact?: ReactHandler;
      inFlightRuns: Set<string>;
      streamIntervalMs?: number;
      onAccepted?: () => Promise<void>;
      onSettled?: (result: TurnResult) => Promise<void>;
      mayPost: () => Promise<boolean>;
    };

function approvalText(result: TurnResult): string {
  if (!result.pendingApprovals?.length) {
    if (result.reason) return result.reason;
    return result.adminUrl ? `${APPROVAL_TEXT}: ${result.adminUrl}` : `${APPROVAL_TEXT}.`;
  }
  return result.adminUrl ? `${APPROVAL_DM_TEXT}: ${result.adminUrl}` : `${APPROVAL_DM_TEXT}.`;
}

function lazyStatus(channel: ReplyChannel): StatusMessage {
  let sent: Promise<StatusMessage> | undefined;
  return {
    id: "",
    edit: async (content) => {
      if (sent) await (await sent).edit(content);
      else sent = channel.send(content);
      await sent;
    },
    delete: async () => {
      if (sent) await (await sent).delete();
    },
  };
}

async function notice(quiet: boolean, status: Pick<StatusMessage, "edit">, text: string): Promise<void> {
  if (quiet) swallowAs("discord: unprompted turn stays quiet", undefined)(new Error(text));
  else await status.edit(text);
}

export function refusalText(reason: string | undefined): string {
  return reason === INTERNAL_ONLY_REFUSAL_REASON ? REFUSED_GUEST_TEXT : `I can't do that: ${reason ?? "refused"}`;
}

async function streamRun(
  core: SurfaceCoreClient,
  runId: string,
  status: StatusMessage,
  intervalMs: number,
  mayPost: () => Promise<boolean>,
  quiet: boolean,
): Promise<{ result: TurnResult | null; stoppedByGate: boolean }> {
  let shown = "";
  let stoppedByGate = false;
  let finished = false;
  let inFlight = false;
  let inFlightTick: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (inFlight || stoppedByGate || finished) return;
    inFlight = true;
    inFlightTick = (async () => {
      try {
        const preview = chunkMessage(core.streamSnapshot(runId) ?? "")[0];
        if (!preview || preview === shown) return;
        const allowed = await mayPost();
        if (stoppedByGate || finished) return;
        if (!allowed) {
          stoppedByGate = true;
          clearInterval(timer);
          await notice(quiet, status, REFUSED_STREAM_TEXT).catch(swallowAs("discord: refusal edit", undefined));
          return;
        }
        shown = preview;
        await status.edit(preview).catch(swallowAs("discord: stream edit", undefined));
      } finally {
        inFlight = false;
      }
    })().catch(swallowAs("discord: stream tick", undefined));
  }, intervalMs);
  try {
    const result = await core.waitRun(runId);
    return { result, stoppedByGate };
  } finally {
    finished = true;
    clearInterval(timer);
    await inFlightTick;
  }
}

async function deliver(
  result: TurnResult | null,
  status: StatusMessage,
  channel: ReplyChannel,
  core: SurfaceCoreClient,
  onReact: ReactHandler | undefined,
  quiet: boolean,
): Promise<void> {
  if (!result || result.status === "failed") {
    await notice(quiet, status, GENERIC_FAILURE_TEXT);
    return;
  }
  if (result.status === "silent") {
    await status.delete();
    return;
  }
  if (result.status === "react") {
    await onReact?.(result.reactions ?? []);
    await status.delete();
    return;
  }
  if (result.status === "refused") {
    await notice(quiet, status, refusalText(result.reason));
    return;
  }
  if (result.status === "pending_approval") {
    await notice(quiet, status, approvalText(result));
    return;
  }
  const { files, notes } = await toDiscordFiles(result.attachments ?? [], core);
  const chunks = chunkMessage([result.reply ?? "", ...notes].filter(Boolean).join("\n\n"));
  if (files.length && !chunks[0]) {
    await status.delete();
    await channel.send("", files);
    return;
  }
  await status.edit(chunks[0] ?? EMPTY_REPLY_TEXT);
  for (const chunk of chunks.slice(1)) await channel.send(chunk);
  if (files.length) await channel.send("", files);
}

async function runStream(input: Extract<TurnInput, { mode: "stream" }>): Promise<void> {
  const { core, channel, body, inFlightRuns, mayPost, streamIntervalMs = STREAM_EDIT_INTERVAL_MS } = input;
  const quiet = body.unprompted === true;
  const status = quiet ? lazyStatus(channel) : await channel.send(WORKING_TEXT);
  let submitted = false;
  let settled = false;
  const settle = async (result: TurnResult) => {
    if (!input.onSettled || settled) return;
    settled = true;
    await input.onSettled(result).catch(swallowAs("discord: onSettled", undefined));
  };
  let runId: string | undefined;
  try {
    const queued = await core.submitTurn({ async: true, ...body });
    submitted = true;
    if (queued.status !== "refused" && queued.status !== "failed" && input.onAccepted) {
      await input.onAccepted().catch(swallowAs("discord: onAccepted", undefined));
    }
    if (queued.steered) {
      await settle(queued);
      await status.delete();
      return;
    }
    runId = queued.status === "queued" ? queued.runId : undefined;
    if (runId) {
      inFlightRuns.add(runId);
      if (!(await mayPost())) {
        await notice(quiet, status, REFUSED_STREAM_TEXT).catch(swallowAs("discord: refusal edit", undefined));
        if (input.onSettled) await settle((await core.waitRun(runId)) ?? { status: "failed" });
        return;
      }
      if (!quiet) await core.reportRunEditRef(runId, status.id);
    }
    const { result, stoppedByGate } = runId
      ? await streamRun(core, runId, status, streamIntervalMs, mayPost, quiet)
      : { result: queued, stoppedByGate: false };
    await settle(result ?? { status: "failed" });
    if (stoppedByGate) return;
    if (!(await mayPost())) {
      await notice(quiet, status, REFUSED_STREAM_TEXT);
      return;
    }
    await deliver(result, status, channel, core, input.onReact, quiet);
    if (runId) await ackRunDeliveryWithRetry(core, runId).catch(swallowAs("discord: delivery ack", undefined));
  } catch (err) {
    swallowAs("discord: turn failed", undefined)(err);
    if (submitted) await settle({ status: "failed" });
    await notice(quiet, status, GENERIC_FAILURE_TEXT).catch(swallowAs("discord: failure edit", undefined));
  } finally {
    if (runId) inFlightRuns.delete(runId);
  }
}

async function runSpine(input: Extract<TurnInput, { mode: "spine" }>): Promise<void> {
  const { core, channel, body, mayPost, ownedRuns } = input;
  const say = (text: string): Promise<void> => notice(body.unprompted === true, { edit: (t) => channel.send(t) }, text);
  const keepTyping = () => void channel.typing().catch(swallowAs("discord: typing", undefined));
  let timer: NodeJS.Timeout | undefined;
  const startTyping = () => {
    if (timer) return;
    keepTyping();
    timer = setInterval(keepTyping, TYPING_REFRESH_MS);
  };
  if (body.unprompted !== true) startTyping();
  let keep = false;
  let ownedRunId: string | undefined;
  try {
    const queued = await core.submitTurn({ async: true, ...body });
    if (queued.steered) return;
    const runId = queued.status === "queued" ? queued.runId : undefined;
    keep = runId !== undefined;
    if (runId) ownedRuns.add(runId);
    ownedRunId = runId;
    const result = runId ? await core.waitRun(runId, { onReplying: startTyping }) : queued;
    keep = result?.status === "ok" || result?.status === "pending_approval";
    if (result?.status === "react") {
      if (await mayPost()) await input.onReact?.(result.reactions ?? []);
    } else if (result?.status === "refused") {
      const allowed = result.reason === INTERNAL_ONLY_REFUSAL_REASON || (await mayPost());
      await say(allowed ? refusalText(result.reason) : REFUSED_STREAM_TEXT);
    } else if (result?.status === "pending_approval") {
      const allowed = await mayPost();
      await say(allowed ? approvalText(result) : REFUSED_STREAM_TEXT);
    }
  } catch (err) {
    swallowAs("discord: spine turn failed", undefined)(err);
    const allowed = await mayPost().catch(swallowAs("discord: may post", false));
    await say(allowed ? GENERIC_FAILURE_TEXT : REFUSED_STREAM_TEXT).catch(
      swallowAs("discord: failure post", undefined),
    );
  } finally {
    clearInterval(timer);
    if (ownedRunId) setTimeout(ownedRuns.delete.bind(ownedRuns), DISCORD_RUN_RECOVERY_GRACE_MS, ownedRunId).unref();
    if (!keep) await input.onNoReply?.();
  }
}

export async function runDiscordTurn(input: TurnInput): Promise<void> {
  return input.mode === "spine" ? runSpine(input) : runStream(input);
}
