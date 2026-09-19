import { randomUUID } from "node:crypto";
import { assertOperationActive, getOperationSignal } from "../util/async.ts";
import { DurableTaskDeferred } from "../durable/tasks.ts";
import { sleep } from "./util.ts";
import { channelShareTs, parseUploadedFileIds, slackErrorCode } from "./payloads.ts";
import { BlobTooLargeError } from "../persistence/blob-transfer.ts";
import type { DeliveryTaskContext } from "../delivery/task-delivery.ts";

export interface IncomingAttachment {
  name: string;
  mimetype: string;
  sizeBytes: number;
  blobId: string;
  sourceId?: string;
  author?: string;
}

export interface OutgoingAttachment {
  name: string;
  mimetype: string;
  sizeBytes: number;
  blobId: string;
  artifactId?: string;
  artifactViewerId?: string;
}

export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  mode?: string;
  user?: string;
}

export async function hydrateSlackFiles(
  files: readonly SlackFile[],
  lookup: (fileId: string) => Promise<SlackFile | undefined>,
): Promise<SlackFile[]> {
  return Promise.all(
    files.map(async (file) => {
      if (!file.id || file.url_private || file.url_private_download) return file;
      try {
        const hydrated = await lookup(file.id);
        return hydrated ? { ...file, ...hydrated, ...(file.user ? { user: file.user } : {}) } : file;
      } catch {
        return file;
      }
    }),
  );
}

export const MAX_ATTACHMENT_BYTES = 1_000_000_000;

export function isOversize(file: Pick<SlackFile, "size">): boolean {
  return typeof file.size === "number" && file.size > MAX_ATTACHMENT_BYTES;
}

export function isTrustedSlackHost(url: string, extraHost?: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "slack.com" || h.endsWith(".slack.com") || (!!extraHost && h === extraHost.toLowerCase());
  } catch {
    return false;
  }
}

export function attachmentFromBytes(
  file: SlackFile,
  bytes: Uint8Array,
  blobId: string,
  author?: string,
): IncomingAttachment {
  const name = file.name || file.title || file.id || "file";
  const mimetype = file.mimetype || "application/octet-stream";
  return {
    name,
    mimetype,
    sizeBytes: bytes.length,
    blobId,
    ...(file.id ? { sourceId: file.id } : {}),
    ...(author ? { author } : {}),
  };
}

export const MAX_ATTACHMENTS_PER_TURN = 10;

const CAP_MB = Math.floor(MAX_ATTACHMENT_BYTES / 1_000_000);
const capLabel = CAP_MB >= 1000 ? `${Math.round(CAP_MB / 1000)} GB` : `${CAP_MB} MB`;
export const oversizeMsg = (label: string): string => `"${label}" is too large — I can handle files up to ~${capLabel}`;

export interface DownloadOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  trustedHost?: string;
}

export async function downloadSlackFile(file: SlackFile, opts: DownloadOptions = {}): Promise<Uint8Array> {
  const url = file.url_private_download || file.url_private;
  if (!url) throw new Error("no url_private");
  if (file.mode === "external" || file.mode === "remote") throw new Error("external/remote files aren't supported");
  if (!isTrustedSlackHost(url, opts.trustedHost)) throw new Error("file is not Slack-hosted; refusing to fetch");
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/html")) throw new Error("got an HTML page (check files:read scope)");
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_ATTACHMENT_BYTES) throw new Error("file too large");
  return new Uint8Array(await res.arrayBuffer());
}

export interface ProcessedInbound {
  attachments: IncomingAttachment[];
  issues: string[];
}

export async function processInboundFiles(
  files: readonly SlackFile[],
  download: (file: SlackFile) => Promise<Uint8Array>,
  stage: (bytes: Uint8Array) => Promise<{ blobId: string }>,
  resolveAuthor?: (userId: string | undefined) => Promise<string | undefined> | string | undefined,
): Promise<ProcessedInbound> {
  const attachments: IncomingAttachment[] = [];
  const issues: string[] = [];
  for (const f of files) {
    const label = f.name || f.title || "that file";
    if (attachments.length >= MAX_ATTACHMENTS_PER_TURN) {
      issues.push(`skipped "${label}" — too many files in one message (max ${MAX_ATTACHMENTS_PER_TURN})`);
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
      const detail =
        err instanceof BlobTooLargeError
          ? "that request was too large — try fewer or smaller files"
          : (err as Error).message;
      issues.push(`I couldn't read "${label}" — check my file-access permission (files:read) (${detail})`);
    }
  }
  return { attachments, issues };
}

export interface UploadClient {
  files: { uploadV2(args: any): Promise<unknown>; info(args: { file: string }): Promise<unknown> };
}

async function waitForShareCommit(client: UploadClient, channel: string, fileId: string): Promise<string | undefined> {
  for (let i = 0; i < 60; i++) {
    let info: unknown;
    try {
      info = await client.files.info({ file: fileId });
    } catch {
      return undefined;
    }
    const ts = channelShareTs(info, channel);
    if (ts) return ts;
    await sleep(250);
  }
  return undefined;
}

interface BlobSource {
  readBlob(blobId: string): Promise<Buffer>;
  readFileArtifact(artifactId: string, viewerId: string): Promise<Buffer>;
}

export async function uploadAttachments(
  client: UploadClient,
  channel: string,
  threadTs: string | undefined,
  attachments: readonly OutgoingAttachment[],
  blobs: BlobSource,
  opts: { initialComment?: string } = {},
): Promise<{ uploaded: boolean; messageTs?: string }> {
  const fileUploads: Array<{ filename: string; file: Buffer }> = [];
  for (const a of attachments) {
    let file: Buffer;
    try {
      file = await blobs.readBlob(a.blobId);
    } catch (err) {
      if (!a.artifactId || !a.artifactViewerId) throw err;
      file = await blobs.readFileArtifact(a.artifactId, a.artifactViewerId);
    }
    if (file.length > 0) fileUploads.push({ filename: a.name, file });
  }
  if (!fileUploads.length) return { uploaded: false };
  const res = await client.files.uploadV2({
    channel_id: channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(opts.initialComment ? { initial_comment: opts.initialComment } : {}),
    file_uploads: fileUploads,
  });
  let messageTs: string | undefined;
  for (const fileId of parseUploadedFileIds(res)) {
    const sharedTs = await waitForShareCommit(client, channel, fileId);
    messageTs ??= sharedTs;
  }
  return { uploaded: true, ...(messageTs ? { messageTs } : {}) };
}

export function uploadFailureNote(err: unknown): string {
  const e = err as { data?: { needed?: string }; message?: string };
  const code = slackErrorCode(err) ?? "";
  const msg = e?.message ?? String(err);
  const isPermission =
    code === "missing_scope" || code === "not_allowed_token_type" || code === "access_denied" || /scope/i.test(msg);
  if (isPermission) {
    const needed = e?.data?.needed ?? "files:write";
    return `⚠️ I couldn't attach the file(s) — check my upload permission (${needed}).`;
  }
  return `⚠️ I couldn't attach the file(s)${code ? ` (Slack said: ${code})` : ""}. Try again in a moment.`;
}

export interface DurableUploadClient {
  files: {
    getUploadURLExternal(input: { filename: string; length: number }): Promise<{
      file_id?: string;
      upload_url?: string;
    }>;
    completeUploadExternal(input: {
      files: Array<{ id: string; title: string }>;
      channel_id: string;
      thread_ts?: string;
    }): Promise<unknown>;
    info(input: { file: string }): Promise<unknown>;
  };
}

export async function uploadDurableAttachment(
  context: DeliveryTaskContext,
  key: string,
  client: DurableUploadClient,
  channel: string,
  threadTs: string | undefined,
  attachment: OutgoingAttachment,
  blobs: BlobSource,
  upload: typeof fetch = fetch,
): Promise<{ fileId: string; messageTs: string }> {
  for (let generation = 0; ; generation++) {
    const attemptKey = generation ? `${key}:retry:${generation}` : key;
    const allocation = await context.step(`${attemptKey}:upload`, async () => {
      let bytes: Buffer;
      try {
        bytes = await blobs.readBlob(attachment.blobId);
      } catch (error) {
        assertOperationActive();
        if (!attachment.artifactId || !attachment.artifactViewerId) throw error;
        bytes = await blobs.readFileArtifact(attachment.artifactId, attachment.artifactViewerId);
      }
      assertOperationActive();
      const allocated = await client.files.getUploadURLExternal({ filename: attachment.name, length: bytes.length });
      if (!allocated.file_id || !allocated.upload_url) throw new Error("Slack did not allocate a file upload");
      assertOperationActive();
      const signal = getOperationSignal();
      const response = await upload(allocated.upload_url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
      });
      if (!response.ok) throw new Error(`Slack file upload failed: ${response.status}`);
      return { fileId: allocated.file_id, completionProtocol: 1 };
    });
    const shared = async () => {
      try {
        assertOperationActive();
        return channelShareTs(await client.files.info({ file: allocation.fileId }), channel);
      } catch (error) {
        if (["file_not_found", "file_deleted"].includes(slackErrorCode(error) ?? "")) return undefined;
        throw error;
      }
    };
    const execution = randomUUID();
    const completionOwner = await context.step(`${attemptKey}:completion-attempt`, async () => execution);
    const completion = await context.step(`${attemptKey}:complete`, async () => {
      const messageTs = await shared();
      if (messageTs) return { expired: false, messageTs };
      try {
        assertOperationActive();
        await client.files.completeUploadExternal({
          files: [{ id: allocation.fileId, title: attachment.name }],
          channel_id: channel,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      } catch (error) {
        const reconciled = await shared();
        if (reconciled) return { expired: false, messageTs: reconciled };
        if (slackErrorCode(error) !== "file_not_found") throw error;
        if (completionOwner === execution && allocation.completionProtocol === 1) return { expired: true };
        throw new SlackUploadPending(allocation.fileId, "completion outcome is uncertain");
      }
      return { expired: false };
    });
    if (completion.expired) {
      if (completionOwner === execution) throw new Error(`Slack upload ${allocation.fileId} expired before completion`);
      continue;
    }
    return context.step(`${attemptKey}:share`, async () => {
      let messageTs = completion.messageTs;
      for (let attempt = 0; !messageTs && attempt < 12; attempt++) {
        messageTs = await shared();
        if (!messageTs) await sleep(250);
      }
      if (!messageTs) throw new SlackUploadPending(allocation.fileId, "share is not visible yet");
      return { fileId: allocation.fileId, messageTs };
    });
  }
}

class SlackUploadPending extends DurableTaskDeferred {
  constructor(fileId: string, reason: string) {
    super(15);
    this.message = `Slack upload ${fileId}: ${reason}; retaining the file for reconciliation`;
  }
}
