import { errMessage } from "../../chassis/src/errors";
import { api } from "./core-bridge";

const RETRY_AFTER_MS = 60_000;
const cache = new Map<string, string | null>();
const failedAt = new Map<string, number>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();

export function onSpeakerAvatars(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function speakerAvatar(principalId: string | undefined): string | undefined {
  if (!principalId) return undefined;
  const hit = cache.get(principalId);
  if (hit !== undefined) return hit ?? undefined;
  if (inflight.has(principalId) || Date.now() - (failedAt.get(principalId) ?? -Infinity) < RETRY_AFTER_MS)
    return undefined;
  inflight.add(principalId);
  void api<{ matches?: Array<{ principalId: string; avatarUrl?: string }> }>(
    `/api/directory/resolve?q=${encodeURIComponent(principalId)}`,
  )
    .then(
      (response) => {
        const url = response.matches?.find((m) => m.principalId === principalId)?.avatarUrl ?? null;
        cache.set(principalId, url);
        failedAt.delete(principalId);
        return url;
      },
      (error: unknown) => {
        failedAt.set(principalId, Date.now());
        console.warn(`Slack avatar lookup failed for ${principalId}: ${errMessage(error)}`);
        return null;
      },
    )
    .then((url) => {
      inflight.delete(principalId);
      if (url) for (const listener of listeners) listener();
    });
  return undefined;
}
