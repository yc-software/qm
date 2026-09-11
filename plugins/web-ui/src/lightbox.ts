import { html, nothing, render, type TemplateResult } from "lit";
import { ChevronLeft, ChevronRight, Download, X } from "lucide";
import { restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { icon } from "./ui";

export interface LightboxImage {
  src: string;
  name: string;
  href?: string;
}

let images: LightboxImage[] = [];
let index = 0;
let opener: HTMLElement | null = null;
let host: HTMLDivElement | null = null;

export function openLightbox(gallery: LightboxImage[], start: number, from: HTMLElement | null = null): void {
  if (!gallery.length) return;
  images = gallery;
  index = Math.min(Math.max(start, 0), gallery.length - 1);
  opener = from;
  draw();
  const dialog = host?.querySelector<HTMLDialogElement>(".lightbox");
  if (dialog && !dialog.open) dialog.showModal();
  host?.querySelector<HTMLElement>(".lightbox-close")?.focus();
}

function closeLightbox(): void {
  if (!images.length) return;
  images = [];
  draw();
  restoreDialogFocus(opener, () => null);
  opener = null;
}

function step(delta: number): void {
  index = (index + delta + images.length) % images.length;
  draw();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return trapDialogFocus(e, closeLightbox);
  e.preventDefault();
  if (images.length > 1) step(e.key === "ArrowLeft" ? -1 : 1);
}

function draw(): void {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
  }
  render(images.length ? lightboxTpl() : nothing, host);
}

function navButton(delta: number): TemplateResult {
  const label = delta < 0 ? "Previous image" : "Next image";
  return html`<button
    class="lightbox-btn lightbox-nav ${delta < 0 ? "prev" : "next"}"
    type="button"
    title=${label}
    aria-label=${label}
    @click=${() => step(delta)}
  >
    ${icon(delta < 0 ? ChevronLeft : ChevronRight, 22)}
  </button>`;
}

function lightboxTpl(): TemplateResult {
  const current = images[index]!;
  return html`
    <dialog
      class="lightbox"
      aria-label="Image viewer"
      @close=${closeLightbox}
      @keydown=${onKeydown}
      @click=${(e: MouseEvent) => e.target === e.currentTarget && closeLightbox()}
    >
      <img src=${current.src} alt=${current.name} />
      <div class="lightbox-actions">
        <a
          class="lightbox-btn"
          href=${current.href ?? current.src}
          download=${current.name}
          title="Download"
          aria-label="Download"
        >
          ${icon(Download, 18)}
        </a>
        <button
          class="lightbox-btn lightbox-close"
          type="button"
          title="Close"
          aria-label="Close"
          @click=${closeLightbox}
        >
          ${icon(X, 20)}
        </button>
      </div>
      ${images.length > 1 ? html`${navButton(-1)}${navButton(1)}` : nothing}
    </dialog>
  `;
}
