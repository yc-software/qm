import { appEditSlug } from "../../plugins/chassis/src/app-edit.ts";
import { isSessionTurn } from "../core/turn-origin.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { isShownReply, type Item, type NewItem } from "../sessions/items.ts";
import { isSubagentThreadRef } from "../sessions/session-syscalls.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { personalScope, type Session } from "../types.ts";
import { snippet } from "../util/text.ts";

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
    !input.approval &&
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

export async function latestVersion(
  sessions: Pick<SessionStore, "getItems">,
  sessionId: string,
  ref: string,
): Promise<Item | undefined> {
  const seq = Number(ref);
  if (!ref.trim() || !Number.isSafeInteger(seq) || seq < 0) return undefined;
  const since = (await sessions.getItems(sessionId, { sinceSeq: seq, messagesOnly: true })).filter(isShownReply);
  let latest = since.find((item) => item.seq === seq);
  for (let newer = latest; newer; newer = since.find((item) => item.body.supersedes === latest!.seq)) latest = newer;
  return latest;
}

export function wakeTurnNote(latest: Item | undefined): string {
  const started = "This turn was started by a subagent or another conversation, not by the person typing.";
  if (!latest)
    return `${started} You have no message here to edit: \`post\` only if this turn brings something they should know, otherwise call \`finish_silently\`.`;
  return `${started} Your latest message here is ref ${latest.seq}, beginning "${snippet(latest.text ?? "", 60)}": \`edit\` it if this turn brings something they should know, otherwise call \`finish_silently\`.`;
}

export const unshownTextNudge = (surfaceTool: string): string =>
  `[system] Your text above was not shown to the person: here only the \`${surfaceTool}\` tool reaches them. \`edit\` your latest message so it reads right now, \`post\` only if you are answering something they newly typed, or call finish_silently.`;
