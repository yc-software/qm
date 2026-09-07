import { html, nothing, render, type TemplateResult } from "lit";
import { ChevronLeft, ChevronRight, Download, ExternalLink, X, ZoomIn, ZoomOut } from "lucide";
import { restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { formatBytes, icon } from "./ui";

export interface LightboxImage {
  src: string;
  name: string;
  size?: number;
  href?: string;
}

const lightboxState = {
  images: [] as LightboxImage[],
  index: 0,
  zoomed: false,
  zoomable: false,
};

const SWIPE_MIN_PX = 40;

let host: HTMLDivElement | null = null;
let opener: HTMLElement | null = null;
let swipeStartX: number | null = null;

export function openLightbox(images: LightboxImage[], index: number, from: HTMLElement | null = null): void {
  if (!images.length) return;
  lightboxState.images = images;
  lightboxState.index = Math.min(Math.max(index, 0), images.length - 1);
  lightboxState.zoomed = false;
  lightboxState.zoomable = false;
  opener = from;
  draw();
  const dialog = host?.querySelector<HTMLDialogElement>(".lightbox");
  if (dialog && !dialog.open) dialog.showModal();
  requestAnimationFrame(() => host?.querySelector<HTMLElement>(".lightbox-close")?.focus());
}

function closeLightbox(): void {
  if (!lightboxState.images.length) return;
  lightboxState.images = [];
  lightboxState.zoomed = false;
  lightboxState.zoomable = false;
  draw();
  restoreDialogFocus(opener, () => null);
  opener = null;
}

function showLightboxImage(index: number): void {
  const count = lightboxState.images.length;
  if (!count) return;
  lightboxState.index = ((index % count) + count) % count;
  lightboxState.zoomed = false;
  lightboxState.zoomable = false;
  draw();
  host?.querySelector<HTMLElement>(".lightbox-thumb.current")?.scrollIntoView({ block: "nearest", inline: "center" });
}

function stepLightbox(delta: number): void {
  if (lightboxState.images.length > 1) showLightboxImage(lightboxState.index + delta);
}

function onLightboxKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" || e.key === "Tab") {
    trapDialogFocus(e, closeLightbox);
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    stepLightbox(e.key === "ArrowLeft" ? -1 : 1);
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    showLightboxImage(e.key === "Home" ? 0 : lightboxState.images.length - 1);
  }
}

function onLightboxSwipe(e: TouchEvent): void {
  const x = e.changedTouches[0]?.clientX;
  if (x === undefined || lightboxState.zoomed) return;
  if (e.type === "touchstart") {
    swipeStartX = x;
    return;
  }
  if (swipeStartX === null) return;
  const dx = x - swipeStartX;
  swipeStartX = null;
  if (Math.abs(dx) >= SWIPE_MIN_PX) stepLightbox(dx < 0 ? 1 : -1);
}

function overflowsStage(img: HTMLImageElement): boolean {
  return img.naturalWidth > img.clientWidth || img.naturalHeight > img.clientHeight;
}

function toggleZoom(e?: MouseEvent): void {
  const img = host?.querySelector<HTMLImageElement>(".lightbox-image");
  if (!img || (!lightboxState.zoomed && !overflowsStage(img))) return;
  const focusX = e && e.currentTarget === img ? e.offsetX / img.clientWidth : 0.5;
  const focusY = e && e.currentTarget === img ? e.offsetY / img.clientHeight : 0.5;
  lightboxState.zoomed = !lightboxState.zoomed;
  draw();
  const stage = host?.querySelector<HTMLElement>(".lightbox-stage");
  if (!stage || !lightboxState.zoomed) return;
  stage.scrollLeft = focusX * stage.scrollWidth - stage.clientWidth / 2;
  stage.scrollTop = focusY * stage.scrollHeight - stage.clientHeight / 2;
}

function onImageLoad(e: Event): void {
  const zoomable = overflowsStage(e.currentTarget as HTMLImageElement);
  if (zoomable === lightboxState.zoomable) return;
  lightboxState.zoomable = zoomable;
  draw();
}

function preloadNeighbours(): void {
  const { images, index } = lightboxState;
  if (images.length < 2) return;
  for (const offset of [1, -1]) {
    const neighbour = images[(index + offset + images.length) % images.length];
    if (neighbour) new Image().src = neighbour.src;
  }
}

function ensureHost(): HTMLDivElement {
  if (!host) {
    host = document.createElement("div");
    host.className = "lightbox-host";
    document.body.appendChild(host);
  }
  return host;
}

function draw(): void {
  render(lightboxState.images.length ? lightboxTpl() : nothing, ensureHost());
  preloadNeighbours();
}

function lightboxTpl(): TemplateResult {
  const { images, index, zoomed, zoomable } = lightboxState;
  const current = images[index]!;
  const many = images.length > 1;
  const zoomClass = zoomed ? "zoomed" : "";
  const cursorClass = zoomable ? "zoomable" : "";
  return html`
    <dialog
      class="lightbox ${zoomClass} ${cursorClass}"
      aria-label="Image viewer"
      @close=${closeLightbox}
      @keydown=${onLightboxKeydown}
    >
      <header class="lightbox-bar">
        <div class="lightbox-title">
          <span class="lightbox-name" title=${current.name}>${current.name}</span>
          ${typeof current.size === "number" ? html`<small>${formatBytes(current.size)}</small>` : nothing}
        </div>
        ${many ? html`<div class="lightbox-count">${index + 1} / ${images.length}</div>` : nothing}
        <div class="lightbox-status" role="status">Image ${index + 1} of ${images.length}: ${current.name}</div>
        <div class="lightbox-actions">
          <button
            class="lightbox-btn lightbox-zoom"
            type="button"
            title=${zoomed ? "Actual size off" : "Actual size"}
            aria-label=${zoomed ? "Fit to screen" : "Show actual size"}
            aria-pressed=${zoomed ? "true" : "false"}
            ?disabled=${!zoomable && !zoomed}
            @click=${() => toggleZoom()}
          >
            ${icon(zoomed ? ZoomOut : ZoomIn, 18)}
          </button>
          <a
            class="lightbox-btn"
            href=${current.href ?? current.src}
            download=${current.name}
            title="Download"
            aria-label="Download"
          >
            ${icon(Download, 18)}
          </a>
          ${
            current.href
              ? html`<a
                  class="lightbox-btn"
                  href=${current.href}
                  target="_blank"
                  rel="noreferrer"
                  title="Open original"
                  aria-label="Open original"
                >
                  ${icon(ExternalLink, 18)}
                </a>`
              : nothing
          }
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
      </header>
      <div
        class="lightbox-stage"
        @click=${(e: MouseEvent) => e.target === e.currentTarget && closeLightbox()}
        @touchstart=${onLightboxSwipe}
        @touchend=${onLightboxSwipe}
      >
        <img
          class="lightbox-image"
          src=${current.src}
          alt=${current.name}
          @click=${(e: MouseEvent) => toggleZoom(e)}
          @load=${onImageLoad}
        />
      </div>
      ${
        many
          ? html`
              <button
                class="lightbox-nav prev"
                type="button"
                title="Previous"
                aria-label="Previous image"
                @click=${() => stepLightbox(-1)}
              >
                ${icon(ChevronLeft, 28)}
              </button>
              <button
                class="lightbox-nav next"
                type="button"
                title="Next"
                aria-label="Next image"
                @click=${() => stepLightbox(1)}
              >
                ${icon(ChevronRight, 28)}
              </button>
              <nav class="lightbox-strip" aria-label="All images">
                ${images.map(
                  (image, i) => html`
                    <button
                      class="lightbox-thumb ${i === index ? "current" : ""}"
                      type="button"
                      title=${image.name}
                      aria-label=${`Image ${i + 1} of ${images.length}: ${image.name}`}
                      aria-current=${i === index ? "true" : "false"}
                      @click=${() => showLightboxImage(i)}
                    >
                      <img src=${image.src} alt="" loading="lazy" />
                    </button>
                  `,
                )}
              </nav>
            `
          : nothing
      }
    </dialog>
  `;
}
