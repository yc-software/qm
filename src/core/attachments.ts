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
import { MAX_BLOB_BYTES, collectBlob, type BlobTransferStore } from "../persistence/blob-transfer.ts";
import { fileArtifactId, type FileArtifactStore, type FileDirection } from "../files/file-artifact-store.ts";
import { parseRef } from "../acl/resource-ref.ts";
import { swallowAs } from "../util/errors.ts";
import { hashId } from "../util/crypto.ts";
import type { SecurityScreenVerdict } from "../security/security-posture.ts";
import { downscaleVisionImage } from "./image-downscale.ts";

export const INBOX_DIR = "inbox";
export const OUTBOX_DIR = "outbox";
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

export function inboundManifest(metas: AttachmentMeta[], inboxDir = INBOX_DIR): string {
  if (!metas.length) return "";
  const list = metas
    .map(
      (m) =>
        `- ${inboxDir}/${m.name} (${m.mimetype}, ${m.sizeBytes} bytes)${m.author ? ` — shared by ${m.author}` : ""}`,
    )
    .join("\n");
  const noun = metas.length === 1 ? "file" : "files";
  const lead = metas.some((m) => m.author)
    ? `${metas.length} ${noun} shared in this conversation, available in ./${inboxDir}/:`
    : `The user shared ${metas.length} ${noun}, available in ./${inboxDir}/:`;
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
      ? `Files received this turn that did not reach ./${INBOX_DIR}/`
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

export async function materializeInbound(
  sandbox: Sandbox,
  handle: SandboxHandle,
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
}> {
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
    await sandbox.writeFileBytes(handle, `${inboxDir}/${name}`, bytes);
    const registered = register
      ? await registerArtifact(register, "in", metas.length, name, mimetype, bytes)
      : undefined;
    metas.push({
      name,
      mimetype,
      sizeBytes: bytes.length,
      direction: "in",
      ...(a.author ? { author: a.author } : {}),
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
  return { metas, images, tooMany, unavailable, blocked, unscreened };
}

export function deliveryManifest(attachments: readonly OutgoingAttachment[]): string {
  return attachments.map((a) => `${a.name} (${a.mimetype}, ${a.sizeBytes} bytes)`).join("; ");
}

export function recentDeliveryNote(history: readonly SessionEntry[]): string {
  const recent: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i]!;
    if (e.type !== "delivery") break;
    const text = (e.payload as { text?: string } | null)?.text;
    if (text) recent.unshift(text);
  }
  if (!recent.length) return "";
  return `For your reference — file(s) you delivered to this conversation in your previous turn: ${recent.join("; ")}`;
}

export async function collectOutbound(
  sandbox: Sandbox,
  handle: SandboxHandle,
  transfer: BlobTransferStore,
  register?: ArtifactRegistration,
  outboxDir = OUTBOX_DIR,
): Promise<{ attachments: OutgoingAttachment[]; oversized: string[]; empty: string[]; dropped: number }> {
  const paths = (await sandbox.listDir(handle, outboxDir)).sort();
  const attachments: OutgoingAttachment[] = [];
  const oversized: string[] = [];
  const empty: string[] = [];
  const usedNames = new Set<string>();
  let dropped = 0;
  for (const rel of paths) {
    if (attachments.length + oversized.length + empty.length >= MAX_OUTBOUND_FILES) {
      dropped++;
      continue;
    }
    const bytes = await sandbox.readFileBytes(handle, rel);
    if (!bytes) continue;
    const name = uniqueName(safeAttachmentName(rel.split(/[\\/]/).pop() ?? rel), usedNames);
    usedNames.add(name);
    if (bytes.length === 0) {
      empty.push(name);
      continue;
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      oversized.push(name);
      continue;
    }
    const mimetype = mimeFromName(name);
    const { blobId } = await transfer.put(bytes);
    const artifact = register
      ? await registerArtifact(register, "out", attachments.length, name, mimetype, bytes)
      : undefined;
    attachments.push({
      name,
      mimetype,
      sizeBytes: bytes.length,
      blobId,
      ...(artifact ? { artifactId: artifact.id, artifactViewerId: register!.createdBy } : {}),
    });
  }
  return { attachments, oversized, empty, dropped };
}

export async function collectNamedOutbound(
  sandbox: Sandbox,
  handle: SandboxHandle,
  paths: readonly string[],
  transfer: BlobTransferStore,
  register?: ArtifactRegistration,
): Promise<{ attachments: OutgoingAttachment[]; missing: string[]; empty: string[]; oversized: string[] }> {
  const invalid = paths.filter(hasParentPathSegment);
  if (invalid.length) return { attachments: [], missing: invalid, empty: [], oversized: [] };
  const attachments: OutgoingAttachment[] = [];
  const missing: string[] = [];
  const empty: string[] = [];
  const oversized: string[] = [];
  const usedNames = new Set<string>();
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
  }
  return { attachments, missing, empty, oversized };
}
