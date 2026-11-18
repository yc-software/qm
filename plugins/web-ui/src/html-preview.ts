import { html, nothing, type TemplateResult } from "lit";
import { ChevronRight, Download, Maximize2, X } from "lucide";
import "./html-preview.css";
import { animateDetailsToggle } from "./details-motion";
import { trapDialogFocus } from "./dialog-focus";
import { icon } from "./icons";
import { fileLabel } from "./ui";

const collapsed = new Set<string>();

function setExpanded(layer: HTMLElement, expanded: boolean): void {
  const slot = layer.parentElement!;
  const apply = (): void => {
    if (expanded) layer.querySelector("details")!.open = true;
    slot.style.height = expanded ? `${slot.offsetHeight}px` : "";
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
  if (layer.matches(":popover-open")) trapDialogFocus(event, () => setExpanded(layer, false));
}

function onToggleClick(event: Event): void {
  const layer = layerOf(event);
  setExpanded(layer, !layer.matches(":popover-open"));
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
          <span class="file-html-title">${fileLabel(name, size)}</span>
          <span class="file-html-actions">
            ${href ? html`<a href=${href} download=${name}>${icon(Download, 14)} Download</a>` : nothing}
            <button type="button" @click=${onToggleClick}>
              <span class="file-html-expand">${icon(Maximize2, 14)} Expand</span>
              <span class="file-html-close">${icon(X, 14)} Close</span>
            </button>
          </span>
        </summary>
        <iframe sandbox="allow-scripts" src=${src} title=${name} loading="lazy" tabindex="0"></iframe>
      </details>
    </div>
  </div>`;
}
