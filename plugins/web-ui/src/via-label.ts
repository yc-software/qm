import { html, nothing, type TemplateResult } from "lit";
import { deepLinkPath, UI_BASE } from "./deep-link.ts";

const SOURCES: Record<string, string> = { cron: "Scheduled task", webhook: "Webhook", monitor: "Monitor" };

export function viaSourceText(via: string, title?: string): string {
  return title || SOURCES[via] || via;
}

export function viaLine(post: {
  via?: string;
  viaTitle?: string;
  viaCronId?: string;
}): TemplateResult | typeof nothing {
  if (!post.via) return nothing;
  const label = viaSourceText(post.via, post.viaTitle);
  return html`<div class="via-line">
    <span class="via-arrow" aria-hidden="true">↳</span>${
      post.viaCronId
        ? html`<a href=${deepLinkPath(UI_BASE, "crons", null, null, post.viaCronId)}>${label}</a>`
        : html`<span>${label}</span>`
    }
  </div>`;
}
