import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { html, nothing, type TemplateResult } from "lit";
import { messageText, type AssistantWork } from "./core-bridge.ts";
import { markdown } from "./message-markdown.ts";
import { formatMessageTime } from "./message-time.ts";
import { workSeconds } from "./work-duration.ts";

interface ReplyVersions {
  earlier: Map<AgentMessage, AssistantWork[]>;
  superseded: Map<AgentMessage, number>;
  /** Rows folded into a later rewritten reply; they render nothing of their own. */
  absorbed: Set<AgentMessage>;
  /** The rewritten reply, carrying the work of every row it absorbed. */
  folded: Map<AgentMessage, AssistantWork>;
}

function fromPerson(message: AgentMessage): boolean {
  const row = message as { role?: string; subagentMail?: unknown; hidden?: boolean; opener?: boolean };
  return (
    (row.role === "user" || row.role === "user-with-attachments") &&
    !row.subagentMail &&
    !row.hidden &&
    !row.opener
  );
}

export function replyVersions(messages: readonly AgentMessage[]): ReplyVersions {
  const earlier = new Map<AgentMessage, AssistantWork[]>();
  const superseded = new Map<AgentMessage, number>();
  const absorbed = new Set<AgentMessage>();
  const folded = new Map<AgentMessage, AssistantWork>();
  if (!messages.some((message) => (message as AssistantWork).supersedes !== undefined))
    return { earlier, superseded, absorbed, folded };
  const replies = new Map<number, AssistantWork>();
  for (const message of messages) {
    const reply = message as AssistantWork & { entrySeqs?: number[] };
    if (reply.role !== "assistant" || !messageText(reply).trim()) continue;
    const previous = reply.supersedes === undefined ? undefined : replies.get(reply.supersedes);
    if (previous) {
      earlier.set(reply, [...(earlier.get(previous) ?? []), previous]);
      earlier.delete(previous);
      superseded.set(previous, reply.supersedes!);
    }
    for (const seq of reply.entrySeqs ?? []) replies.set(seq, reply);
  }
  for (const latest of earlier.keys()) {
    const end = messages.indexOf(latest);
    let start = end;
    while (start > 0 && !fromPerson(messages[start - 1]!)) start--;
    const turns = messages.slice(start, end);
    for (const turn of turns) absorbed.add(turn);
    const works = [...turns, latest].flatMap((turn) => {
      const work = (turn as AssistantWork).role === "assistant" ? (turn as AssistantWork).work : undefined;
      return work ? [work] : [];
    });
    const last = (latest as AssistantWork).work ?? works.at(-1);
    if (!last || works.length < 2) continue;
    const before = works.slice(0, -1).reduce((sum, work) => sum + workSeconds(work), 0) * 1000;
    const start0 = last.startedAt ?? works[0]!.startedAt;
    folded.set(latest, {
      ...(latest as AssistantWork),
      work: {
        ...last,
        activity: works.flatMap((work) => work.activity),
        reasoning: works.flatMap((work) => work.reasoning ?? []),
        startedAt: start0 === undefined ? undefined : start0 - before,
      },
    });
  }
  return { earlier, superseded, absorbed, folded };
}

export function rowEntrySeqs(versions: ReplyVersions, message: AgentMessage, seqs: number[]): string {
  const folded = (versions.earlier.get(message) ?? []).map((version) => versions.superseded.get(version));
  return [...seqs.filter((seq) => seq !== versions.superseded.get(message)), ...folded].join(" ");
}

/** Footer label beside the time, e.g. "edited · 2 earlier versions". */
export function replyVersionsLabel(earlier: AssistantWork[]): string {
  return `edited · ${earlier.length} earlier version${earlier.length === 1 ? "" : "s"}`;
}

export function replyVersionsList(earlier: AssistantWork[] | undefined, open: boolean): TemplateResult | typeof nothing {
  if (!earlier || !open) return nothing;
  return html`<div class="reply-versions-list">
    ${earlier.map(
      (version) =>
        html`<div class="thinking-body" dir="auto">
          <div class="reply-version-time">${formatMessageTime(version.timestamp)}</div>
          ${markdown(messageText(version))}
        </div>`,
    )}
  </div>`;
}
