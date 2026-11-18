import { html, nothing, type TemplateResult } from "lit";
import { AppWindow, ChevronRight, Download, Maximize2, Minimize2 } from "lucide";
import { animateDetailsToggle } from "./details-motion";
import { previewFile } from "./file-open";
import { icon } from "./icons";
import { tip } from "./tooltip";
import { formatBytes } from "./ui";

const collapsed = new Set<string>();

function setExpanded(card: HTMLElement, expanded: boolean): void {
  const apply = (): void => {
    card.togglePopover(expanded);
    card.querySelector<HTMLElement>(expanded ? ".file-html-shrink" : ".file-html-expand")?.focus();
  };
  if (typeof document.startViewTransition !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    apply();
    return;
  }
  card.style.viewTransitionName = "file-html-card";
  void document.startViewTransition(apply).finished.finally(() => {
    card.style.viewTransitionName = "";
  });
}

function cardOf(event: Event): HTMLElement {
  return (event.currentTarget as HTMLElement).closest<HTMLElement>(".file-html-card")!;
}

function onBarClick(event: MouseEvent): void {
  if ((event.target as Element).closest("a, button")) return;
  if (cardOf(event).matches(":popover-open")) event.preventDefault();
  else animateDetailsToggle(event);
}

function onCardClick(event: MouseEvent): void {
  const card = event.currentTarget as HTMLElement;
  if (event.target === card && card.matches(":popover-open")) setExpanded(card, false);
}

function onCardKeydown(event: KeyboardEvent): void {
  const card = event.currentTarget as HTMLElement;
  if (event.key !== "Escape" || !card.matches(":popover-open")) return;
  event.preventDefault();
  event.stopPropagation();
  setExpanded(card, false);
}

export function htmlPreviewCard(name: string, src: string, size?: number, href?: string): TemplateResult {
  const key = `${href ?? src}:${name}`;
  return html`<div class="file-html-slot">
    <details
      class="file-html-card"
      popover="manual"
      ?open=${!collapsed.has(key)}
      @toggle=${(event: Event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) collapsed.delete(key);
        else collapsed.add(key);
      }}
      @click=${onCardClick}
      @keydown=${onCardKeydown}
    >
      <summary class="file-html-bar" @click=${onBarClick}>
        ${icon(AppWindow, 15)}
        ${href
          ? html`<a
              class="file-html-name"
              dir="auto"
              href=${href}
              target="_blank"
              rel="noreferrer"
              @click=${(event: MouseEvent) => previewFile(event, name, href)}
              >${name}</a
            >`
          : html`<span class="file-html-name" dir="auto">${name}</span>`}
        ${typeof size === "number" ? html`<small>${formatBytes(size)}</small>` : nothing}
        <span class="activity-chevron">${icon(ChevronRight, 14)}</span>
        <span class="file-html-actions">
          ${href
            ? html`<a
                class="icon-btn subtle compact"
                href=${href}
                download=${name}
                aria-label="Download ${name}"
                ${tip("Download")}
                >${icon(Download, 15)}</a
              >`
            : nothing}
          <button
            type="button"
            class="icon-btn subtle compact file-html-expand"
            aria-label="Expand ${name}"
            ${tip("Expand")}
            @click=${(event: Event) => setExpanded(cardOf(event), true)}
          >
            ${icon(Maximize2, 15)}
          </button>
          <button
            type="button"
            class="icon-btn subtle compact file-html-shrink"
            aria-label="Shrink ${name}"
            ${tip("Shrink · Esc")}
            @click=${(event: Event) => setExpanded(cardOf(event), false)}
          >
            ${icon(Minimize2, 15)}
          </button>
        </span>
      </summary>
      <iframe sandbox="allow-scripts" src=${src} title=${name} loading="lazy"></iframe>
    </details>
  </div>`;
}
