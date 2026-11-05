import { sleep } from "./util.ts";
import { channelShareTs, parseUploadedFileIds, slackErrorCode } from "./payloads.ts";
import { BlobTooLargeError } from "../persistence/blob-transfer.ts";
import type { ByteSource } from "../util/bytes.ts";

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

export interface StagedBlob {
  blobId: string;
  sizeBytes: number;
}

export function attachmentFromStaged(file: SlackFile, staged: StagedBlob, author?: string): IncomingAttachment {
  const name = file.name || file.title || file.id || "file";
  const mimetype = file.mimetype || "application/octet-stream";
  return {
    name,
    mimetype,
    sizeBytes: staged.sizeBytes,
    blobId: staged.blobId,
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

export async function downloadSlackFile(file: SlackFile, opts: DownloadOptions = {}): Promise<ByteSource> {
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
  return res.body ?? new Uint8Array();
}

export interface ProcessedInbound {
  attachments: IncomingAttachment[];
  issues: string[];
}

export async function processInboundFiles(
  files: readonly SlackFile[],
  download: (file: SlackFile) => Promise<ByteSource>,
  stage: (source: ByteSource) => Promise<StagedBlob>,
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
      const staged = await stage(await download(f));
      const author = resolveAuthor ? await resolveAuthor(f.user) : undefined;
      attachments.push(attachmentFromStaged(f, staged, author));
    } catch (err) {
      if (err instanceof BlobTooLargeError) {
        issues.push(oversizeMsg(label));
        continue;
      }
      issues.push(
        `I couldn't read "${label}" — check my file-access permission (files:read) (${(err as Error).message})`,
      );
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
  const e = err as { data?: { needed?: string } };
  const code = slackErrorCode(err) ?? "";
  if (code === "missing_scope" || code === "not_allowed_token_type" || code === "access_denied") {
    const needed = e?.data?.needed ?? "files:write";
    return `⚠️ I couldn't attach the file(s) — check my upload permission (${needed}).`;
  }
  return `⚠️ I couldn't attach the file(s)${code ? ` (Slack said: ${code})` : ""}. Try again in a moment.`;
}
