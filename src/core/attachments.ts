import type { Readable } from "node:stream";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { AttachmentMeta, GrantedHandle, IncomingAttachment, OutgoingAttachment, ScopeId } from "../types.ts";
import { hasParentPathSegment, type Sandbox, type SandboxHandle } from "../sandbox/sandbox.ts";
import {
  MAX_BLOB_BYTES,
  BlobTooLargeError,
  collectBlob,
  type BlobTransferStore,
} from "../persistence/blob-transfer.ts";
import { fileArtifactId, type FileArtifactStore, type FileDirection } from "../files/file-artifact-store.ts";
import { swallowAs } from "../util/errors.ts";
import { fileContentRequest } from "./document-kinds.ts";
import { hashId } from "../util/crypto.ts";
import type { SecurityScreenVerdict } from "../security/security-posture.ts";
import { downscaleVisionImage } from "./image-downscale.ts";
import { NoDefaultSandboxError } from "../sandbox/sandbox-routing.ts";
import { isUserMessage, type Item } from "../sessions/items.ts";

export const INBOX_DIR = "inbox";
export const TURN_FILES_DIR = ".agent-turn";

export function turnFileId(runId?: string, attempt = 1, now = Date.now()): string {
  return `${now.toString(36)}-${hashId([runId ?? randomUUID(), String(attempt)], 24)}`;
}

export const MAX_ATTACHMENT_BYTES = MAX_BLOB_BYTES;

const VISION_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const MAX_VISION_IMAGE_BYTES = 5_000_000;

export const MAX_LLM_REQUEST_BYTES = 18_000_000;

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
  contextEntries: readonly Item[],
): IncomingAttachment[] {
  const seen = new Set<string>();
  for (const entry of contextEntries) {
    if (!isUserMessage(entry)) continue;
    const metas = entry.body.attachments;
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

export function inboundManifest(metas: AttachmentMeta[], inboxDir = INBOX_DIR, unstaged?: Set<string>): string {
  if (!metas.length) return "";
  const list = metas
    .map(
      (m) =>
        `- ${inboxDir}/${m.name} (${m.mimetype}, ${m.sizeBytes} bytes)${m.author ? ` — shared by ${m.author}` : ""}${
          unstaged?.has(m.name)
            ? ` — saved as file ${m.artifactId}, not yet on a computer (no default sandbox); send it directly with {file_id: "${m.artifactId}"}; if you need it on disk, choose a sandbox_id for execute and download ${fileContentRequest(m.artifactId!)} to a path you choose`
            : ""
        }`,
    )
    .join("\n");
  const noun = metas.length === 1 ? "file" : "files";
  const where = unstaged?.size ? `for ./${inboxDir}/` : `available in ./${inboxDir}/`;
  const lead = metas.some((m) => m.author)
    ? `${metas.length} ${noun} shared in this conversation, ${where}:`
    : `The user shared ${metas.length} ${noun}, ${where}:`;
  return `${lead}\n${list}`;
}

export function inboundIssuesNote(issues: readonly string[]): string {
  return issues.length ? `Files received this turn that did not reach ./${INBOX_DIR}/: ${issues.join("; ")}` : "";
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

export function sharedManifest(handles: readonly GrantedHandle[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const h of handles) {
    if (seen.has(h.handlePath)) continue;
    seen.add(h.handlePath);
    lines.push(`- ${h.handlePath}${h.permission === "write" ? " (writable)" : ""}`);
  }
  if (!lines.length) return "";
  const total = lines.length;
  const shown = lines.sort().slice(0, MAX_SHARED_FILES_LISTED);
  const omitted = total - shown.length;
  if (omitted > 0) {
    shown.push(`…and ${omitted} more (read shared/<name> to fetch)`);
  }
  const noun = total === 1 ? "file" : "files";
  return `${total} ${noun} shared with you — read a path below to fetch that file on demand:\n${shown.join("\n")}`;
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

export async function materializeInbound(
  sandbox: Sandbox,
  handle: SandboxHandle | (() => Promise<SandboxHandle>),
  attachments: IncomingAttachment[],
  transfer: BlobTransferStore,
  register?: ArtifactRegistration,
  inboxDir = INBOX_DIR,
  screenText?: (input: {
    content: string;
    name: string;
    mimetype: string;
  }) => Promise<SecurityScreenVerdict | undefined>,
): Promise<{
  metas: AttachmentMeta[];
  images: InboundImage[];
  tooMany: string[];
  unavailable: string[];
  blocked: string[];
  unscreened: string[];
  unstaged?: Set<string>;
}> {
  let target: Promise<SandboxHandle | null> | undefined;
  const computer = () =>
    (target ??= (typeof handle === "function" ? handle() : Promise.resolve(handle)).catch((e: unknown) => {
      if (e instanceof NoDefaultSandboxError) return null;
      throw e;
    }));
  const unstaged = new Set<string>();
  const metas: AttachmentMeta[] = [];
  const images: InboundImage[] = [];
  const tooMany: string[] = [];
  const unavailable: string[] = [];
  const blocked: string[] = [];
  const unscreened: string[] = [];
  const usedNames = new Set<string>();
  for (const a of attachments) {
    if (metas.length >= MAX_INBOUND_FILES) {
      tooMany.push(safeAttachmentName(a.name));
      continue;
    }
    const blob = await transfer.open(a.blobId);
    if (!blob) {
      unavailable.push(safeAttachmentName(a.name));
      continue;
    }
    const bytes = await collectBlob(blob.stream);
    const name = uniqueName(safeAttachmentName(a.name), usedNames);
    usedNames.add(name);
    const mimetype = baseMime(a.mimetype || mimeFromName(name));
    const textContent = screenText ? decodeText(bytes, name, mimetype) : null;
    if (screenText && textContent !== null) {
      const verdict = await screenText({ content: textContent, name, mimetype });
      if (verdict?.decision === "strict") {
        blocked.push(name);
        continue;
      }
      if (!verdict || verdict.unscreened) unscreened.push(name);
    }
    const box = await computer();
    if (box) await sandbox.writeFileBytes(box, `${inboxDir}/${name}`, bytes);
    const registered = register
      ? await registerArtifact(register, "in", metas.length, name, mimetype, bytes)
      : undefined;
    if (!box) {
      if (!registered) {
        unavailable.push(name);
        continue;
      }
      unstaged.add(name);
    }
    metas.push({
      name,
      mimetype,
      sizeBytes: bytes.length,
      direction: "in",
      ...(a.author ? { author: a.author } : {}),
      ...(a.sourceId ? { sourceId: a.sourceId } : {}),
      ...(registered ? { artifactId: registered.id } : {}),
    });
    if (VISION_MIME_TYPES.has(mimetype) && bytes.length > 0 && bytes.length <= MAX_VISION_IMAGE_BYTES) {
      const imageBytes = await downscaleVisionImage(bytes, mimetype);
      images.push({
        name,
        mimeType: mimetype,
        dataBase64: Buffer.from(imageBytes).toString("base64"),
        ...(registered ? { artifactId: registered.id } : {}),
      });
    }
  }
  return { metas, images, tooMany, unavailable, blocked, unscreened, ...(unstaged.size ? { unstaged } : {}) };
}

const DELIVERY_NOTE_PREFIX = "[files delivered to the conversation: ";

export function deliveryNote(manifest: string): string {
  return `${DELIVERY_NOTE_PREFIX}${manifest.replace(/\s+/g, " ").trim()}]`;
}

export function isDeliveryNote(text: string): boolean {
  const t = text.trim();
  return t.startsWith(DELIVERY_NOTE_PREFIX) && t.endsWith("]") && !t.includes("\n");
}

export type OutboundFile = string | { file_id: string };

export type OpenStoredFile = (id: string) => Promise<{
  name: string;
  mimetype: string;
  sizeBytes: number;
  stream: Readable;
} | null>;

export function parseOutboundFiles(
  value: unknown,
): { ok: true; files: OutboundFile[] } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, files: [] };
  if (
    !Array.isArray(value) ||
    value.some((file) =>
      typeof file === "string"
        ? !file.trim()
        : !file ||
          typeof file !== "object" ||
          Array.isArray(file) ||
          Object.keys(file).length !== 1 ||
          typeof file.file_id !== "string" ||
          !file.file_id.trim(),
    )
  )
    return { ok: false, message: 'files must be workspace path strings or {file_id: "stored Files ID"} objects' };
  if (value.length > MAX_OUTBOUND_FILES) return { ok: false, message: `too many files (max ${MAX_OUTBOUND_FILES})` };
  if (value.some((file) => typeof file === "string" && hasParentPathSegment(file)))
    return { ok: false, message: "files must stay inside the workspace — no .. path segments" };
  return {
    ok: true,
    files: value.map((file) => (typeof file === "string" ? file.trim() : { file_id: file.file_id.trim() })),
  };
}

export async function collectNamedOutbound(
  sandbox: Sandbox | undefined,
  handle: SandboxHandle | (() => Promise<SandboxHandle>),
  paths: readonly OutboundFile[],
  transfer: BlobTransferStore,
  register?: ArtifactRegistration,
  reservedNames: readonly string[] = [],
  openStored?: OpenStoredFile,
): Promise<{
  attachments: OutgoingAttachment[];
  missing: string[];
  empty: string[];
  oversized: string[];
  createdArtifactIds: Set<string>;
}> {
  const parsed = parseOutboundFiles(paths);
  if (!parsed.ok) throw new Error(parsed.message);
  const attachments: OutgoingAttachment[] = [];
  const missing: string[] = [];
  const empty: string[] = [];
  const oversized: string[] = [];
  const usedNames = new Set<string>(reservedNames);
  const doomed = () => missing.length > 0 || empty.length > 0 || oversized.length > 0;
  const createdArtifactIds = new Set<string>();
  const rollback = async () => {
    await Promise.all(attachments.map((a) => discardOutbound(a, transfer, register, createdArtifactIds)));
    attachments.length = 0;
    createdArtifactIds.clear();
  };
  let target: SandboxHandle | undefined;
  try {
    for (const [i, file] of parsed.files.entries()) {
      const storedId = typeof file === "string" ? undefined : file.file_id;
      const label = typeof file === "string" ? file : file.file_id;
      let bytes: Uint8Array | undefined;
      let stored: Awaited<ReturnType<OpenStoredFile>> = null;
      if (typeof file === "string") {
        if (!sandbox) throw new Error("sandbox file access is not available");
        target ??= typeof handle === "function" ? await handle() : handle;
        bytes = (await sandbox.readFileBytes(target, file)) ?? undefined;
      } else {
        stored = (await openStored?.(file.file_id)) ?? null;
      }
      if (!bytes && !stored) {
        missing.push(label);
        continue;
      }
      const sizeBytes = stored?.sizeBytes ?? bytes!.length;
      if (sizeBytes === 0) empty.push(label);
      if (sizeBytes > MAX_ATTACHMENT_BYTES) oversized.push(label);
      if (doomed()) {
        stored?.stream.destroy();
        continue;
      }
      const name = uniqueName(safeAttachmentName(stored?.name ?? label), usedNames);
      usedNames.add(name);
      const mimetype = stored?.mimetype || mimeFromName(name);
      let blob;
      try {
        blob = await transfer.put(stored?.stream ?? bytes!, { maxBytes: MAX_ATTACHMENT_BYTES });
      } catch (error) {
        if (!(error instanceof BlobTooLargeError)) throw error;
        oversized.push(label);
        continue;
      } finally {
        stored?.stream.destroy();
      }
      const attachment: OutgoingAttachment = { name, mimetype, sizeBytes: blob.sizeBytes, blobId: blob.blobId };
      attachments.push(attachment);
      if (blob.sizeBytes === 0) {
        empty.push(label);
        continue;
      }
      let artifact;
      if (storedId) artifact = { id: storedId, created: false };
      else if (register) artifact = await registerArtifact(register, "out", i, name, mimetype, bytes!);
      if (artifact?.created) createdArtifactIds.add(artifact.id);
      if (artifact) {
        attachment.artifactId = artifact.id;
        if (register) attachment.artifactViewerId = register.createdBy;
      }
    }
    if (doomed()) await rollback();
    return { attachments, missing, empty, oversized, createdArtifactIds };
  } catch (error) {
    await rollback();
    throw error;
  }
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
