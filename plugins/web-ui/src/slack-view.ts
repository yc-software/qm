import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { messageText, SILENCE_TOOLS, type AssistantWork } from "./core-bridge.ts";
import { activityItems } from "./items.ts";
import { REACTION_PREFIX, splitOnce } from "./slack-text.ts";

export function hiddenMessage(message: AgentMessage): boolean {
  const { opener, resumeAnchor } = message as { opener?: boolean; resumeAnchor?: boolean };
  return Boolean(opener || resumeAnchor);
}

export function continuedSpeakers(agents: boolean, rows: readonly AgentMessage[]): Set<AgentMessage> {
  const continued = new Set<AgentMessage>();
  let previous: string | undefined;
  for (const message of rows) {
    const { role, speaker, speakerId, personaId } = message as {
      role?: string;
      speaker?: string;
      speakerId?: string;
      personaId?: string;
    };
    let key: string | undefined;
    if (role === "user" || role === "user-with-attachments") key = speakerId || speaker;
    else if (agents && role === "assistant") key = `assistant:${personaId ?? ""}`;
    if (key && key === previous) continued.add(message);
    previous = key;
  }
  return continued;
}

type WorkRow = AssistantWork & { entrySeqs?: number[]; work: NonNullable<AssistantWork["work"]> };

function workOnlyRow(message: AgentMessage): message is WorkRow {
  const row = message as AssistantWork;
  return (
    row.role === "assistant" &&
    row.persisted === true &&
    Boolean(row.work) &&
    !row.deliveredFiles?.length &&
    !messageText(message).trim()
  );
}

const foldedRows = new WeakMap<WorkRow, { into: AssistantWork; merged: AssistantWork }>();

function foldInto(into: AssistantWork & { entrySeqs?: number[] }, row: WorkRow): AssistantWork {
  const hit = foldedRows.get(row);
  if (hit?.into === into) return hit.merged;
  const work = into.work;
  const merged = {
    ...into,
    entrySeqs: [...(into.entrySeqs ?? []), ...(row.entrySeqs ?? [])],
    work: work
      ? {
          ...work,
          startedAt: work.startedAt ?? row.work.startedAt,
          finishedAt: row.work.finishedAt ?? work.finishedAt,
          activity: [...work.activity, ...row.work.activity],
        }
      : row.work,
  };
  foldedRows.set(row, { into, merged });
  return merged;
}

export function slackRows(messages: readonly AgentMessage[]): AgentMessage[] {
  const rows: AgentMessage[] = [];
  for (const message of messages) {
    const previous = rows.at(-1) as AssistantWork | undefined;
    if (!workOnlyRow(message)) rows.push(message);
    else if (previous?.role === "assistant" && previous.persisted && previous.runId && previous.runId === message.runId)
      rows[rows.length - 1] = foldInto(previous, message) as AgentMessage;
    else if (!activityItems(message.work.activity).some((item) => SILENCE_TOOLS.has(item.tool ?? "")))
      rows.push(message);
  }
  return rows;
}

export function fromSomeoneElse(message: AgentMessage, viewer: string | undefined): boolean {
  const { speakerId, overheard } = message as { speakerId?: string; overheard?: boolean };
  return speakerId ? Boolean(viewer) && speakerId !== viewer : Boolean(overheard);
}

interface SlackReaction {
  who: string;
  emoji: string;
  added: boolean;
  onAgent: boolean;
  author: string | undefined;
  quote: string;
}

function parseSlackReaction(text: string): SlackReaction | null {
  if (!text.startsWith(REACTION_PREFIX)) return null;
  const rest = text.slice(REACTION_PREFIX.length);
  const added = rest.includes(" reacted with :");
  const [who, tail] = splitOnce(rest, added ? " reacted with :" : " removed their :");
  const [emoji, after] = splitOnce(tail ?? "", ":");
  if (!who || !emoji || after === undefined) return null;
  const joint = added ? " on " : " reaction from ";
  const target = after.slice(after.indexOf(joint) + joint.length);
  const [whose, quoted] = splitOnce(target, ' message: "');
  const owner = quoted === undefined ? splitOnce(target, " message")[0] : whose;
  const close = quoted?.lastIndexOf('"') ?? -1;
  const quote = quoted === undefined ? "" : quoted.slice(0, close < 0 ? undefined : close);
  return {
    who,
    emoji,
    added,
    onAgent: owner === "your",
    author: owner.endsWith("'s") ? owner.slice(0, -2) : undefined,
    quote: quote.endsWith("…") ? quote.slice(0, -1) : quote,
  };
}

export function collectReactions(
  messages: readonly AgentMessage[],
  textOf: (message: AgentMessage) => string,
): { onMessage: Map<AgentMessage, Map<string, string[]>>; reactionRows: Set<AgentMessage> } {
  const onMessage = new Map<AgentMessage, Map<string, string[]>>();
  const reactionRows = new Set<AgentMessage>();
  messages.forEach((message, index) => {
    const role = (message as { role?: string }).role;
    const reaction = role === "user" ? parseSlackReaction(textOf(message)) : null;
    if (!reaction) return;
    const earlier = messages.slice(0, index).reverse();
    const byOwner = earlier.filter((m) =>
      reaction.onAgent
        ? (m as { role?: string }).role === "assistant"
        : !reactionRows.has(m) && (m as { speaker?: string }).speaker === reaction.author,
    );
    const quote = reaction.quote.trim();
    const target = (quote && byOwner.find((m) => textOf(m).trim().startsWith(quote))) || byOwner[0];
    if (!target) return;
    reactionRows.add(message);
    const tally = onMessage.get(target) ?? new Map<string, string[]>();
    const people = (tally.get(reaction.emoji) ?? []).filter((name) => name !== reaction.who);
    if (reaction.added) people.push(reaction.who);
    if (people.length) tally.set(reaction.emoji, people);
    else tally.delete(reaction.emoji);
    onMessage.set(target, tally);
  });
  return { onMessage, reactionRows };
}
