import { MAX_DOCUMENT_BYTES } from "./document-inputs.ts";
import { addAbortSignal, type Readable } from "node:stream";
import { collectBytes } from "../util/bytes.ts";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AttachmentMeta,
  GrantedHandle,
  IncomingAttachment,
  OutgoingAttachment,
  ScopeId,
  SessionEntry,
} from "../types.ts";
import { hasParentPathSegment, type Sandbox, type SandboxHandle } from "../sandbox/sandbox.ts";
import { MAX_BLOB_BYTES, type BlobTransferStore } from "../persistence/blob-transfer.ts";
import {
  artifactPath,
  fileArtifactId,
  type FileArtifactStore,
  type FileDirection,
} from "../files/file-artifact-store.ts";
import { parseRef } from "../acl/resource-ref.ts";
import { swallowAs } from "../util/errors.ts";
import { hashId } from "../util/crypto.ts";
import type { SecurityScreenVerdict } from "../security/security-posture.ts";
import { downscaleVisionImage, sniffImageDimensions } from "./image-downscale.ts";

export const INBOX_DIR = "inbox";
export const SHARED_DIR = "shared";
export const TURN_FILES_DIR = ".agent-turn";

export function turnFileId(runId?: string, attempt = 1, now = Date.now()): string {
  return `${now.toString(36)}-${hashId([runId ?? randomUUID(), String(attempt)], 24)}`;
}

export const MAX_ATTACHMENT_BYTES = MAX_BLOB_BYTES;

const VISION_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const MAX_VISION_IMAGE_BYTES = 5_000_000;

export const MAX_LLM_REQUEST_BYTES = 18_000_000;

export const MAX_HISTORY_IMAGE_BYTES = 10_000_000;

export interface InboundImage {
  name: string;
  mimeType: string;
  dataBase64: string;
  artifactId?: string;
}

function baseMime(m: string): string {
  return (m.split(";")[0] ?? "").trim().toLowerCase();
}

function isTextMime(mimetype: string): boolean {
  return (
    mimetype.startsWith("text/") ||
    mimetype === "application/json" ||
    mimetype === "application/xml" ||
    mimetype === "application/yaml" ||
    mimetype === "image/svg+xml" ||
    mimetype.endsWith("+json") ||
    mimetype.endsWith("+xml")
  );
}

function decodeText(bytes: Uint8Array, name: string, mimetype: string): string | null {
  const tolerant = () =>
    isTextMime(mimetype) || isTextMime(mimeFromName(name)) ? Buffer.from(bytes).toString("utf8") : null;
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!content.includes("\0")) return content;
    return tolerant();
  } catch {
    return tolerant();
  }
}

export function isVisionAttachment(attachment: Pick<IncomingAttachment, "name" | "mimetype">): boolean {
  return VISION_MIME_TYPES.has(baseMime(attachment.mimetype || mimeFromName(attachment.name)));
}

export function safeAttachmentName(name: string): string {
  const base = basename(String(name ?? "").replace(/\\/g, "/")).trim();
  if (!base || /^\.+$/.test(base)) return "file";
  return base;
}

const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  tsv: "text/tab-separated-values",
  eml: "message/rfc822",
  ics: "text/calendar",
  vcf: "text/vcard",
  js: "text/javascript",
  ts: "text/typescript",
  py: "text/x-python",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
};

export function mimeFromName(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export const MAX_OUTBOUND_FILES = 20;

export const MAX_INBOUND_FILES = 10;

export const MAX_SHARED_FILES_LISTED = 25;

export interface ArtifactRegistration {
  store: FileArtifactStore;
  ownerScopeId: ScopeId;
  createdBy: string;
  createdInScope?: ScopeId;
  seed: string;
  onRegistered?: (a: { id: string; path: string; ownerScopeId: ScopeId; direction: FileDirection }) => Promise<void>;
  onError?: (e: unknown) => void;
}

async function registerArtifact(
  reg: ArtifactRegistration,
  direction: FileDirection,
  batchIndex: number,
  name: string,
  mimetype: string,
  bytes: Uint8Array,
): Promise<
  { id: string; path: string; ownerScopeId: ScopeId; direction: FileDirection; created: boolean } | undefined
> {
  try {
    const id = fileArtifactId(reg.seed, direction, batchIndex);
    const path = `artifacts/${id}/${name}`;
    const { created } = await reg.store.put({
      id,
      ownerScopeId: reg.ownerScopeId,
      createdBy: reg.createdBy,
      name,
      path,
      mimetype,
      data: bytes,
      direction,
      ...(reg.createdInScope ? { createdInScope: reg.createdInScope } : {}),
      maxBytes: MAX_ATTACHMENT_BYTES,
    });
    const registered = { id, path, ownerScopeId: reg.ownerScopeId, direction, created };
    await reg.onRegistered?.(registered);
    return registered;
  } catch (e) {
    reg.onError?.(e);
    return undefined;
  }
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 2;
  while (used.has(`${stem}-${n}${ext}`)) n++;
  return `${stem}-${n}${ext}`;
}

export function withoutAlreadyIngested(
  attachments: IncomingAttachment[],
  contextEntries: readonly SessionEntry[],
): IncomingAttachment[] {
  const seen = new Set<string>();
  for (const entry of contextEntries) {
    if (entry.type !== "user") continue;
    const metas = (entry.payload as { attachments?: unknown } | null)?.attachments;
    if (!Array.isArray(metas)) continue;
    for (const meta of metas as AttachmentMeta[]) {
      if (meta.direction === "in" && typeof meta.sourceId === "string" && shownToModel(meta)) seen.add(meta.sourceId);
    }
  }
  if (!seen.size) return attachments;
  return attachments.filter((a) => !a.sourceId || !seen.has(a.sourceId));
}

function shownToModel(meta: AttachmentMeta): boolean {
  return isVisionAttachment(meta) && meta.sizeBytes > 0 && meta.sizeBytes <= MAX_VISION_IMAGE_BYTES;
}

export function inboundManifest(metas: AttachmentMeta[], inboxDir?: string): string {
  if (!metas.length) return "";
  const list = metas
    .map((m) => {
      let path = `${inboxDir ?? INBOX_DIR}/${m.name}`;
      if (m.artifactId) path = inboxDir ? `${inboxDir}/${m.artifactId}/${m.name}` : artifactPath(m.artifactId, m.name);
      return `- ${path} (${m.mimetype}, ${m.sizeBytes} bytes)${m.author ? ` — shared by ${m.author}` : ""}`;
    })
    .join("\n");
  const noun = metas.length === 1 ? "file" : "files";
  const lead = metas.some((m) => m.author)
    ? `${metas.length} ${noun} shared in this conversation, available at these file paths:`
    : `The user shared ${metas.length} ${noun}, available at these file paths:`;
  return `${lead}\n${list}`;
}

const FILE_EVENT_KIND = "file_event";

export interface FileEventPayload {
  kind: typeof FILE_EVENT_KIND;
  direction: FileDirection;
  issues: string[];
  text: string;
}

export function fileEventPayload(direction: FileDirection, issues: string[]): FileEventPayload {
  const lead =
    direction === "in"
      ? "Files received this turn that could not be made available"
      : "Files the agent tried to send that did not go out";
  return { kind: FILE_EVENT_KIND, direction, issues, text: `${lead}: ${issues.join("; ")}` };
}

export function inboundIssueList(opts: {
  tooMany?: readonly string[];
  unavailable?: readonly string[];
  blocked?: readonly string[];
  surfaceNotes?: readonly string[];
}): string[] {
  const issues: string[] = [];
  if (opts.tooMany?.length) {
    issues.push(
      `${opts.tooMany.join(", ")} — too many files in one message (only the first ${MAX_INBOUND_FILES} were taken)`,
    );
  }
  if (opts.unavailable?.length) {
    issues.push(`${opts.unavailable.join(", ")} — no longer available (the upload may have expired)`);
  }
  if (opts.blocked?.length) {
    issues.push(`${opts.blocked.join(", ")} — withheld by the external-data security screen`);
  }
  for (const n of opts.surfaceNotes ?? []) if (n.trim()) issues.push(n.trim());
  return issues;
}

function isFileHandle(h: GrantedHandle): boolean {
  return parseRef(h.ownerPath).kind === "file";
}

export function sharedManifest(handles: readonly GrantedHandle[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const h of handles) {
    if (!isFileHandle(h)) continue;
    if (seen.has(h.handlePath)) continue;
    seen.add(h.handlePath);
    lines.push(`- ${h.handlePath}${h.permission === "write" ? " (writable)" : ""}`);
  }
  if (!lines.length) return "";
  const total = lines.length;
  const shown = lines.slice(0, MAX_SHARED_FILES_LISTED);
  const omitted = total - shown.length;
  if (omitted > 0) {
    shown.push(`…and ${omitted} more (read shared/<name> to fetch)`);
  }
  const noun = total === 1 ? "file" : "files";
  return (
    `${total} ${noun} shared with you — read a path below to fetch that file on demand, ` +
    `then attach it to a message to pass it on (name its path in the surface \`post\` action's \`files\`):\n${shown.join("\n")}`
  );
}

export function sharedFilesSystemSection(handles: readonly GrantedHandle[]): string {
  const body = sharedManifest(handles);
  if (!body) return "";
  return `## Files shared with you\n${body}`;
}

export function environmentNote(text: string): string {
  if (!text.trim()) return "";
  return `<environment>\n${text.trim()}\n</environment>`;
}

export function senderNote(name: string | undefined): string {
  const n = name?.trim();
  return n ? `This message is from @${n}.` : "";
}

const MAX_INBOUND_BUFFER_BYTES = MAX_DOCUMENT_BYTES;
const MAX_IMAGE_PIXELS = 20_000_000;

async function isBinaryStream(stream: Readable, name: string, mimetype: string): Promise<boolean> {
  if (isTextMime(mimetype) || isTextMime(mimeFromName(name))) return false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > MAX_ATTACHMENT_BYTES) throw new Error("attachment exceeds the size limit");
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const text = decoder.decode(bytes.subarray(offset, offset + 64 * 1024), { stream: true });
        if (text.includes("\0")) return true;
      }
    }
    return decoder.decode().includes("\0");
  } catch (error) {
    if (error instanceof TypeError && "code" in error && error.code === "ERR_ENCODING_INVALID_ENCODED_DATA")
      return true;
    throw error;
  }
}

export async function ingestInbound(
  attachments: IncomingAttachment[],
  transfer: BlobTransferStore,
  register: ArtifactRegistration,
  screenText?: (input: {
    content: string;
    name: string;
    mimetype: string;
  }) => Promise<SecurityScreenVerdict | undefined>,
  signal?: AbortSignal,
): Promise<{
  metas: AttachmentMeta[];
  images: InboundImage[];
  tooMany: string[];
  unavailable: string[];
  blocked: string[];
  unscreened: string[];
}> {
  signal?.throwIfAborted();
  const metas: AttachmentMeta[] = [];
  const images: InboundImage[] = [];
  const tooMany: string[] = [];
  const unavailable: string[] = [];
  const blocked: string[] = [];
  const unscreened: string[] = [];
  const usedNames = new Set<string>();
  let imageBytesRemaining = MAX_HISTORY_IMAGE_BYTES;
  for (const [index, a] of attachments.entries()) {
    signal?.throwIfAborted();
    const name = uniqueName(safeAttachmentName(a.name), usedNames);
    usedNames.add(name);
    if (index >= MAX_INBOUND_FILES) {
      tooMany.push(name);
      continue;
    }
    const blob = await transfer.open(a.blobId);
    if (!blob) {
      unavailable.push(name);
      continue;
    }
    let stream = signal ? addAbortSignal(signal, blob.stream) : blob.stream;
    const mimetype = baseMime(a.mimetype || mimeFromName(name));
    let bytes: Buffer | undefined;
    try {
      if (blob.sizeBytes <= MAX_INBOUND_BUFFER_BYTES) {
        bytes = (await collectBytes(stream, { maxBytes: MAX_INBOUND_BUFFER_BYTES })).data;
        const textContent = screenText ? decodeText(bytes, name, mimetype) : null;
        if (screenText && textContent !== null) {
          const verdict = await screenText({ content: textContent, name, mimetype });
          if (verdict?.decision === "strict") {
            blocked.push(name);
            continue;
          }
          if (!verdict || verdict.unscreened) unscreened.push(name);
        }
      } else if (screenText) {
        if (!(await isBinaryStream(stream, name, mimetype))) {
          blocked.push(`${name} (text exceeds the 8 MB security-screen limit)`);
          continue;
        }
        stream.destroy();
        signal?.throwIfAborted();
        const reopened = await transfer.open(a.blobId);
        if (!reopened) {
          unavailable.push(name);
          continue;
        }
        stream = signal ? addAbortSignal(signal, reopened.stream) : reopened.stream;
      }
      signal?.throwIfAborted();
      const id = fileArtifactId(`${register.seed}:${a.blobId}`, "in", 0);
      const path = artifactPath(id, name);
      const { artifact } = await register.store.put({
        id,
        path,
        name,
        mimetype,
        data: bytes ?? stream,
        ownerScopeId: register.ownerScopeId,
        createdBy: register.createdBy,
        createdInScope: register.createdInScope,
        direction: "in",
        maxBytes: MAX_ATTACHMENT_BYTES,
      });
      signal?.throwIfAborted();
      await register.onRegistered?.({
        id: artifact.id,
        path: artifact.path,
        ownerScopeId: artifact.ownerScopeId,
        direction: "in",
      });
      metas.push({
        name: artifact.name,
        mimetype: artifact.mimetype,
        sizeBytes: artifact.sizeBytes,
        direction: "in",
        artifactId: id,
        ...(a.author ? { author: a.author } : {}),
        ...(a.sourceId ? { sourceId: a.sourceId } : {}),
      });
      if (
        bytes &&
        VISION_MIME_TYPES.has(mimetype) &&
        bytes.length > 0 &&
        bytes.length <= Math.min(MAX_VISION_IMAGE_BYTES, imageBytesRemaining)
      ) {
        const dimensions = sniffImageDimensions(bytes);
        if (dimensions && dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) continue;
        const imageBytes = await downscaleVisionImage(bytes, mimetype);
        if (imageBytes.length > imageBytesRemaining) continue;
        imageBytesRemaining -= imageBytes.length;
        images.push({
          name: artifact.name,
          mimeType: artifact.mimetype,
          dataBase64: Buffer.from(imageBytes).toString("base64"),
          artifactId: id,
        });
      }
    } finally {
      stream.destroy();
    }
  }
  return { metas, images, tooMany, unavailable, blocked, unscreened };
}

export async function materializeArtifact(
  files: FileArtifactStore,
  transfer: BlobTransferStore,
  sandbox: Sandbox,
  handle: SandboxHandle,
  ref: { id: string; ownerScopeId: ScopeId; path: string },
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const opened = await files.open(ref.id);
  if (!opened) throw new Error(`File ${path} is no longer available`);
  const stream = signal ? addAbortSignal(signal, opened.stream) : opened.stream;
  try {
    if (opened.artifact.ownerScopeId !== ref.ownerScopeId || opened.artifact.path !== ref.path)
      throw new Error(`File ${path} does not match its authorized reference`);
    if (sandbox.stageIn) {
      const { blobId } = await transfer.put(stream, {
        maxBytes: MAX_ATTACHMENT_BYTES,
        ...(opened.artifact.sha256 ? { expectedSha256: opened.artifact.sha256 } : {}),
      });
      try {
        signal?.throwIfAborted();
        await sandbox.stageIn(handle, path, blobId, { timeoutSec: 60 });
        signal?.throwIfAborted();
      } finally {
        await transfer.delete(blobId).catch(swallowAs("attachments: staged blob cleanup", undefined));
      }
    } else {
      const { data } = await collectBytes(stream, { maxBytes: MAX_INBOUND_BUFFER_BYTES });
      signal?.throwIfAborted();
      await sandbox.writeFileBytes(handle, path, data);
      signal?.throwIfAborted();
    }
  } finally {
    stream.destroy();
  }
}

const DELIVERY_NOTE_PREFIX = "[files delivered to the conversation: ";

export function deliveryNote(manifest: string): string {
  return `${DELIVERY_NOTE_PREFIX}${manifest.replace(/\s+/g, " ").trim()}]`;
}

export function isDeliveryNote(text: string): boolean {
  const t = text.trim();
  return t.startsWith(DELIVERY_NOTE_PREFIX) && t.endsWith("]") && !t.includes("\n");
}

export function deliveryNoteManifest(text: string): string | null {
  if (!isDeliveryNote(text)) return null;
  return text.trim().slice(DELIVERY_NOTE_PREFIX.length, -1);
}

export function legacyDeliveryNoteManifest(text: string): string | null {
  const m = /^\(delivered file\(s\) to the conversation: ([^\n]*)\)$/.exec(text.trim());
  return m ? m[1]! : null;
}

export async function collectNamedOutbound(
  sandbox: Sandbox,
  handle: SandboxHandle,
  paths: readonly string[],
  transfer: BlobTransferStore,
  register?: ArtifactRegistration,
  reservedNames: readonly string[] = [],
): Promise<{
  attachments: OutgoingAttachment[];
  missing: string[];
  empty: string[];
  oversized: string[];
  createdArtifactIds: Set<string>;
}> {
  const invalid = paths.filter(hasParentPathSegment);
  if (invalid.length)
    return { attachments: [], missing: invalid, empty: [], oversized: [], createdArtifactIds: new Set() };
  const attachments: OutgoingAttachment[] = [];
  const missing: string[] = [];
  const empty: string[] = [];
  const oversized: string[] = [];
  const usedNames = new Set<string>(reservedNames);
  const doomed = () => missing.length > 0 || empty.length > 0 || oversized.length > 0;
  const createdArtifactIds = new Set<string>();
  let i = 0;
  for (const p of paths) {
    const bytes = await sandbox.readFileBytes(handle, p);
    if (bytes === null) {
      missing.push(p);
      continue;
    }
    const name = uniqueName(safeAttachmentName(basename(p)), usedNames);
    usedNames.add(name);
    if (bytes.length === 0) {
      empty.push(p);
      continue;
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      oversized.push(p);
      continue;
    }
    if (doomed()) continue;
    const mimetype = mimeFromName(name);
    const { blobId } = await transfer.put(bytes);
    const artifact = register ? await registerArtifact(register, "out", i, name, mimetype, bytes) : undefined;
    if (artifact?.created) createdArtifactIds.add(artifact.id);
    i += 1;
    attachments.push({
      name,
      mimetype,
      sizeBytes: bytes.length,
      blobId,
      ...(artifact ? { artifactId: artifact.id, artifactViewerId: register!.createdBy } : {}),
    });
  }
  if (doomed() && attachments.length) {
    await Promise.all(
      attachments.map(async (a) => {
        await transfer.delete(a.blobId).catch(swallowAs("attachments: rollback blob delete", undefined));
        if (register && a.artifactId && createdArtifactIds.has(a.artifactId)) {
          await register.store.delete(a.artifactId).catch((e) => {
            try {
              register.onError?.(e);
            } catch (err) {
              swallowAs("attachments: rollback onError", undefined)(err);
            }
          });
        }
      }),
    );
    attachments.length = 0;
    createdArtifactIds.clear();
  }
  return { attachments, missing, empty, oversized, createdArtifactIds };
}

export async function discardOutbound(
  attachment: OutgoingAttachment,
  transfer: BlobTransferStore,
  register?: ArtifactRegistration,
  created?: ReadonlySet<string>,
): Promise<void> {
  await transfer.delete(attachment.blobId).catch(swallowAs("attachments: discard blob delete", undefined));
  if (!register || !attachment.artifactId || !created?.has(attachment.artifactId)) return;
  await register.store.delete(attachment.artifactId).catch((e) => {
    try {
      register.onError?.(e);
    } catch (err) {
      swallowAs("attachments: discard onError", undefined)(err);
    }
  });
}
