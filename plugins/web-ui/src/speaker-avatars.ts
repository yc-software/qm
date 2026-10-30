import { api } from "./core-bridge";

/**
 * Slack avatars for transcript speakers and conversation participants. The directory already
 * stores each member's Slack photo (imported for the inbox); resolve principal ids to it once
 * per page load and notify listeners so the transcript can redraw when a photo lands.
 */
const cache = new Map<string, string | null>();
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
  if (inflight.has(principalId)) return undefined;
  inflight.add(principalId);
  void api<{ matches?: Array<{ principalId: string; avatarUrl?: string }> }>(
    `/api/directory/resolve?q=${encodeURIComponent(principalId)}`,
  )
    .then((r) => {
      const url = r.matches?.find((m) => m.principalId === principalId)?.avatarUrl ?? null;
      cache.set(principalId, url);
      if (url) for (const listener of listeners) listener();
    })
    .catch(() => cache.set(principalId, null))
    .finally(() => inflight.delete(principalId));
  return undefined;
}
