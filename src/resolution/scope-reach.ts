import { scopeId, type ScopeId } from "../types.ts";
import type { DirectoryStore } from "../directory/directory-store.ts";
import { isVisible } from "../directory/visibility.ts";

export type ReachResolution =
  | { kind: "ok"; scopeId: ScopeId; channelId: string; channelName: string; isPrivate: boolean }
  | { kind: "error"; message: string };

export async function resolveReachableChannel(
  query: string,
  deps: { directory: DirectoryStore; actorId: string },
): Promise<ReachResolution> {
  const r = await deps.directory.resolveChannel(query);
  if (r.kind === "none") {
    return {
      kind: "error",
      message: `I can't see a channel matching "${query}" — either I'm not in it, or it hasn't synced yet (the channel list refreshes when messages arrive).`,
    };
  }
  if (r.kind === "ambiguous") {
    const names = r.candidates.map((c) => `#${c.name}`).join(", ");
    return { kind: "error", message: `"${query}" matches more than one channel — name one of: ${names}.` };
  }
  const channel = r.channel;
  const isPrivate = channel.isPrivate === true;
  if (!(await isVisible(deps.directory, deps.actorId, { kind: "channel", channelId: channel.channelId, isPrivate }))) {
    const known = await deps.directory.get(deps.actorId);
    return {
      kind: "error",
      message: known
        ? `#${channel.name} is private and I can't confirm you're a member, so I can't go there from here.`
        : `I can't confirm your identity in this workspace — your login may not be linked to Slack — so I can't check whether you're in #${channel.name}. Connecting / signing in with Slack should fix it.`,
    };
  }
  return {
    kind: "ok",
    scopeId: scopeId("channel", channel.channelId),
    channelId: channel.channelId,
    channelName: channel.name,
    isPrivate,
  };
}
