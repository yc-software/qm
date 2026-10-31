import { readOutgoingAttachment, type SurfaceCoreClient } from "../api/surface-core-client.ts";
import { MAX_BLOB_BYTES } from "../persistence/blob-transfer.ts";
import { swallow } from "../util/errors.ts";
import type { IncomingAttachment, OutgoingAttachment } from "../types.ts";
import type { DiscordAttachmentRef } from "./events.ts";

export const DISCORD_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;
export const DISCORD_MAX_FILES = 10;
export const DISCORD_DOWNLOAD_TIMEOUT_MS = 300_000;
const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const DEFAULT_MIMETYPE = "application/octet-stream";
const MIB = 1024 * 1024;

export interface DiscordFile {
  attachment: Buffer;
  name: string;
}

function onDiscordCdn(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && DISCORD_CDN_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export async function ingestAttachments(
  refs: readonly DiscordAttachmentRef[],
  core: Pick<SurfaceCoreClient, "stageBlob">,
  fetchImpl: typeof fetch = fetch,
): Promise<{ attachments: IncomingAttachment[]; notes: string[] }> {
  const attachments: IncomingAttachment[] = [];
  const notes: string[] = [];
  for (const ref of refs.slice(0, DISCORD_MAX_FILES)) {
    if (!onDiscordCdn(ref.url)) {
      notes.push(`Skipped ${ref.name}: not hosted on Discord.`);
      continue;
    }
    if (ref.size > MAX_BLOB_BYTES) {
      notes.push(`Skipped ${ref.name}: larger than ${Math.floor(MAX_BLOB_BYTES / MIB)} MiB.`);
      continue;
    }
    try {
      const res = await fetchImpl(ref.url, {
        redirect: "error",
        signal: AbortSignal.timeout(DISCORD_DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) {
        notes.push(`Skipped ${ref.name}: download failed (${res.status}).`);
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const { blobId, sizeBytes } = await core.stageBlob(bytes);
      attachments.push({ name: ref.name, mimetype: ref.contentType ?? DEFAULT_MIMETYPE, sizeBytes, blobId });
    } catch (err) {
      swallow(`discord attachment download ${ref.name}`, err);
      notes.push(`Skipped ${ref.name}: download failed.`);
    }
  }
  if (refs.length > DISCORD_MAX_FILES) notes.push(`Only the first ${DISCORD_MAX_FILES} files were read.`);
  return { attachments, notes };
}

export async function toDiscordFiles(
  out: readonly OutgoingAttachment[],
  core: Pick<SurfaceCoreClient, "readBlob" | "readFileArtifact">,
): Promise<{ files: DiscordFile[]; notes: string[] }> {
  const files: DiscordFile[] = [];
  const notes: string[] = [];
  for (const a of out) {
    if (a.sizeBytes > DISCORD_UPLOAD_LIMIT_BYTES) {
      notes.push(
        `${a.name} (${(a.sizeBytes / MIB).toFixed(1)} MiB) is too large for Discord; open it in the QM web app.`,
      );
      continue;
    }
    if (files.length >= DISCORD_MAX_FILES) {
      notes.push(
        `${a.name} was not attached because Discord allows at most ${DISCORD_MAX_FILES} files per message, open it in the QM web app.`,
      );
      continue;
    }
    try {
      const attachment = await readOutgoingAttachment(core, a);
      files.push({ attachment, name: a.name });
    } catch (err) {
      swallow(`discord attachment read ${a.name}`, err);
      notes.push(`${a.name} could not be read; open it in the QM web app.`);
    }
  }
  return { files, notes };
}
