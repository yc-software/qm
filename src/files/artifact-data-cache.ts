import { LRUCache } from "lru-cache";
import type { FileArtifact } from "./file-artifact-store.ts";

const verifiedData = new LRUCache<string, string>({ maxSize: 64_000_000, sizeCalculation: (data) => data.length });

export async function cachedArtifactData(
  use: "document" | "vision",
  artifact: Pick<FileArtifact, "id" | "sha256">,
  load: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const key = JSON.stringify([use, artifact.id, artifact.sha256]);
  const cached = verifiedData.get(key);
  if (cached !== undefined) return cached;
  const data = await load();
  if (data !== undefined) verifiedData.set(key, data);
  return data;
}
