import { html, nothing, type TemplateResult } from "lit";
import { deepLinkPath, UI_BASE } from "./deep-link.ts";

const SOURCES: Record<string, string> = { cron: "Scheduled task", webhook: "Webhook", monitor: "Monitor" };
const PAGES: Record<string, string> = { cron: "crons", webhook: "webhooks" };

type ViaPost = { via?: string; viaTitle?: string; viaId?: string };

export function viaSourceText(via: string, title?: string): string {
  return title || SOURCES[via] || via;
}

export function viaHref(post: ViaPost): string | null {
  const page = post.via ? PAGES[post.via] : undefined;
  return page && post.viaId ? deepLinkPath(UI_BASE, page, null, null, post.viaId) : null;
}

export function viaLine(post: ViaPost): TemplateResult | typeof nothing {
  if (!post.via) return nothing;
  const label = viaSourceText(post.via, post.viaTitle);
  const href = viaHref(post);
  return html`<div class="via-line">
    <span class="via-arrow" aria-hidden="true">↳</span
    >${href ? html`<a href=${href}>${label}</a>` : html`<span>${label}</span>`}
  </div>`;
}
