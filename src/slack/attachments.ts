import { sleep } from "./util.ts";
import { channelShareTs, parseUploadedFileIds, slackErrorCode } from "./payloads.ts";
import {
  MAX_ATTACHMENTS_PER_TURN,
  processInboundFiles,
  readOutgoingFiles,
  responseBytes,
  type BlobSource,
  type InboundFile,
  type ProcessedInbound,
} from "../surfaces/attachments.ts";
import type { OutgoingAttachment } from "../types.ts";
import { swallow } from "../util/errors.ts";

export interface SlackFile extends InboundFile {
  filetype?: string;
  url_private?: string;
  url_private_download?: string;
  mode?: string;
}

async function hydrateSlackFiles(
  files: readonly SlackFile[],
  lookup: (fileId: string) => Promise<SlackFile | undefined>,
): Promise<SlackFile[]> {
  return Promise.all(
    files.map(async (file) => {
      if (!file.id || file.url_private || file.url_private_download) return file;
      try {
        const hydrated = await lookup(file.id);
        return hydrated ? { ...file, ...hydrated, ...(file.user ? { user: file.user } : {}) } : file;
      } catch (err) {
        swallow(`slack: files.info ${file.id}`, err);
        return file;
      }
    }),
  );
}

export function isTrustedSlackHost(url: string, extraHost?: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "slack.com" || h.endsWith(".slack.com") || (!!extraHost && h === extraHost.toLowerCase());
  } catch {
    return false;
  }
}

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
  if (res.ok && (res.headers.get("content-type") ?? "").includes("text/html"))
    throw new Error("got an HTML page (check files:read scope)");
  return responseBytes(res);
}

export async function stageSlackFiles(
  client: { files: { info(args: { file: string }): Promise<unknown> } },
  files: readonly SlackFile[],
  deps: {
    token: string;
    trustedHost?: string;
    core: { stageBlob(bytes: Uint8Array): Promise<{ blobId: string }> };
    directory: { classifyUserCached(client: any, userId: string): Promise<{ actor: { displayName?: string } }> };
  },
): Promise<ProcessedInbound> {
  const hydrated = await hydrateSlackFiles(
    files.slice(0, MAX_ATTACHMENTS_PER_TURN),
    async (id) => ((await client.files.info({ file: id })) as { file?: SlackFile } | undefined)?.file,
  );
  return processInboundFiles(
    [...hydrated, ...files.slice(MAX_ATTACHMENTS_PER_TURN)],
    (f) => downloadSlackFile(f, { token: deps.token, ...(deps.trustedHost ? { trustedHost: deps.trustedHost } : {}) }),
    (bytes) => deps.core.stageBlob(bytes),
    async (userId) =>
      userId ? (await deps.directory.classifyUserCached(client, userId)).actor.displayName : undefined,
    " — check my file-access permission (files:read)",
  );
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

export async function uploadAttachments(
  client: UploadClient,
  channel: string,
  threadTs: string | undefined,
  attachments: readonly OutgoingAttachment[],
  blobs: BlobSource,
  opts: { initialComment?: string } = {},
): Promise<{ uploaded: boolean; messageTs?: string }> {
  const fileUploads = (await readOutgoingFiles(attachments, blobs)).map(({ name, file }) => ({ filename: name, file }));
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
