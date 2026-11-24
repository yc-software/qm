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

export interface TranscriptPosts {
  open(callId: string): void;
  queue(items: NewItem[]): void;
  take(callId: string): NewItem[];
}

export function createTranscriptPosts(): TranscriptPosts {
  const calls = new Map<string, NewItem[] | undefined>();
  let unclaimed: NewItem[] = [];
  return {
    open(callId) {
      calls.set(callId, undefined);
    },
    queue(items) {
      const waiting = [...calls].find(([, queued]) => !queued)?.[0];
      if (waiting) calls.set(waiting, items);
      else unclaimed.push(...items);
    },
    take(callId) {
      const items = [...(calls.get(callId) ?? []), ...unclaimed];
      calls.delete(callId);
      unclaimed = [];
      return items;
    },
  };
}

export function postedWith(transcript: TranscriptPosts, item: NewItem, surfaceTool: string): NewItem[] {
  const action = item.body?.action;
  if (item.kind === "ToolCall" && item.tool === surfaceTool && (action === "post" || action === "edit"))
    transcript.open(item.callId);
  if (item.kind !== "ToolResult") return [];
  const posted = transcript.take(item.callId);
  if (item.body?.interrupted === true) return [];
  return posted.map((post) => ({ ...post, body: { ...post.body, callId: item.callId } }));
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
  `[system] Your text above was not shown to the person: here only the \`${surfaceTool}\` tool reaches them. \`edit\` your latest message if it should now read differently, or call finish_silently.`;
