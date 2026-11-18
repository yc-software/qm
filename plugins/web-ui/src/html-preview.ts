import { html, nothing, type TemplateResult } from "lit";
import { ChevronRight, Download, Maximize2, X } from "lucide";
import { animateDetailsToggle } from "./details-motion";
import { previewFile } from "./file-open";
import { icon } from "./icons";
import { tip } from "./tooltip";
import { formatBytes } from "./ui";

const collapsed = new Set<string>();

function setExpanded(layer: HTMLElement, expanded: boolean): void {
  const apply = (): void => {
    layer.togglePopover(expanded);
    layer.focus();
  };
  if (typeof document.startViewTransition !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    apply();
    return;
  }
  const direction = expanded ? "file-html-expanding" : "file-html-shrinking";
  layer.classList.add("morphing");
  document.documentElement.classList.add(direction);
  void document.startViewTransition(apply).finished.finally(() => {
    layer.classList.remove("morphing");
    document.documentElement.classList.remove(direction);
  });
}

function layerOf(event: Event): HTMLElement {
  return (event.currentTarget as HTMLElement).closest<HTMLElement>(".file-html-layer")!;
}

function onBarClick(event: MouseEvent): void {
  if ((event.target as Element).closest("a, button")) return;
  if (layerOf(event).matches(":popover-open")) event.preventDefault();
  else animateDetailsToggle(event);
}

function onScrimClick(event: MouseEvent): void {
  if (event.target === event.currentTarget) setExpanded(layerOf(event), false);
}

function onLayerKeydown(event: KeyboardEvent): void {
  const layer = layerOf(event);
  if (event.key !== "Escape" || !layer.matches(":popover-open")) return;
  event.preventDefault();
  event.stopPropagation();
  setExpanded(layer, false);
}

export function htmlPreviewCard(name: string, src: string, size?: number, href?: string): TemplateResult {
  const key = `${href ?? src}:${name}`;
  return html`<div class="file-html-slot">
    <div class="file-html-layer" popover="manual" tabindex="-1" @click=${onScrimClick} @keydown=${onLayerKeydown}>
      <details
        class="file-html-card"
        ?open=${!collapsed.has(key)}
        @toggle=${(event: Event) => {
          if ((event.currentTarget as HTMLDetailsElement).open) collapsed.delete(key);
          else collapsed.add(key);
        }}
      >
        <summary class="file-html-bar" @click=${onBarClick}>
          <span class="activity-chevron">${icon(ChevronRight, 14)}</span>
          <span class="file-html-title">
            ${
              href
                ? html`<a
                    class="file-html-name"
                    dir="auto"
                    href=${href}
                    target="_blank"
                    rel="noreferrer"
                    @click=${(event: MouseEvent) => previewFile(event, name, href)}
                    >${name}</a
                  >`
                : html`<span class="file-html-name" dir="auto">${name}</span>`
            }
            ${typeof size === "number" ? html`<small>${formatBytes(size)}</small>` : nothing}
          </span>
          <span class="file-html-actions">
            ${
              href
                ? html`<a
                    class="icon-btn subtle compact"
                    href=${href}
                    download=${name}
                    aria-label="Download ${name}"
                    ${tip("Download")}
                    >${icon(Download, 15)}</a
                  >`
                : nothing
            }
            <button
              type="button"
              class="icon-btn subtle compact file-html-expand"
              aria-label="Expand ${name}"
              ${tip("Expand")}
              @click=${(event: Event) => setExpanded(layerOf(event), true)}
            >
              ${icon(Maximize2, 15)}
            </button>
            <button
              type="button"
              class="icon-btn subtle compact file-html-close"
              aria-label="Close expanded ${name}"
              ${tip("Close · Esc")}
              @click=${(event: Event) => setExpanded(layerOf(event), false)}
            >
              ${icon(X, 16)}
            </button>
          </span>
        </summary>
        <iframe sandbox="allow-scripts" src=${src} title=${name} loading="lazy"></iframe>
      </details>
    </div>
  </div>`;
}
