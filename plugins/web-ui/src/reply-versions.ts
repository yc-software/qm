import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { html, nothing, type TemplateResult } from "lit";
import { ChevronRight } from "lucide";
import { icon } from "./icons.ts";
import { messageText, type AssistantWork } from "./core-bridge.ts";
import { activityItems, isNarration } from "./items.ts";
import { markdown } from "./message-markdown.ts";
import { formatMessageTime } from "./message-time.ts";
import { workSeconds } from "./work-duration.ts";

interface ReplyVersions {
  earlier: Map<AgentMessage, AssistantWork[]>;
  superseded: Map<AgentMessage, number>;
  absorbed: Set<AgentMessage>;
  folded: Map<AgentMessage, AssistantWork>;
  inlined: Set<number>;
}

function foldable(message: AgentMessage, superseded: Map<AgentMessage, number>): boolean {
  const row = message as AssistantWork & { subagentMail?: unknown; hidden?: boolean; stopReason?: string };
  if (row.role === "assistant")
    return (
      superseded.has(message) ||
      (!messageText(row).trim() &&
        !row.deliveredFiles?.length &&
        row.stopReason !== "error" &&
        row.stopReason !== "aborted")
    );
  return (row.role === "user" || row.role === "user-with-attachments") && Boolean(row.subagentMail || row.hidden);
}

export function replyVersions(messages: readonly AgentMessage[]): ReplyVersions {
  const earlier = new Map<AgentMessage, AssistantWork[]>();
  const superseded = new Map<AgentMessage, number>();
  const absorbed = new Set<AgentMessage>();
  const folded = new Map<AgentMessage, AssistantWork>();
  const inlined = new Set<number>();
  const marked = (message: AgentMessage) =>
    (message as AssistantWork).supersedes !== undefined || !!(message as AssistantWork).alsoSupersedes?.length;
  if (!messages.some(marked)) return { earlier, superseded, absorbed, folded, inlined };
  const narration = new Set(
    messages.flatMap((message) =>
      activityItems((message as AssistantWork).work?.activity ?? []).flatMap((item) =>
        isNarration(item) ? [item.seq] : [],
      ),
    ),
  );
  const replies = new Map<number, AssistantWork>();
  for (const message of messages) {
    const reply = message as AssistantWork & { entrySeqs?: number[] };
    if (reply.role !== "assistant" || !messageText(reply).trim()) continue;
    const targets = [...(reply.alsoSupersedes ?? []), ...(reply.supersedes === undefined ? [] : [reply.supersedes])];
    for (const seq of targets) {
      if (narration.has(seq)) {
        inlined.add(seq);
        continue;
      }
      const previous = replies.get(seq);
      if (!previous || previous === reply || superseded.has(previous)) continue;
      earlier.set(reply, [...(earlier.get(reply) ?? []), ...(earlier.get(previous) ?? []), previous]);
      earlier.delete(previous);
      superseded.set(previous, seq);
    }
    for (const seq of reply.entrySeqs ?? []) replies.set(seq, reply);
  }
  for (const latest of earlier.keys()) {
    const end = messages.indexOf(latest);
    let start = end;
    while (start > 0 && foldable(messages[start - 1]!, superseded)) start--;
    const span = messages.slice(start, end);
    for (const row of span) absorbed.add(row);
    const works = [...span, latest].flatMap((row) => {
      const work = (row as AssistantWork).role === "assistant" ? (row as AssistantWork).work : undefined;
      return work ? [work] : [];
    });
    const last = works.at(-1);
    if (!last) continue;
    const before = works.slice(0, -1).reduce((sum, work) => sum + workSeconds(work), 0) * 1000;
    const started = last.startedAt ?? works[0]!.startedAt;
    folded.set(latest, {
      ...(latest as AssistantWork),
      work: {
        ...last,
        activity: works.flatMap((work) => work.activity),
        reasoning: works.flatMap((work) => work.reasoning ?? []),
        startedAt: started === undefined ? undefined : started - before,
      },
    });
  }
  return { earlier, superseded, absorbed, folded, inlined };
}

export function rowEntrySeqs(versions: ReplyVersions, message: AgentMessage, seqs: number[]): string {
  const folded = (versions.earlier.get(message) ?? []).map((version) => versions.superseded.get(version));
  return [...seqs.filter((seq) => seq !== versions.superseded.get(message)), ...folded].join(" ");
}

function replyVersionsList(earlier: AssistantWork[] | undefined, open: boolean): TemplateResult | typeof nothing {
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

const openVersions = new WeakSet<AgentMessage>();

export function replyVersionsToggle(message: AgentMessage, redraw: () => void): TemplateResult {
  const open = openVersions.has(message);
  return html`<button
    class="reply-versions-toggle"
    type="button"
    aria-expanded=${open ? "true" : "false"}
    @click=${() => {
      if (open) openVersions.delete(message);
      else openVersions.add(message);
      redraw();
    }}
  >
    · edited <span class="activity-chevron">${icon(ChevronRight, 12)}</span>
  </button>`;
}

export function replyVersionsPanel(versions: ReplyVersions, message: AgentMessage): TemplateResult | typeof nothing {
  return replyVersionsList(versions.earlier.get(message), openVersions.has(message));
}
