import { isArtifactPath, type FileArtifactStore } from "../files/file-artifact-store.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { GrantedHandle, ScopeId } from "../types.ts";

const MAX_SHARED_ARTIFACT_BYTES = 10 * 1024 * 1024;

async function readGrantedArtifactBytes(
  files: FileArtifactStore | undefined,
  ownerScopeId: ScopeId,
  ownerPath: string,
): Promise<Buffer | null> {
  if (!files) return null;
  const rows = await files.resolveByOwnerPaths([{ ownerScopeId, path: ownerPath }]);
  // Re-assert the tuple: the (owner_scope_id, path) index isn't unique and
  // neither implementation orders results.
  const row = rows.find((r) => r.ownerScopeId === ownerScopeId && r.path === ownerPath);
  if (!row) return null;
  const opened = await files.open(row.id);
  if (!opened) return null;
  // The advertised size can be absent on some backends (fails open at 0), so
  // the collector enforces the cap on actual bytes read.
  if (opened.sizeBytes > MAX_SHARED_ARTIFACT_BYTES) {
    opened.stream.destroy();
    throw new Error(
      `shared file ${ownerPath.split("/").pop()} is ${opened.sizeBytes} bytes — larger than the ${MAX_SHARED_ARTIFACT_BYTES}-byte shared-read limit`,
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of opened.stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > MAX_SHARED_ARTIFACT_BYTES) {
      opened.stream.destroy();
      throw new Error(
        `shared file ${ownerPath.split("/").pop()} exceeds the ${MAX_SHARED_ARTIFACT_BYTES}-byte shared-read limit`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readContextFile(
  path: string,
  handles: readonly GrantedHandle[],
  workspace: Pick<WorkspaceStore, "readBytes">,
  files?: FileArtifactStore,
  onRead?: (grant: GrantedHandle) => void,
): Promise<{ grant: GrantedHandle; bytes: Uint8Array | null } | { error: string } | null> {
  const matches = handles.filter((grant) => grant.handlePath === path);
  if (!matches.length) return null;
  const distinct = new Set(matches.map((grant) => `${grant.ownerScopeId}\0${grant.ownerPath}`));
  if (distinct.size > 1)
    return { error: `ERROR: ambiguous shared handle "${path}" maps to ${distinct.size} different files` };
  const grant = matches[0]!;
  // Artifact and workspace namespaces must not shadow each other with stale snapshots.
  const bytes = isArtifactPath(grant.ownerPath)
    ? await readGrantedArtifactBytes(files, grant.ownerScopeId, grant.ownerPath)
    : await workspace.readBytes(grant.ownerScopeId, grant.ownerPath);
  if (bytes !== null) onRead?.(grant);
  return { grant, bytes };
}
