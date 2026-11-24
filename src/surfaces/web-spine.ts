import { appEditSlug } from "../../plugins/chassis/src/app-edit.ts";
import { isSessionTurn } from "../core/turn-origin.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { isShownReply, type Item, type NewItem } from "../sessions/items.ts";
import { isSubagentThreadRef } from "../sessions/session-syscalls.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { personalScope, type Session } from "../types.ts";
import { snippet } from "../util/text.ts";
import type { TurnStream } from "../runs/turn-stream.ts";
import type { PostedFileMeta, SurfacePostResult } from "../tools/primitives.ts";
import type { SpineState } from "./surface-tools.ts";

export async function webDmSpine(
  flags: Pick<FeatureFlagStore, "enabled"> | undefined,
  input: OrchestratorInput,
  session: Pick<Session, "sideChat"> | null,
): Promise<boolean | undefined> {
  const { conversation, actor } = input;
  const personsWebDm =
    input.surface === "web" &&
    conversation.kind === "dm" &&
    (input.origin.kind === "human" || isSessionTurn(input)) &&
    !isSubagentThreadRef(conversation.threadRef) &&
    !input.swarm &&
    !input.proactiveOpener &&
    !input.privateSessionMessage &&
    !input.readOnly &&
    !input.botActor &&
    !session?.sideChat &&
    appEditSlug(conversation.threadRef, actor.id) === null;
  if (!personsWebDm) return undefined;
  return (await flags?.enabled("web_dm_spine", personalScope(actor.id))) === true;
}

export function postedWith(queued: NewItem[], result: NewItem): NewItem[] {
  if (result.kind !== "ToolResult") return [];
  const posted = queued.splice(0);
  if (result.body?.interrupted === true) return [];
  return posted.map((post) => ({ ...post, body: { ...post.body, callId: result.callId } }));
}

const PAGE = 50;

async function newestShownReply(
  sessions: Pick<SessionStore, "getItems">,
  sessionId: string,
): Promise<Item | undefined> {
  for (let beforeSeq: number | undefined; ;) {
    const page = await sessions.getItems(sessionId, {
      messagesOnly: true,
      limit: PAGE,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    });
    const found = page.findLast(isShownReply);
    if (found || page.length < PAGE) return found;
    beforeSeq = page[0]!.seq;
  }
}

export function webTranscript(
  spine: Pick<SpineState, "surfaceOutboundCount">,
  transcript: NewItem[],
  sessions: Pick<SessionStore, "getItems">,
  sessionId: string,
) {
  const record = (text: string, extra: { supersedes?: number; files?: PostedFileMeta[] }): SurfacePostResult => {
    transcript.push(
      ...(text.trim()
        ? [
            {
              kind: "AgentMessage" as const,
              text,
              body: extra.supersedes === undefined ? {} : { supersedes: extra.supersedes },
            },
          ]
        : []),
      ...(extra.files
        ? [{ kind: "AgentMessage" as const, variant: "files_delivered" as const, body: { files: extra.files } }]
        : []),
    );
    spine.surfaceOutboundCount += 1;
    return { ok: true, ...(extra.files ? { attachments: extra.files } : {}) };
  };
  return {
    post: (text: string, files?: PostedFileMeta[]): SurfacePostResult =>
      !text.trim() && !files
        ? { ok: false, message: "A post needs text or files; nothing was sent." }
        : record(text, files ? { files } : {}),
    edit: async (ref: string, text: string): Promise<SurfacePostResult> => {
      if (!text.trim()) return { ok: false, message: "An edit needs the new text; nothing was changed." };
      const latest = await newestShownReply(sessions, sessionId);
      if (latest && String(latest.seq) === ref.trim()) return record(text, { supersedes: latest.seq });
      return {
        ok: false,
        message: `ref ${ref} isn't my latest message in this conversation; ${latest ? `my latest message here is ref ${latest.seq}` : "I have posted nothing here to edit"}`,
      };
    },
  };
}

export function spineReplies(opts: {
  runId: string | undefined;
  turnStream: Pick<TurnStream, "publishBlockStart" | "publish">;
  wake: boolean;
  spine: Pick<SpineState, "surfaceOutboundCount">;
  sessionId: string;
}) {
  const publish = (text: string): void => {
    if (!opts.runId) return;
    opts.turnStream.publishBlockStart(opts.runId);
    opts.turnStream.publish(opts.runId, text);
  };
  const closingReply = (text: string): string => {
    const shown = !opts.wake && opts.spine.surfaceOutboundCount === 0 ? text : "";
    if (!shown.trim()) {
      if (text.trim()) console.warn(`[web-spine] dropped text written outside the web tool session=${opts.sessionId}`);
      return "";
    }
    opts.spine.surfaceOutboundCount += 1;
    publish(shown);
    return shown;
  };
  return { publish, closingReply };
}

export function wakeTurnNote(rewritable: Item | undefined, history: readonly Item[]): string {
  const started = "This turn was started by a subagent or another conversation, not by the person typing.";
  const latest = rewritable && rewritable.seq === history.findLast(isShownReply)?.seq ? rewritable : undefined;
  if (!latest)
    return `${started} You have no message here to edit: \`post\` only if this turn brings something they should know, otherwise call \`finish_silently\`.`;
  return `${started} Your latest message here is ref ${latest.seq}, beginning "${snippet(latest.text ?? "", 60)}": \`edit\` it if this turn brings something they should know, otherwise call \`finish_silently\`.`;
}
