import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, X } from "lucide";
import { tip } from "./tooltip";
import { icon } from "./ui";

interface InboxChatHeaderOptions {
  title: string;
  className?: string;
  actions?: TemplateResult;
  back?: () => void;
  backLabel?: string;
  close?: () => void;
}

export function inboxChatHeader({
  title,
  className = "",
  actions,
  back,
  backLabel = "Back to conversation",
  close,
}: InboxChatHeaderOptions): TemplateResult {
  return html`<header class=${`inbox-chat-header ${className}`}>
    ${back ? html`<button class="icon-btn inbox-history-back" type="button" aria-label=${backLabel} ${tip(backLabel)} @click=${back}>${icon(ArrowLeft, 16)}</button>` : nothing}
    <span class="inbox-chat-header-title" dir="auto" title=${title}>${title}</span>
    <div class="inbox-chat-header-actions">
      ${actions ?? nothing}
      ${close ? html`<button class="icon-btn" type="button" aria-label="Back to current conversation" ${tip("Back to current conversation")} @click=${close}>${icon(X, 16)}</button>` : nothing}
    </div>
  </header>`;
}
