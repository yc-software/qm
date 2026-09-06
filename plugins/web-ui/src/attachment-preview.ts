import type { Attachment } from "@earendil-works/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { File as FileGlyph } from "lucide";
import { formatBytes, icon } from "./ui";

const KIND_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/json": "JSON",
  "text/csv": "CSV",
  "text/markdown": "Markdown",
  "text/plain": "Plain text",
};

const PREVIEW_TEXT_CHARS = 700;

export function attachmentKind(mimeType: string): string {
  const known = KIND_LABELS[mimeType];
  if (known) return known;
  const [type, subtype = ""] = mimeType.split("/");
  const label = subtype.replace(/^x-/, "").toUpperCase() || "File";
  return type === "image" ? `${label} image` : label;
}

function previewImageSrc(a: Attachment): string | null {
  if (a.type === "image") return `data:${a.mimeType};base64,${a.preview ?? a.content}`;
  return a.preview ? `data:image/png;base64,${a.preview}` : null;
}

function previewBody(a: Attachment, kind: string): TemplateResult {
  const src = previewImageSrc(a);
  if (src) return html`<img class="attachment-preview-image" src=${src} alt="" />`;
  if (a.extractedText) {
    const lines = a.extractedText.split("\n").length;
    return html`<pre class="attachment-preview-text">${a.extractedText.slice(0, PREVIEW_TEXT_CHARS)}</pre>
      <div class="attachment-preview-meta">${lines} ${lines === 1 ? "line" : "lines"}</div>`;
  }
  return html`<div class="attachment-preview-empty">
    ${icon(FileGlyph, 40)}
    <div>${kind}</div>
  </div>`;
}

export function attachmentPreview(a: Attachment): TemplateResult {
  const kind = attachmentKind(a.mimeType);
  return html`<div class="attachment-preview">
    <div class="attachment-preview-head">
      <div class="attachment-preview-name">${a.fileName}</div>
      <div class="attachment-preview-meta">${kind} · ${formatBytes(a.size)}</div>
    </div>
    ${previewBody(a, kind)}
  </div>`;
}

export function dismissPreviewOnEscape(e: KeyboardEvent): void {
  if (e.key === "Escape") (e.currentTarget as HTMLElement).classList.add("preview-dismissed");
}

export function restorePreview(e: Event): void {
  (e.currentTarget as HTMLElement).classList.remove("preview-dismissed");
}
