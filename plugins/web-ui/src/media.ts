import { html, nothing, render, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import { ChevronLeft, ChevronRight, Download, ExternalLink, Maximize2, Pause, Play, Volume2, VolumeX, X } from "lucide";
import "./media.css";
import { icon } from "./icons";
import { tip } from "./tooltip";
import { reportHandledError } from "./browser-errors";
import { formatBytes } from "./ui";
import { formatDuration, justifyRows, layoutRatio, MEDIA_GAP, type MediaItem } from "./media-layout";

export { dataUrl, mediaKind, type MediaItem } from "./media-layout";

const MAX_TILES = 6;
const MAX_HEIGHT = 460;
const FEED_WIDTH = 700;
const SPEEDS = [1, 1.5, 2, 0.5];
const ZOOM_WORTHWHILE = 1.25;
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

const ratios = new Map<string, number>();
const naturalWidths = new Map<string, number>();
let speed = 1;
const playing: { player: MediaPlayer | null } = { player: null };

const Base = (typeof HTMLElement === "undefined" ? class {} : HTMLElement) as typeof HTMLElement;

function frameSrc(src: string, at = 0.001): string {
  return src.startsWith("data:") ? src : `${src}#t=${at}`;
}

export function videoThumb(src: string, badge = "file-video-play", onError?: (event: Event) => void): TemplateResult {
  return html`<video src=${frameSrc(src)} preload="metadata" muted playsinline tabindex="-1" @error=${onError}></video
    ><span class=${badge}>${icon(Play, 14)}</span>`;
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
    if (playing.player === this) playing.player = null;
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
    if (!media.paused) return media.pause();
    if (playing.player !== this) playing.player?.pause();
    playing.player = this;
    void media.play().catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) reportHandledError("web:media_play", error);
    });
  };

  private videoTemplate(): TemplateResult {
    const { name, src, download } = this.item;
    const viewer = this.mode === "viewer";
    return html`<video
        src=${frameSrc(src, this.startAt || 0.001)}
        preload=${this.autoplay ? "auto" : "metadata"}
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
          download && !viewer
            ? html`<a class="mp-btn" href=${download} download=${name} aria-label="Download ${name}"
                >${icon(Download, 16)}</a
              >`
            : nothing
        }
        <button type="button" class="mp-btn" aria-label=${viewer ? "Full screen" : "Expand"} @click=${this.expand}>
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
      <div class="mp-body">
        <span class="mp-name" dir="auto">${name}</span>
        <div class="mp-line">${this.trackTemplate()}<span class="mp-time"></span></div>
      </div>
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
    if (this.startAt && media.paused) this.setState("paused");
    this.paint();
  };

  private onPlay = (): void => {
    if (playing.player && playing.player !== this) return this.media!.pause();
    playing.player = this;
    this.setState("playing");
    this.wake();
    this.tick();
  };

  private onPause = (): void => {
    if (playing.player === this) playing.player = null;
    cancelAnimationFrame(this.frame);
    this.setState(this.media!.ended ? "ended" : "paused");
    this.paint();
  };

  private onError = (): void => {
    const failure = this.media?.error;
    if (!failure) return;
    this.setState("error");
    reportHandledError("web:media_error", new Error(`MediaError ${failure.code}: ${failure.message}`));
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
      else void this.requestFullscreen().catch((error: unknown) => reportHandledError("web:media_fullscreen", error));
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
      ${tip(more ? `${more} more` : item.name)}
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
  let panned = false;
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
      duration: opening ? 340 : 240,
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
    if (leaving) return void leaving.finished.then(done, done);
    dialog.classList.add("fading");
    setTimeout(done, reducedMotion() ? 0 : 180);
  };

  const show = (next: number): void => {
    if (next < 0 || next >= items.length || next === index) return;
    index = next;
    zoomed = false;
    playback = { startAt: 0, autoplay: false };
    draw();
    dialog.querySelector(".mv-thumb[aria-current='true']")?.scrollIntoView({ block: "nearest", inline: "center" });
  };

  const pan = (event: PointerEvent): void => {
    panned = false;
    if (!zoomed || event.button) return;
    const image = event.currentTarget as HTMLElement;
    const stage = image.parentElement!;
    const start = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    const move = (at: PointerEvent): void => {
      if (Math.hypot(at.clientX - start.x, at.clientY - start.y) > 4) panned = true;
      stage.scrollTo(start.left + start.x - at.clientX, start.top + start.y - at.clientY);
    };
    const stop = (): void => image.removeEventListener("pointermove", move);
    image.setPointerCapture(event.pointerId);
    image.addEventListener("pointermove", move);
    image.addEventListener("pointerup", stop, { once: true });
    image.addEventListener("pointercancel", stop, { once: true });
  };

  const toggleZoom = (event: MouseEvent): void => {
    if (panned) return;
    const image = event.currentTarget as HTMLImageElement;
    const stage = image.parentElement!;
    if (!zoomed && image.naturalWidth < image.clientWidth * ZOOM_WORTHWHILE) return;
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
      @pointerdown=${pan}
      @click=${toggleZoom}
      @load=${(event: Event) => {
        const image = event.currentTarget as HTMLImageElement;
        if (learn(item.src, image.naturalWidth, image.naturalHeight)) draw();
        image.classList.toggle("zoomable", zoomed || image.naturalWidth >= image.clientWidth * ZOOM_WORTHWHILE);
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
                      ${tip("Download")}
                      >${icon(Download, 18)}</a
                    ><a
                      class="mv-btn"
                      href=${item.download}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open ${item.name} in a new tab"
                      ${tip("Open in new tab")}
                      >${icon(ExternalLink, 18)}</a
                    >`
                : nothing
            }
            <button type="button" class="mv-btn" aria-label="Close" ${tip("Close")} @click=${close}>
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
            ? html`<div class="mv-strip" ?hidden=${zoomed}>
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
                          ? videoThumb(entry.src, "mv-thumb-play")
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
