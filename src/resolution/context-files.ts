import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import type { GrantedHandle, ScopeId } from "../types.ts";
import { collectBytes } from "../util/bytes.ts";
import { MAX_LLM_REQUEST_BYTES } from "../core/attachments.ts";

const tooLargeForModel = (name: string, sizeBytes: number) =>
  new Error(
    `shared file ${name} is ${sizeBytes} bytes, more than the ${MAX_LLM_REQUEST_BYTES}-byte model request limit; send it by Files ID or fetch it into a sandbox instead of reading it`,
  );

async function readGrantedArtifactBytes(
  files: FileArtifactStore | undefined,
  ownerScopeId: ScopeId,
  fileId: string,
): Promise<Buffer | null> {
  if (!files) return null;
  const opened = await files.open(fileId);
  if (!opened) return null;
  if (opened.artifact.ownerScopeId !== ownerScopeId) {
    opened.stream.destroy();
    return null;
  }
  if (opened.sizeBytes > MAX_LLM_REQUEST_BYTES) {
    opened.stream.destroy();
    throw tooLargeForModel(opened.artifact.name, opened.sizeBytes);
  }
  const collected = await collectBytes(opened.stream, {
    maxBytes: MAX_LLM_REQUEST_BYTES,
    tooLarge: () => tooLargeForModel(opened.artifact.name, MAX_LLM_REQUEST_BYTES + 1),
  });
  return collected.data;
}

export async function readContextFile(
  path: string,
  handles: readonly GrantedHandle[],
  files?: FileArtifactStore,
  onRead?: (grant: GrantedHandle) => void,
): Promise<{ grant: GrantedHandle; bytes: Uint8Array | null } | { error: string } | null> {
  const matches = handles.filter((grant) => grant.handlePath === path);
  if (!matches.length) return null;
  const distinct = new Set(matches.map((grant) => `${grant.ownerScopeId}\0${grant.fileId}`));
  if (distinct.size > 1)
    return { error: `ERROR: ambiguous shared handle "${path}" maps to ${distinct.size} different files` };
  const grant = matches[0]!;
  const bytes = await readGrantedArtifactBytes(files, grant.ownerScopeId, grant.fileId);
  if (bytes !== null) onRead?.(grant);
  return { grant, bytes };
}
