import { z } from "zod";
import type { OutgoingAttachment } from "../../types.ts";
import { publicFetch, type AddressFetch } from "../../util/network.ts";
import {
  processInboundFiles,
  readOutgoingFiles,
  responseBytes,
  type BlobSource,
  type ProcessedInbound,
} from "../attachments.ts";
import type { PartnerChatClient } from "./client.ts";
import type { PartnerChatFile } from "./protocol.ts";

const TRANSFER_TIMEOUT_MS = 300_000;
export const UPLOAD_FAILED = "I couldn't attach the file(s). Try again in a moment.";

const storageUrl = z.string().startsWith("https://");
const downloadSchema = z.object({ url: storageUrl });
const uploadSchema = z.object({
  file_id: z.string().regex(/^\d{1,20}$/),
  upload: z.object({ url: storageUrl, fields: z.record(z.string(), z.string()) }),
});

async function fetchPartnerChatFile(
  client: PartnerChatClient,
  account: string,
  fileId: string,
  send: AddressFetch = publicFetch,
): Promise<Uint8Array> {
  const { url } = downloadSchema.parse(await client.call(account, "/agent_app/files/url", { file_id: fileId }));
  return responseBytes(await send(url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) }));
}

export function stagePartnerChatFiles(
  client: PartnerChatClient,
  account: string,
  files: readonly PartnerChatFile[],
  stage: (bytes: Uint8Array) => Promise<{ blobId: string }>,
  author?: string,
  send: AddressFetch = publicFetch,
): Promise<ProcessedInbound> {
  return processInboundFiles(
    files.map((f) => ({
      id: f.id,
      name: f.name,
      mimetype: f.content_type,
      ...(f.size_bytes === undefined ? {} : { size: f.size_bytes }),
    })),
    (f) => fetchPartnerChatFile(client, account, f.id, send),
    stage,
    () => author,
  );
}

export async function uploadPartnerChatFiles(
  client: PartnerChatClient,
  account: string,
  chat: string,
  attachments: readonly OutgoingAttachment[],
  blobs: BlobSource,
  send: AddressFetch = publicFetch,
): Promise<string[]> {
  const fileIds: string[] = [];
  for (const { name, mimetype, file } of await readOutgoingFiles(attachments, blobs)) {
    const { file_id, upload } = uploadSchema.parse(
      await client.call(account, "/agent_app/files/upload", {
        chat_id: chat,
        name,
        content_type: mimetype,
        size_bytes: file.length,
      }),
    );
    const form = new FormData();
    for (const [field, value] of Object.entries(upload.fields)) form.append(field, value);
    form.append("file", new Blob([new Uint8Array(file)]), name);
    const res = await send(upload.url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`partner-chat file storage refused ${name}: HTTP ${res.status}`);
    fileIds.push(file_id);
  }
  return fileIds;
}
