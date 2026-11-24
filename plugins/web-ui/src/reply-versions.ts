import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { html, type TemplateResult } from "lit";
import { ChevronRight, History } from "lucide";
import { messageText, type AssistantWork } from "./core-bridge.ts";
import { animateDetailsToggle } from "./details-motion.ts";
import { icon } from "./icons.ts";
import { markdown } from "./message-markdown.ts";
import { formatMessageTime } from "./message-time.ts";

interface ReplyVersions {
  earlier: Map<AgentMessage, AssistantWork[]>;
  superseded: Set<AgentMessage>;
}

export function replyVersions(messages: readonly AgentMessage[]): ReplyVersions {
  const earlier = new Map<AgentMessage, AssistantWork[]>();
  const superseded = new Set<AgentMessage>();
  if (!messages.some((message) => (message as AssistantWork).supersedes !== undefined)) return { earlier, superseded };
  const replies = new Map<number, AssistantWork>();
  for (const message of messages) {
    const reply = message as AssistantWork & { entrySeqs?: number[] };
    if (reply.role !== "assistant" || !messageText(reply).trim()) continue;
    const previous = reply.supersedes === undefined ? undefined : replies.get(reply.supersedes);
    if (previous) {
      earlier.set(reply, [...(earlier.get(previous) ?? []), previous]);
      earlier.delete(previous);
      superseded.add(previous);
    }
    for (const seq of reply.entrySeqs ?? []) replies.set(seq, reply);
  }
  return { earlier, superseded };
}

export function replyVersionsRow(latest: AssistantWork, earlier: AssistantWork[]): TemplateResult {
  const count = `${earlier.length} earlier version${earlier.length === 1 ? "" : "s"}`;
  return html`<details class="thinking-row reply-versions">
    <summary class="thinking-summary" @click=${animateDetailsToggle}>
      <span class="tool-icon">${icon(History, 15)}</span>
      <span class="thinking-title">Updated ${formatMessageTime(latest.timestamp)} · ${count}</span>
      <span class="activity-chevron">${icon(ChevronRight, 14)}</span>
    </summary>
    ${earlier.map(
      (version) =>
        html`<div class="thinking-body" dir="auto">
          <div class="reply-version-time">${formatMessageTime(version.timestamp)}</div>
          ${markdown(messageText(version))}
        </div>`,
    )}
  </details>`;
}
