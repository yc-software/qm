import { BlobTooLargeError } from "../persistence/blob-transfer.ts";
import type { IncomingAttachment, OutgoingAttachment } from "../types.ts";
import { swallow } from "../util/errors.ts";

export interface InboundFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  user?: string;
}

export const MAX_ATTACHMENT_BYTES = 1_000_000_000;
export const MAX_ATTACHMENTS_PER_TURN = 10;

const CAP_MB = Math.floor(MAX_ATTACHMENT_BYTES / 1_000_000);
const capLabel = CAP_MB >= 1000 ? `${Math.round(CAP_MB / 1000)} GB` : `${CAP_MB} MB`;
const oversizeMsg = (label: string): string => `"${label}" is too large — I can handle files up to ~${capLabel}`;

export const inboundFileName = (f: Pick<InboundFile, "name" | "title" | "id">): string =>
  f.name || f.title || f.id || "file";

export function isOversize(file: Pick<InboundFile, "size">): boolean {
  return typeof file.size === "number" && file.size > MAX_ATTACHMENT_BYTES;
}

export function attachmentFromBytes(
  file: InboundFile,
  bytes: Uint8Array,
  blobId: string,
  author?: string,
): IncomingAttachment {
  return {
    name: inboundFileName(file),
    mimetype: file.mimetype || "application/octet-stream",
    sizeBytes: bytes.length,
    blobId,
    ...(file.id ? { sourceId: file.id } : {}),
    ...(author ? { author } : {}),
  };
}

export async function responseBytes(res: Response): Promise<Uint8Array> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? "0") > MAX_ATTACHMENT_BYTES) throw new Error("file too large");
  return new Uint8Array(await res.arrayBuffer());
}

export interface ProcessedInbound {
  attachments: IncomingAttachment[];
  issues: string[];
}

export async function processInboundFiles<F extends InboundFile>(
  files: readonly F[],
  download: (file: F) => Promise<Uint8Array>,
  stage: (bytes: Uint8Array) => Promise<{ blobId: string }>,
  resolveAuthor?: (userId: string | undefined) => Promise<string | undefined> | string | undefined,
  unreadableHint = "",
): Promise<ProcessedInbound> {
  const attachments: IncomingAttachment[] = [];
  const issues: string[] = [];
  for (const f of files) {
    const label = f.name || f.title || "that file";
    if (attachments.length >= MAX_ATTACHMENTS_PER_TURN) {
      issues.push(`skipped "${label}" — too many files at once (max ${MAX_ATTACHMENTS_PER_TURN})`);
      continue;
    }
    if (isOversize(f)) {
      issues.push(oversizeMsg(label));
      continue;
    }
    try {
      const bytes = await download(f);
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        issues.push(oversizeMsg(label));
        continue;
      }
      const { blobId } = await stage(bytes);
      const author = resolveAuthor ? await resolveAuthor(f.user) : undefined;
      attachments.push(attachmentFromBytes(f, bytes, blobId, author));
    } catch (err) {
      swallow(`inbound file "${label}"`, err);
      const detail =
        err instanceof BlobTooLargeError
          ? "that request was too large — try fewer or smaller files"
          : (err as Error).message;
      issues.push(`I couldn't read "${label}"${unreadableHint} (${detail})`);
    }
  }
  return { attachments, issues };
}

export interface BlobSource {
  readBlob(blobId: string): Promise<Buffer>;
  readFileArtifact(artifactId: string, viewerId: string): Promise<Buffer>;
}

export async function readOutgoingFiles(
  attachments: readonly OutgoingAttachment[],
  blobs: BlobSource,
): Promise<Array<{ name: string; mimetype: string; file: Buffer }>> {
  const files: Array<{ name: string; mimetype: string; file: Buffer }> = [];
  for (const a of attachments) {
    let file: Buffer;
    try {
      file = await blobs.readBlob(a.blobId);
    } catch (err) {
      if (!a.artifactId || !a.artifactViewerId) throw err;
      file = await blobs.readFileArtifact(a.artifactId, a.artifactViewerId);
    }
    if (file.length > 0) files.push({ name: a.name, mimetype: a.mimetype, file });
  }
  return files;
}
