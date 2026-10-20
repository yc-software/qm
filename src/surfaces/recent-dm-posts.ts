import type { DurableMap } from "../persistence/durable-map.ts";

export interface RecentDmPosts {
  posts: Array<{ key: string; text: string; at: number; onBehalfOf?: string; trigger?: string }>;
}

const KEEP = 5;
const NOTE_ITEM_MAX_CHARS = 200;

export async function rememberDmPost(
  map: DurableMap<RecentDmPosts>,
  threadRef: string,
  post: RecentDmPosts["posts"][number],
): Promise<void> {
  await map.mutateMany([
    {
      id: threadRef,
      apply: (current) =>
        current?.posts.some((p) => p.key === post.key)
          ? current
          : { posts: [...(current?.posts ?? []), post].slice(-KEEP) },
    },
  ]);
}

export async function recentPrincipalDeliveryNote(
  map: DurableMap<RecentDmPosts> | undefined,
  threadRef: string,
  since = 0,
): Promise<string> {
  if (!map) return "";
  const recent = ((await map.get(threadRef))?.posts ?? []).filter((p) => p.at > since);
  if (!recent.length) return "";
  const lines = recent.map((p) => {
    const from = p.onBehalfOf ? ` from ${p.onBehalfOf}` : "";
    const trigger = p.trigger ? ` [${p.trigger}]` : "";
    const flattened = p.text.trim().replace(/\s+/g, " ");
    const text = flattened.length > NOTE_ITEM_MAX_CHARS ? `${flattened.slice(0, NOTE_ITEM_MAX_CHARS)}…` : flattened;
    return `- ${new Date(p.at).toISOString()}${trigger}${from}: ${text}`;
  });
  return ["Delivered here since the user's last message (delivery events, not your turns):", ...lines].join("\n");
}
