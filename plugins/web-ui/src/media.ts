import { html, nothing, render, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import { ChevronLeft, ChevronRight, Download, ExternalLink, Maximize2, Pause, Play, Volume2, VolumeX, X } from "lucide";
import "./media.css";
import { icon } from "./icons";
import { formatBytes } from "./ui";
import { formatDuration, justifyRows, layoutRatio, MEDIA_GAP, type MediaItem } from "./media-layout";

export { mediaKind, type MediaItem } from "./media-layout";

const MAX_TILES = 6;
const MAX_HEIGHT = 460;
const FEED_WIDTH = 700;
const EAGER_BYTES = 32 * 1024 * 1024;
const SPEEDS = [1, 1.5, 2, 0.5];
const EASE = "cubic-bezier(0.2, 0, 0, 1)";

const ratios = new Map<string, number>();
const naturalWidths = new Map<string, number>();
let speed = 1;
let nowPlaying: MediaPlayer | null = null;

const Base = (typeof HTMLElement === "undefined" ? class {} : HTMLElement) as typeof HTMLElement;

export function frameSrc(src: string): string {
  return src.startsWith("data:") ? src : `${src}#t=0.001`;
}

function learn(src: string, width: number, height: number): boolean {
  if (!width || !height) return false;
  naturalWidths.set(src, width);
  const known = ratios.get(src);
  ratios.set(src, width / height);
  return !known || Math.abs(known - width / height) > 0.01;
}

function fallbackRatio(item: MediaItem): number {
  return item.kind === "video" ? 16 / 9 : 1.6;
}

function inView(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const scroller = element.closest(".chat-scroll")?.getBoundingClientRect();
  const dock = element.closest(".chat-scroll")?.parentElement?.querySelector(".chat-bottom-dock");
  const bottom = Math.min(scroller?.bottom ?? innerHeight, dock?.getBoundingClientRect().top ?? innerHeight);
  return rect.top >= (scroller?.top ?? 0) && rect.bottom <= bottom;
}

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

class MediaPlayer extends Base {
  item!: MediaItem;
  mode: "inline" | "viewer" = "inline";
  startAt = 0;
  autoplay = false;
  private media: HTMLMediaElement | null = null;
  private frame = 0;
  private quietTimer = 0;
  private scrubbing = false;
  private clock = "";

  connectedCallback(): void {
    if (this.media) return;
    const video = this.item.kind === "video";
    this.classList.add("mp", video ? "mp-video" : "mp-audio");
    this.dataset.state = "idle";
    render(video ? this.videoTemplate() : this.audioTemplate(), this);
    this.media = this.querySelector<HTMLMediaElement>("video, audio")!;
    this.media.playbackRate = speed;
    this.addEventListener("pointermove", this.wake);
    if (this.autoplay) this.toggle();
  }

  disconnectedCallback(): void {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.quietTimer);
    this.media?.pause();
    if (nowPlaying === this) nowPlaying = null;
  }

  get time(): number {
    return this.media?.currentTime ?? 0;
  }

  seek(time: number): void {
    if (this.media && Number.isFinite(time)) this.media.currentTime = time;
    this.paint();
  }

  pause(): void {
    this.media?.pause();
  }

  toggle = (): void => {
    const media = this.media;
    if (!media) return;
    if (media.paused) void media.play().catch(() => undefined);
    else media.pause();
  };

  private videoTemplate(): TemplateResult {
    const { name, src, size, download } = this.item;
    const eager = this.autoplay || (typeof size === "number" && size <= EAGER_BYTES);
    return html`<video
        src=${frameSrc(src)}
        preload=${eager ? "auto" : "metadata"}
        playsinline
        @loadedmetadata=${this.onMetadata}
        @play=${this.onPlay}
        @pause=${this.onPause}
        @error=${this.onError}
        @timeupdate=${this.paint}
        @volumechange=${this.onVolume}
      ></video>
      <button
        type="button"
        class="mp-surface"
        aria-label="Play ${name}"
        @click=${this.toggle}
        @dblclick=${this.expand}
      ></button>
      <span class="mp-glyph" aria-hidden="true">${icon(Play, 22)}</span>
      <span class="mp-length" aria-hidden="true"></span>
      <div class="mp-bar">
        <button type="button" class="mp-btn mp-toggle" aria-label="Play ${name}" @click=${this.toggle}>
          <span class="mp-i-play">${icon(Play, 16)}</span><span class="mp-i-pause">${icon(Pause, 16)}</span>
        </button>
        <span class="mp-time">0:00</span>
        ${this.trackTemplate()}
        <button type="button" class="mp-btn mp-speed" aria-label="Playback speed" @click=${this.cycleSpeed}>
          ${speed}×
        </button>
        <button type="button" class="mp-btn mp-mute" aria-label="Mute" @click=${this.toggleMute}>
          <span class="mp-i-sound">${icon(Volume2, 16)}</span><span class="mp-i-muted">${icon(VolumeX, 16)}</span>
        </button>
        ${
          download
            ? html`<a class="mp-btn" href=${download} download=${name} aria-label="Download ${name}"
                >${icon(Download, 16)}</a
              >`
            : nothing
        }
        <button
          type="button"
          class="mp-btn"
          aria-label=${this.mode === "viewer" ? "Full screen" : "Expand"}
          @click=${this.expand}
        >
          ${icon(Maximize2, 16)}
        </button>
      </div>
      ${this.errorTemplate()}`;
  }

  private audioTemplate(): TemplateResult {
    const { name, src, download } = this.item;
    return html`<audio
        src=${src}
        preload="metadata"
        @loadedmetadata=${this.onMetadata}
        @play=${this.onPlay}
        @pause=${this.onPause}
        @error=${this.onError}
        @timeupdate=${this.paint}
      ></audio>
      <button type="button" class="mp-toggle mp-round" aria-label="Play ${name}" @click=${this.toggle}>
        <span class="mp-i-play">${icon(Play, 15)}</span><span class="mp-i-pause">${icon(Pause, 15)}</span>
      </button>
      <div class="mp-body"><span class="mp-name" dir="auto">${name}</span>${this.trackTemplate()}</div>
      <span class="mp-time"></span>
      ${
        download
          ? html`<a class="mp-btn" href=${download} download=${name} aria-label="Download ${name}"
              >${icon(Download, 15)}</a
            >`
          : nothing
      }
      ${this.errorTemplate()}`;
  }

  private trackTemplate(): TemplateResult {
    return html`<div
      class="mp-track"
      role="slider"
      tabindex="0"
      aria-label="Seek"
      aria-valuemin="0"
      aria-valuemax="0"
      aria-valuenow="0"
      @pointerdown=${this.onScrubStart}
      @pointermove=${this.onScrubMove}
      @pointerup=${this.onScrubEnd}
      @pointercancel=${this.onScrubEnd}
      @keydown=${this.onTrackKey}
    >
      <span class="mp-rail"><i class="mp-ghost"></i><i class="mp-played"></i></span><i class="mp-knob"></i
      ><span class="mp-tip"></span>
    </div>`;
  }

  private errorTemplate(): TemplateResult {
    const { name, download } = this.item;
    return html`<div class="mp-error">
      <span dir="auto">${name}</span><span>Can't play this here.</span>${
        download ? html`<a href=${download} download=${name}>Download</a>` : nothing
      }
    </div>`;
  }

  private paint = (): void => {
    const media = this.media;
    if (!media) return;
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    this.style.setProperty("--mp-played", String(duration ? media.currentTime / duration : 0));
    const total = formatDuration(duration);
    const clock = this.dataset.state === "idle" ? total : `${formatDuration(media.currentTime)} / ${total}`;
    if (clock === this.clock) return;
    this.clock = clock;
    this.querySelector(".mp-time")!.textContent = clock;
    const track = this.querySelector(".mp-track")!;
    track.setAttribute("aria-valuenow", String(Math.round(media.currentTime)));
    track.setAttribute("aria-valuetext", clock);
  };

  private tick = (): void => {
    this.paint();
    if (this.dataset.state === "playing") this.frame = requestAnimationFrame(this.tick);
  };

  private setState(state: "playing" | "paused" | "ended" | "error"): void {
    this.dataset.state = state;
    const label = `${state === "playing" ? "Pause" : "Play"} ${this.item.name}`;
    for (const control of this.querySelectorAll(".mp-toggle, .mp-surface")) control.setAttribute("aria-label", label);
  }

  private onMetadata = (): void => {
    const media = this.media!;
    if (media instanceof HTMLVideoElement && learn(this.item.src, media.videoWidth, media.videoHeight))
      this.dispatchEvent(new CustomEvent("qm-media-ratio", { bubbles: true }));
    const length = this.querySelector(".mp-length");
    if (length) length.textContent = formatDuration(media.duration);
    this.querySelector(".mp-track")!.setAttribute("aria-valuemax", String(Math.round(media.duration || 0)));
    if (this.startAt) {
      media.currentTime = this.startAt;
      if (media.paused) this.setState("paused");
    }
    this.paint();
  };

  private onPlay = (): void => {
    if (nowPlaying !== this) nowPlaying?.pause();
    nowPlaying = this;
    this.setState("playing");
    this.wake();
    this.tick();
  };

  private onPause = (): void => {
    cancelAnimationFrame(this.frame);
    this.setState(this.media!.ended ? "ended" : "paused");
    this.paint();
  };

  private onError = (): void => {
    if (this.media?.error) this.setState("error");
  };

  private onVolume = (): void => {
    this.toggleAttribute("data-muted", this.media!.muted);
  };

  private wake = (): void => {
    this.classList.remove("mp-quiet");
    clearTimeout(this.quietTimer);
    this.quietTimer = window.setTimeout(() => this.classList.add("mp-quiet"), 2200);
  };

  private cycleSpeed = (event: Event): void => {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!;
    this.media!.playbackRate = speed;
    (event.currentTarget as HTMLElement).textContent = `${speed}×`;
  };

  private toggleMute = (): void => {
    this.media!.muted = !this.media!.muted;
  };

  private expand = (): void => {
    const media = this.media!;
    if (this.mode === "viewer") {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void this.requestFullscreen().catch(() => undefined);
      return;
    }
    const detail = { startAt: media.currentTime, autoplay: !media.paused || this.dataset.state === "idle" };
    media.pause();
    this.dispatchEvent(new CustomEvent("qm-media-expand", { bubbles: true, detail }));
  };

  private fraction(event: PointerEvent): number {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  }

  private onScrubStart = (event: PointerEvent): void => {
    if (event.button) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.scrubbing = true;
    this.onScrubMove(event);
  };

  private onScrubMove = (event: PointerEvent): void => {
    const duration = this.media?.duration;
    if (!duration || !Number.isFinite(duration)) return;
    const at = this.fraction(event);
    const track = event.currentTarget as HTMLElement;
    track.style.setProperty("--mp-tip", String(at));
    track.querySelector(".mp-tip")!.textContent = formatDuration(at * duration);
    if (!this.scrubbing) return;
    if (this.dataset.state === "idle") this.setState("paused");
    this.seek(at * duration);
  };

  private onScrubEnd = (): void => {
    this.scrubbing = false;
  };

  private onTrackKey = (event: KeyboardEvent): void => {
    const media = this.media!;
    const step = { ArrowLeft: -5, ArrowRight: 5, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.seek(Math.min(media.duration || 0, Math.max(0, media.currentTime + step)));
  };
}

class MediaFeed extends Base {
  private list: readonly MediaItem[] = [];
  private signature = "";
  private width = 0;
  private observer: ResizeObserver | null = null;

  set items(next: readonly MediaItem[]) {
    const signature = next.map((item) => `${item.kind} ${item.src}`).join("\n");
    this.list = next;
    if (signature === this.signature) return;
    this.signature = signature;
    this.draw();
  }

  get items(): readonly MediaItem[] {
    return this.list;
  }

  connectedCallback(): void {
    this.addEventListener("qm-media-ratio", this.draw);
    this.addEventListener("qm-media-expand", this.onExpand);
    this.observer = new ResizeObserver(() => {
      const width = Math.round(this.clientWidth);
      if (!width || width === this.width) return;
      this.width = width;
      this.draw();
    });
    this.observer.observe(this);
    this.draw();
  }

  disconnectedCallback(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private draw = (): void => {
    if (!this.isConnected) return;
    const shown = this.list.slice(0, MAX_TILES);
    const more = this.list.length - shown.length;
    const shape = shown.map((item) => layoutRatio(ratios.get(item.src), fallbackRatio(item)));
    const rows = justifyRows(
      shape,
      shown.map((item) => item.kind === "video"),
      this.width || FEED_WIDTH,
    );
    const key = (index: number): string => `${index} ${shown[index]!.src}`;
    render(
      repeat(
        rows,
        (row) => row.map(key).join("\n"),
        (row) => {
          const fit = row.reduce((sum, index) => sum + shape[index]!, 0) * MAX_HEIGHT + MEDIA_GAP * (row.length - 1);
          const only = row.length === 1 ? shown[row[0]!]! : null;
          const natural = (only?.kind === "image" && naturalWidths.get(only.src)) || Infinity;
          return html`<div class="media-row" style="max-width:${Math.round(Math.min(fit, natural))}px">
            ${repeat(row, key, (index) => this.tile(shown[index]!, index, shape[index]!, index === MAX_TILES - 1 ? more : 0))}
          </div>`;
        },
      ),
      this,
    );
  };

  private tile(item: MediaItem, index: number, ratio: number, more: number): TemplateResult {
    const style = `flex:${Math.round(ratio * 100)} 1 0;aspect-ratio:${ratio}`;
    if (item.kind === "video") return html`<qm-player class="media-tile" style=${style} .item=${item}></qm-player>`;
    return html`<button
      type="button"
      class="media-tile"
      style=${style}
      aria-label=${more ? `Show all ${this.list.length} files` : `Open ${item.name}`}
      @click=${() => this.open(index)}
    >
      <img
        src=${item.src}
        alt=${item.name}
        loading="lazy"
        decoding="async"
        @load=${(event: Event) => {
          const image = event.currentTarget as HTMLImageElement;
          if (learn(item.src, image.naturalWidth, image.naturalHeight)) this.draw();
        }}
      />${more ? html`<span class="media-more">+${more}</span>` : nothing}
    </button>`;
  }

  private open(index: number, playback: { startAt?: number; autoplay?: boolean } = {}): void {
    openMediaViewer(this.list, index, {
      ...playback,
      originOf: (at) => this.querySelectorAll<HTMLElement>(".media-tile")[at] ?? null,
    });
  }

  private onExpand = (event: Event): void => {
    event.stopPropagation();
    const src = (event.target as MediaPlayer).item.src;
    this.open(
      this.list.findIndex((item) => item.src === src),
      (event as CustomEvent<{ startAt: number; autoplay: boolean }>).detail,
    );
  };
}

if (typeof customElements !== "undefined" && !customElements.get("qm-player")) {
  customElements.define("qm-player", MediaPlayer);
  customElements.define("qm-media-feed", MediaFeed);
}

export function mediaFeed(items: readonly MediaItem[]): TemplateResult {
  return html`<qm-media-feed .items=${items}></qm-media-feed>`;
}

export function audioPlayer(item: MediaItem): TemplateResult {
  return html`<qm-player .item=${item}></qm-player>`;
}

interface ViewerOptions {
  originOf?: (index: number) => Element | null;
  startAt?: number;
  autoplay?: boolean;
}

export function openMediaViewer(all: readonly MediaItem[], start = 0, options: ViewerOptions = {}): void {
  const items = all.filter((item) => item.kind !== "audio");
  if (!items.length) return;
  let index = Math.max(0, items.indexOf(all[start]!));
  let zoomed = false;
  let closing = false;
  let playback = { startAt: options.startAt ?? 0, autoplay: options.autoplay ?? items[index]!.kind === "video" };
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "media-viewer";
  dialog.tabIndex = -1;

  const player = (): MediaPlayer | null => dialog.querySelector<MediaPlayer>("qm-player");
  const origin = (): Element | null => options.originOf?.(all.indexOf(items[index]!)) ?? null;

  const morph = (opening: boolean): Animation | null => {
    const frame = dialog.querySelector<HTMLElement>(".mv-frame");
    const tile = origin();
    if (!frame || !tile || zoomed || reducedMotion() || (!opening && !inView(tile))) return null;
    const from = tile.getBoundingClientRect();
    const to = frame.getBoundingClientRect();
    if (!from.width || !to.width) return null;
    const scale = Math.max(from.width / to.width, from.height / to.height);
    const cropX = Math.max(0, (to.width - from.width / scale) / 2);
    const cropY = Math.max(0, (to.height - from.height / scale) / 2);
    const small = {
      transform: `translate(${from.left + from.width / 2 - to.left - to.width / 2}px, ${from.top + from.height / 2 - to.top - to.height / 2}px) scale(${scale})`,
      clipPath: `inset(${cropY}px ${cropX}px round ${10 / scale}px)`,
    };
    const full = { transform: "none", clipPath: "inset(0px 0px round 10px)" };
    return frame.animate(opening ? [small, full] : [full, small], {
      duration: opening ? 300 : 220,
      easing: EASE,
      fill: opening ? "none" : "forwards",
    });
  };

  const close = (): void => {
    if (closing) return;
    closing = true;
    const active = player();
    const tile = origin();
    active?.pause();
    if (active && tile instanceof MediaPlayer) tile.seek(active.time);
    if (document.fullscreenElement) void document.exitFullscreen();
    dialog.classList.add("closing");
    const done = (): void => {
      render(nothing, dialog);
      dialog.close();
      dialog.remove();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
    const leaving = morph(false);
    if (leaving) void leaving.finished.then(done, done);
    else setTimeout(done, reducedMotion() ? 0 : 160);
  };

  const show = (next: number): void => {
    if (next < 0 || next >= items.length || next === index) return;
    index = next;
    zoomed = false;
    playback = { startAt: 0, autoplay: false };
    draw();
    dialog.querySelector(".mv-thumb[aria-current='true']")?.scrollIntoView({ block: "nearest", inline: "center" });
  };

  const toggleZoom = (event: MouseEvent): void => {
    const image = event.currentTarget as HTMLImageElement;
    const stage = image.parentElement!;
    if (!zoomed && image.naturalWidth <= image.clientWidth * 1.05) return;
    const x = event.offsetX / image.clientWidth;
    const y = event.offsetY / image.clientHeight;
    zoomed = !zoomed;
    draw();
    if (!zoomed) return;
    stage.scrollLeft = x * image.offsetWidth - stage.clientWidth / 2;
    stage.scrollTop = y * image.offsetHeight - stage.clientHeight / 2;
  };

  const frameTemplate = (item: MediaItem): TemplateResult => {
    const natural = item.kind === "image" ? naturalWidths.get(item.src) : undefined;
    const style = `--ar:${ratios.get(item.src) ?? fallbackRatio(item)};${natural ? `--natural:${natural}px` : ""}`;
    if (item.kind === "video")
      return html`<qm-player
        class="mv-frame"
        style=${style}
        .item=${item}
        .mode=${"viewer"}
        .startAt=${playback.startAt}
        .autoplay=${playback.autoplay}
      ></qm-player>`;
    return html`<img
      class="mv-frame"
      style=${style}
      src=${item.src}
      alt=${item.name}
      draggable="false"
      @click=${toggleZoom}
      @load=${(event: Event) => {
        const image = event.currentTarget as HTMLImageElement;
        if (learn(item.src, image.naturalWidth, image.naturalHeight)) draw();
        image.classList.toggle("zoomable", zoomed || image.naturalWidth > image.clientWidth * 1.05);
      }}
    />`;
  };

  const draw = (): void => {
    const item = items[index]!;
    const meta = [
      typeof item.size === "number" ? formatBytes(item.size) : "",
      items.length > 1 ? `${index + 1} of ${items.length}` : "",
    ].filter(Boolean);
    render(
      html`<header class="mv-bar">
          <div class="mv-title">
            <strong dir="auto">${item.name}</strong>${meta.length ? html`<small>${meta.join(" · ")}</small>` : nothing}
          </div>
          <div class="mv-actions">
            ${
              item.download
                ? html`<a
                      class="mv-btn"
                      href=${item.download}
                      download=${item.name}
                      aria-label="Download ${item.name}"
                      title="Download"
                      >${icon(Download, 18)}</a
                    ><a
                      class="mv-btn"
                      href=${item.download}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open ${item.name} in a new tab"
                      title="Open in new tab"
                      >${icon(ExternalLink, 18)}</a
                    >`
                : nothing
            }
            <button type="button" class="mv-btn" aria-label="Close" title="Close" @click=${close}>
              ${icon(X, 18)}
            </button>
          </div>
        </header>
        <div
          class="mv-stage ${zoomed ? "zoomed" : ""}"
          @click=${(event: MouseEvent) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          ${keyed(`${index} ${item.src}`, frameTemplate(item))}
          ${
            items.length > 1
              ? html`<button
                    type="button"
                    class="mv-nav mv-prev"
                    aria-label="Previous"
                    ?disabled=${index === 0}
                    @click=${() => show(index - 1)}
                  >
                    ${icon(ChevronLeft, 22)}</button
                  ><button
                    type="button"
                    class="mv-nav mv-next"
                    aria-label="Next"
                    ?disabled=${index === items.length - 1}
                    @click=${() => show(index + 1)}
                  >
                    ${icon(ChevronRight, 22)}
                  </button>`
              : nothing
          }
        </div>
        ${
          items.length > 1
            ? html`<div class="mv-strip">
                ${items.map(
                  (entry, at) =>
                    html`<button
                      type="button"
                      class="mv-thumb"
                      aria-label=${entry.name}
                      aria-current=${at === index ? "true" : "false"}
                      @click=${() => show(at)}
                    >
                      ${
                        entry.kind === "video"
                          ? html`<video
                                src=${frameSrc(entry.src)}
                                preload="metadata"
                                muted
                                playsinline
                                tabindex="-1"
                              ></video
                              ><span class="mv-thumb-play">${icon(Play, 14)}</span>`
                          : html`<img src=${entry.src} alt="" loading="lazy" />`
                      }
                    </button>`,
                )}
              </div>`
            : nothing
        }`,
      dialog,
    );
  };

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("qm-media-ratio", draw);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      show(index + (event.key === "ArrowLeft" ? -1 : 1));
    } else if (event.key === " " && !(event.target as Element).closest("button, a, [role='slider']")) {
      event.preventDefault();
      player()?.toggle();
    }
  });
  document.body.append(dialog);
  draw();
  dialog.showModal();
  dialog.focus({ preventScroll: true });
  morph(true);
}
