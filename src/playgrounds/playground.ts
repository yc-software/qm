import { randomUUID } from "node:crypto";
import { artifactPath, fileArtifactId, type FileArtifactStore } from "../files/file-artifact-store.ts";
import { headSlice } from "../util/text.ts";
import type { ScopeId } from "../types.ts";

const MAX_PLAYGROUND_HTML_BYTES = 512_000;
const PLAYGROUND_TITLE_MAX = 80;

export interface PlaygroundArtifact {
  kind: "playground";
  artifactId: string;
  title: string;
}

export function normalizePlaygroundTitle(raw: string): string {
  const title = raw.replace(/\s+/g, " ").trim() || "Playground";
  return title.length > PLAYGROUND_TITLE_MAX ? `${headSlice(title, PLAYGROUND_TITLE_MAX - 1)}…` : title;
}

export function validatePlaygroundHtml(html: string): void {
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_PLAYGROUND_HTML_BYTES) {
    throw new Error(`playground HTML is ${bytes} bytes; keep it under ${MAX_PLAYGROUND_HTML_BYTES}`);
  }
  if (!html.trim()) throw new Error("playground HTML is empty");
}

export async function createPlaygroundArtifact(
  store: FileArtifactStore,
  input: { title: string; html: string; ownerScopeId: ScopeId; createdBy: string },
): Promise<PlaygroundArtifact> {
  validatePlaygroundHtml(input.html);
  const title = normalizePlaygroundTitle(input.title);
  const artifactId = fileArtifactId(`playground:${input.ownerScopeId}:${randomUUID()}`, "out", 0);
  const name = `${artifactId}.html`;
  await store.put({
    id: artifactId,
    ownerScopeId: input.ownerScopeId,
    createdBy: input.createdBy,
    name,
    path: artifactPath(artifactId, name),
    mimetype: "text/html",
    data: Buffer.from(input.html),
    direction: "out",
    createdInScope: input.ownerScopeId,
    maxBytes: MAX_PLAYGROUND_HTML_BYTES,
  });
  return { kind: "playground", artifactId, title };
}
