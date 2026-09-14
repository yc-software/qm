import { html, type TemplateResult } from "lit";
import type { LedgerThreadMessage } from "./inbox";
import { markdown } from "./message-markdown";

export function inboxChatMessage(message: LedgerThreadMessage): TemplateResult {
  return html`<div class="inbox-chat-msg ${message.role}">
    <span class="sr-only">${{ human: "You", agent: "Assistant", system: "System" }[message.role]}:</span>
    ${
      message.role === "agent"
        ? html`<div class="assistant-body">${markdown(message.text)}</div>`
        : html`<span class="inbox-chat-text" dir="auto">${message.text}</span>`
    }
  </div>`;
}
