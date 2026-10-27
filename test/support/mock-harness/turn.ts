import type { HarnessTurnInput, HarnessTurnResult } from "../../../src/harness/harness.ts";
import { estimateHistoryTokens } from "../../../src/harness/context-compaction.ts";
import { countTokens } from "../../../src/util/tokens.ts";
import { dispatchScenario } from "./scenarios.ts";
import { mockProviderMessages, streamText, withCallIds, type MockHarnessState, type MockTurn } from "./shared.ts";

type CallUsage = (step: number) => {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
};

interface OpenTurn {
  t: MockTurn;
  turnSeq: number;
  usage: CallUsage;
}

function parseCommand(input: string): { cmd: string; command0: string } {
  const firstLine = input.split("\n")[0]?.trim() ?? "";
  const whyCmd = /<why>\s*(![^<\n]+)/.exec(input)?.[1]?.trim();
  const addressedCmd = /<addressed-messages[^>]*>\s*<message[^>]*>\s*(![^<\n]+)/.exec(input)?.[1]?.trim();
  const cmd = firstLine.startsWith("<") ? (whyCmd ?? addressedCmd ?? input) : input;
  return { cmd, command0: cmd.split("\n")[0]?.trim() ?? "" };
}

function mockCallUsage(turn: HarnessTurnInput, command0: string, modelPrompt: string): CallUsage {
  const cacheMiss = command0 === "!cachemiss";
  const systemPromptTokens = countTokens(turn.systemPrompt);
  const prefixTokens = cacheMiss ? Math.max(2048, systemPromptTokens) : Math.max(1, systemPromptTokens);
  const inputTokens = countTokens(modelPrompt);
  return (step) => ({
    input: inputTokens,
    output: 8,
    cacheRead: cacheMiss && step === 0 ? 0 : prefixTokens,
    cacheWrite: cacheMiss && step === 0 ? prefixTokens : 0,
    totalTokens: prefixTokens + inputTokens + 8,
    costUsd: 0,
  });
}

async function recordMockRequest({ t, turnSeq, usage }: OpenTurn, step: number): Promise<void> {
  const { turn, modelPrompt } = t;
  await turn.recordLlmRequest?.({
    turnSeq,
    step,
    model: "mock",
    promptEnvelope: {
      model: "mock",
      system: turn.systemPrompt,
      messages: [...mockProviderMessages(turn.history), { role: "user", content: modelPrompt }],
      ...(turn.images?.length
        ? { images: turn.images.map((image) => ({ mimeType: image.mimeType, dataBase64: image.dataBase64 })) }
        : {}),
      ...(turn.documents?.length
        ? { documents: turn.documents.map(({ name, mimeType, artifactId }) => ({ name, mimeType, artifactId })) }
        : {}),
    },
    truncated: false,
    usage: usage(step),
  });
}

async function openTurn(input: HarnessTurnInput, state: MockHarnessState): Promise<OpenTurn> {
  let turn: HarnessTurnInput = { ...input, emit: withCallIds(input.emit) };
  const continued = turn.continueTurn ? turn.history.find((e) => e.seq === turn.resumeUserSeq) : undefined;
  if (continued) turn = { ...turn, input: "", environment: undefined };
  const userEntry =
    continued ??
    (await turn.emit({
      kind: "UserMessage",
      text: turn.input,
      externalId: turn.triggerTs ?? turn.entryTs ?? null,
      author: turn.runtimeActorId ?? null,
      body: turn.attachments?.length ? { attachments: turn.attachments } : {},
    }));
  const modelPrompt = [turn.input, turn.environment].filter((s) => s && s.trim()).join("\n\n");
  turn.recordModelCall({
    model: "mock",
    inputTokens: countTokens(turn.systemPrompt) + estimateHistoryTokens(turn.history) + countTokens(modelPrompt),
    entryCount: turn.history.length,
  });
  const { cmd, command0 } = parseCommand(turn.input);
  const t: MockTurn = {
    turn,
    cmd,
    command0,
    modelPrompt,
    state,
    usedTool: false,
    silent: false,
    muteReply: false,
    pausedOnApproval: false,
    collected: [],
  };
  const open = { t, turnSeq: userEntry.seq, usage: mockCallUsage(turn, command0, modelPrompt) };
  await recordMockRequest(open, 0);
  return open;
}

async function closeTurn(open: OpenTurn, scriptedReply: string): Promise<HarnessTurnResult> {
  const { t, usage } = open;
  const { turn } = t;
  let reply = scriptedReply;
  if (t.usedTool) await recordMockRequest(open, 1);
  if (turn.images?.length)
    reply += `\n[vision: ${turn.images.length} image(s): ${turn.images.map((i) => i.mimeType).join(", ")}]`;
  streamText(turn, reply);
  await turn.emit({ kind: "AgentMessage", text: reply });
  const modelCalls = t.usedTool ? 2 : 1;
  const cacheUsage = Array.from({ length: modelCalls }, (_, step) => usage(step)).reduce(
    (acc, u) => ({
      cacheRead: acc.cacheRead + u.cacheRead,
      cacheWrite: acc.cacheWrite + u.cacheWrite,
      uncachedInput: acc.uncachedInput + u.input,
    }),
    { cacheRead: 0, cacheWrite: 0, uncachedInput: 0 },
  );
  const base = t.collected.length
    ? {
        reply,
        pendingApprovals: t.collected,
        ...(t.pausedOnApproval ? { pausedOnApproval: true as const } : {}),
        modelCalls,
      }
    : { reply, modelCalls };
  if (t.muteReply) base.reply = "";
  return { ...base, ...(t.silent ? { silent: true as const } : {}), cacheUsage };
}

function resumesAfterDenial(history: HarnessTurnInput["history"]): boolean {
  const last = [...history].reverse().find((e) => e.kind === "UserMessage" || e.kind === "AgentMessage");
  return !!last && last.kind === "UserMessage" && !!last.hidden && last.body?.approvalDenial === true;
}

export async function runMockTurn(input: HarnessTurnInput, state: MockHarnessState): Promise<HarnessTurnResult> {
  const open = await openTurn(input, state);
  if (resumesAfterDenial(input.history)) return closeTurn(open, "carried on without it");
  const outcome = await dispatchScenario(open.t);
  return typeof outcome === "string" ? closeTurn(open, outcome) : outcome.stop;
}
