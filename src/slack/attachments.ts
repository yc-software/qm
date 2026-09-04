import { sleep } from "./util.ts";
import { messageWithForwardedContent, type SlackMessageAttachment } from "./forwards.ts";

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

export interface ThreadMessage {
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
  subtype?: string;
  files?: SlackFile[];
  attachments?: SlackMessageAttachment[];
}

export function collectEarlierThreadFiles(
  messages: readonly ThreadMessage[],
  opts: { triggerTs: string; botUserId: string; ownBotId: string; have: readonly SlackFile[]; inThread: boolean },
): SlackFile[] {
  if (!opts.inThread) return [];
  const seen = new Set<string>();
  for (const f of opts.have) if (f.id) seen.add(f.id);
  const out: SlackFile[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.ts === opts.triggerTs) continue;
    const isBot = (m.user && m.user === opts.botUserId) || (opts.ownBotId !== "" && m.bot_id === opts.ownBotId);
    if (isBot) continue;
    for (const f of messageWithForwardedContent(m).files) {
      if (f.id && seen.has(f.id)) continue;
      if (f.id) seen.add(f.id);
      out.push(f.user || !m.user ? f : { ...f, user: m.user });
    }
  }
  return out;
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
    let shares: any;
    try {
      shares = ((await client.files.info({ file: fileId })) as any)?.file?.shares ?? {};
    } catch {
      return undefined;
    }
    const here = [...(shares.public?.[channel] ?? []), ...(shares.private?.[channel] ?? [])];
    const shared = here.find((share: any) => share?.ts);
    if (shared?.ts) return String(shared.ts);
    await sleep(250);
  }
  return undefined;
}

function uploadedFileIds(response: any): string[] {
  const files = response?.file ? [response.file] : (response?.files ?? []);
  return files.flatMap((entry: any) => {
    if (entry?.id) return [String(entry.id)];
    return (entry?.files ?? []).flatMap((file: any) => (file?.id ? [String(file.id)] : []));
  });
}

export async function uploadAttachments(
  client: UploadClient,
  channel: string,
  threadTs: string | undefined,
  attachments: readonly OutgoingAttachment[],
  fetchBlob: (blobId: string) => Promise<Buffer>,
  fetchArtifact?: (artifactId: string, viewerId: string) => Promise<Buffer>,
  opts: { initialComment?: string } = {},
): Promise<{ uploaded: boolean; messageTs?: string }> {
  const fileUploads: Array<{ filename: string; file: Buffer }> = [];
  for (const attachment of attachments) {
    let file: Buffer;
    try {
      file = await fetchBlob(attachment.blobId);
    } catch (err) {
      if (!fetchArtifact || !attachment.artifactId || !attachment.artifactViewerId) throw err;
      file = await fetchArtifact(attachment.artifactId, attachment.artifactViewerId);
    }
    if (file.length > 0) fileUploads.push({ filename: attachment.name, file });
  }
  if (!fileUploads.length) return { uploaded: false };

  const response = await client.files.uploadV2({
    channel_id: channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(opts.initialComment ? { initial_comment: opts.initialComment } : {}),
    file_uploads: fileUploads,
  });
  let messageTs: string | undefined;
  for (const fileId of uploadedFileIds(response)) {
    const sharedTs = await waitForShareCommit(client, channel, fileId);
    messageTs ??= sharedTs;
  }
  return { uploaded: true, ...(messageTs ? { messageTs } : {}) };
}

export function uploadFailureNote(err: unknown): string {
  const e = err as { data?: { error?: string; needed?: string }; message?: string };
  const code = e?.data?.error ?? "";
  const msg = e?.message ?? String(err);
  const isPermission =
    code === "missing_scope" || code === "not_allowed_token_type" || code === "access_denied" || /scope/i.test(msg);
  if (isPermission) {
    const needed = e?.data?.needed ?? "files:write";
    return `⚠️ I couldn't attach the file(s) — check my upload permission (${needed}). (${msg})`;
  }
  return `⚠️ I couldn't attach the file(s): ${msg}`;
}
