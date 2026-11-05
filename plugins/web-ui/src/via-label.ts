import { html, nothing, type TemplateResult } from "lit";
import type { AssistantWork } from "./core-bridge.ts";
import { formatMessageTime } from "./message-time.ts";

const SOURCES: Record<string, string> = { cron: "Scheduled task", webhook: "Webhook", monitor: "Monitor" };

export function viaLabel(msg: AssistantWork): TemplateResult | typeof nothing {
  if (!msg.via) return nothing;
  const source = SOURCES[msg.via] ?? msg.via;
  return html`<div class="speaker-label via-label">
    ${source}${msg.timestamp ? ` · ${formatMessageTime(msg.timestamp)}` : ""}
  </div>`;
}
