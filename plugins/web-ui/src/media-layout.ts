export type MediaKind = "image" | "video" | "audio";

export interface MediaItem {
  kind: MediaKind;
  name: string;
  src: string;
  size?: number;
  download?: string;
}

const RENDERABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/apng",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/x-ms-bmp",
]);

export function dataUrl(content: string, mimeType = "application/octet-stream"): string {
  return content.startsWith("data:") ? content : `data:${mimeType};base64,${content}`;
}

export function browserRenderableImage(mimeType?: string): boolean {
  return RENDERABLE_IMAGE_TYPES.has((mimeType ?? "").split(";")[0]!.trim().toLowerCase());
}

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "ogv"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav", "oga", "ogg", "opus", "flac"]);

function playableKind(name = "", mimetype = ""): "video" | "audio" | null {
  const mime = mimetype.split(";", 1)[0]!.trim().toLowerCase();
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime && mime !== "application/octet-stream") return null;
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  return null;
}

export function mediaKind(name?: string, mimetype?: string): MediaKind | null {
  return browserRenderableImage(mimetype) ? "image" : playableKind(name, mimetype);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export const MEDIA_GAP = 6;
const MAX_PER_ROW = 4;

export function layoutRatio(ratio: number | undefined, fallback: number): number {
  return Math.min(3.2, Math.max(0.42, ratio && Number.isFinite(ratio) ? ratio : fallback));
}

function rowHeight(ratios: readonly number[], width: number): number {
  return (width - MEDIA_GAP * (ratios.length - 1)) / ratios.reduce((sum, ratio) => sum + ratio, 0);
}

export function justifyRows(ratios: readonly number[], solo: readonly boolean[], width: number): number[][] {
  const dense = solo.includes(true) || solo.length > 4;
  const target = Math.min(230, Math.max(96, width * (dense ? 0.18 : 0.3)));
  const best: Array<{ cost: number; from: number }> = [{ cost: 0, from: 0 }];
  for (let end = 1; end <= ratios.length; end++) {
    let pick = { cost: Infinity, from: end - 1 };
    for (let from = end - 1; from >= 0 && end - from <= MAX_PER_ROW; from--) {
      const alone = end - from === 1;
      if (!alone && (solo[from] || solo[end - 1])) break;
      const miss = alone && solo[from] ? 0 : (rowHeight(ratios.slice(from, end), width) - target) / target;
      const cost = best[from]!.cost + miss * miss;
      if (cost < pick.cost) pick = { cost, from };
    }
    best.push(pick);
  }
  const rows: number[][] = [];
  for (let end = ratios.length; end > 0; end = best[end]!.from) {
    const row: number[] = [];
    for (let index = best[end]!.from; index < end; index++) row.push(index);
    rows.unshift(row);
  }
  return rows;
}
