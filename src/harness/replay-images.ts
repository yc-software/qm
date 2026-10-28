import { cachedArtifactData } from "../files/artifact-data-cache.ts";
import type { FileArtifact, FileArtifactStore } from "../files/file-artifact-store.ts";
import { isVisionAttachment, MAX_VISION_IMAGE_BYTES } from "../core/attachments.ts";
import { downscaleVisionImage } from "../core/image-downscale.ts";
import { collectBytes } from "../util/bytes.ts";
import { swallow } from "../util/errors.ts";
import { OMITTED_IMAGE_TEXT, type PiReplayMessage, type ReplayImageRef } from "./replay.ts";

const MAX_HISTORY_IMAGE_BYTES = 10_000_000;

const UNAVAILABLE_IMAGE_TEXT = "[image could not be loaded for replay]";

export const ELIDED_IMAGE_TEXT =
  "[image removed: this conversation's images no longer fit the model's request-size limit; ask for it to be re-shared if needed]";

type LoadedImage = { data: string; sizeBytes: number };
export type ReplayImageLoader = (
  ref: Required<ReplayImageRef>,
  remainingBytes: number,
) => Promise<LoadedImage | "over-budget" | null>;

export function artifactImageLoader(
  files: FileArtifactStore,
  authorize: (artifact: FileArtifact) => boolean | Promise<boolean>,
): ReplayImageLoader {
  return async (ref, remainingBytes) => {
    const artifact = await files.get(ref.artifactId);
    if (
      !artifact ||
      !(await authorize(artifact)) ||
      !isVisionAttachment(artifact) ||
      artifact.mimetype !== ref.mimeType ||
      artifact.sizeBytes <= 0 ||
      !artifact.sha256
    )
      return null;
    if (artifact.sizeBytes > MAX_VISION_IMAGE_BYTES || artifact.sizeBytes > remainingBytes) return "over-budget";
    const data = await cachedArtifactData("vision", artifact, async () => {
      const opened = await files.open(ref.artifactId);
      if (!opened) return undefined;
      if (opened.sizeBytes !== artifact.sizeBytes || opened.artifact.sha256 !== artifact.sha256) {
        opened.stream.destroy();
        return undefined;
      }
      const bytes = await collectBytes(opened.stream, { maxBytes: artifact.sizeBytes });
      if (bytes.sha256 !== artifact.sha256) return undefined;
      return Buffer.from(await downscaleVisionImage(bytes.data, artifact.mimetype)).toString("base64");
    });
    return data === undefined ? null : { data, sizeBytes: artifact.sizeBytes };
  };
}

type ImageBlock = { type: "image"; data: string; mimeType: string };
type TextBlock = { type: "text"; text: string };

export async function restoreReplayImages(
  messages: PiReplayMessage[],
  load: ReplayImageLoader | undefined,
): Promise<PiReplayMessage[]> {
  const restored = new Map<object, ImageBlock | TextBlock>();
  const cached = new Map<string, LoadedImage | "over-budget" | null>();
  let remainingBytes = MAX_HISTORY_IMAGE_BYTES;
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;
    for (const block of [...message.content].reverse()) {
      if (block.type !== "image" || !("ref" in block)) continue;
      const { artifactId, mimeType } = block.ref;
      if (!artifactId || !load) {
        restored.set(block, { type: "text", text: OMITTED_IMAGE_TEXT });
        continue;
      }
      if (!cached.has(artifactId))
        cached.set(
          artifactId,
          remainingBytes > 0
            ? await load({ artifactId, mimeType }, remainingBytes).catch((e: unknown) => {
                swallow("pi: replay image load", e);
                return null;
              })
            : "over-budget",
        );
      const loaded = cached.get(artifactId)!;
      if (loaded === "over-budget") restored.set(block, { type: "text", text: ELIDED_IMAGE_TEXT });
      else if (!loaded) restored.set(block, { type: "text", text: UNAVAILABLE_IMAGE_TEXT });
      else {
        remainingBytes -= loaded.sizeBytes;
        restored.set(block, { type: "image", data: loaded.data, mimeType });
      }
    }
  }
  if (!restored.size) return messages;
  return messages.map((message) =>
    message.role === "user" && message.content.some((block) => restored.has(block))
      ? { ...message, content: message.content.map((block) => restored.get(block) ?? block) }
      : message,
  ) as PiReplayMessage[];
}
