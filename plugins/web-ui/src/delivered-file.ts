import { html, type TemplateResult } from "lit";
import { FileImage, Paperclip, type IconNode } from "lucide";
import { withBase, type DeliveredFile } from "./core-bridge.ts";
import { browserRenderableImage, formatBytes, icon } from "./ui.ts";
import { WorkflowArtifactRegistry } from "./workflow-artifact-registry.ts";
import { isWorkflowArtifactMime } from "./workflow-artifact.ts";

function chipBadge(glyph: IconNode, name: string, size?: number, href?: string, download = false): TemplateResult {
  const inner = html`${icon(glyph, 14)}<span>${name}</span>${typeof size === "number" ? html`<small>${formatBytes(size)}</small>` : null}`;
  if (!href) return html`<span class="file-chip">${inner}</span>`;
  return download
    ? html`<a class="file-chip" href=${href} download=${name}>${inner}</a>`
    : html`<a class="file-chip" href=${href} target="_blank" rel="noreferrer">${inner}</a>`;
}

export function fileChip(name: string, size?: number, href?: string): TemplateResult {
  return chipBadge(Paperclip, name, size, href);
}

export function imageChip(name: string, size?: number, href?: string): TemplateResult {
  return chipBadge(FileImage, name, size, href, true);
}

export function deliveredFileBadge(file: DeliveredFile, workflowArtifacts: WorkflowArtifactRegistry): TemplateResult {
  if (!file.artifactId) return fileChip(file.name, file.sizeBytes);
  const href = withBase(`/api/files/${encodeURIComponent(file.artifactId)}/content`);
  if (isWorkflowArtifactMime(file.mimetype)) {
    return html`<qm-workflow-artifact
      .artifactUrl=${href}
      .originalHref=${href}
      .registry=${workflowArtifacts}
    ></qm-workflow-artifact>`;
  }
  if (file.mimetype?.startsWith("image/")) {
    if (!browserRenderableImage(file.mimetype)) return imageChip(file.name, file.sizeBytes, href);
    return html`<a class="file-image" href=${href} target="_blank" rel="noreferrer" title=${file.name}
      ><img src=${href} alt=${file.name} loading="lazy"
    /></a>`;
  }
  return fileChip(file.name, file.sizeBytes, href);
}
