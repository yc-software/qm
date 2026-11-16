import { z } from "zod";
import type { OutgoingAttachment } from "../../types.ts";
import { errMessage } from "../../util/errors.ts";
import { publicFetch, type AddressFetch } from "../../util/network.ts";
import {
  processInboundFiles,
  readOutgoingFiles,
  responseBytes,
  type BlobSource,
  type ProcessedInbound,
} from "../attachments.ts";
import type { GenericChatClient } from "./client.ts";
import { genericChatMessageIdSchema, type GenericChatFile, type GenericChatRef } from "./protocol.ts";

export interface GenericChatUploads {
  client: GenericChatClient;
  blobs: BlobSource;
  storageFetch?: AddressFetch;
}

const TRANSFER_TIMEOUT_MS = 300_000;
const UPLOAD_FAILED = "I couldn't attach the file(s). Try again in a moment.";

const storageUrl = z.string().startsWith("https://");
const downloadSchema = z.object({ url: storageUrl });
const uploadSchema = z.object({
  file_id: genericChatMessageIdSchema,
  upload: z.object({ url: storageUrl, fields: z.record(z.string(), z.string()) }),
});

async function fetchGenericChatFile(
  client: GenericChatClient,
  account: string,
  fileId: string,
  send: AddressFetch = publicFetch,
): Promise<Uint8Array> {
  const { url } = downloadSchema.parse(await client.call(account, "/agent_app/files/url", { file_id: fileId }));
  return responseBytes(await send(url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) }));
}

export function stageGenericChatFiles(
  client: GenericChatClient,
  account: string,
  files: readonly GenericChatFile[],
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
    (f) => fetchGenericChatFile(client, account, f.id, send),
    stage,
    () => author,
  );
}

async function uploadFiles(
  deps: GenericChatUploads,
  where: Pick<GenericChatRef, "account" | "chat">,
  attachments: readonly OutgoingAttachment[],
): Promise<string[]> {
  const send = deps.storageFetch ?? publicFetch;
  const fileIds: string[] = [];
  for (const { name, mimetype, file } of await readOutgoingFiles(attachments, deps.blobs)) {
    const { file_id, upload } = uploadSchema.parse(
      await deps.client.call(where.account, "/agent_app/files/upload", {
        chat_id: where.chat,
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
    if (!res.ok) throw new Error(`generic-chat file storage refused ${name}: HTTP ${res.status}`);
    fileIds.push(file_id);
  }
  return fileIds;
}

export async function uploadGenericChatFiles(
  deps: GenericChatUploads,
  where: Pick<GenericChatRef, "account" | "chat">,
  attachments: readonly OutgoingAttachment[],
): Promise<{ fileIds?: string[]; failureNote?: string }> {
  try {
    return { fileIds: await uploadFiles(deps, where, attachments) };
  } catch (e) {
    console.error(`[generic-chat] file upload failed in chat ${where.chat}: ${errMessage(e)}`);
    return { failureNote: UPLOAD_FAILED };
  }
}
