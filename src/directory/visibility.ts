import type { DirectoryChannel } from "./directory-store.ts";
import { samePerson } from "./person.ts";

export type VisibilityTarget =
  | { kind: "dm"; ownerId: string }
  | { kind: "group"; groupId: string }
  | { kind: "channel"; channelId: string; isPrivate?: boolean };

export interface VisibilityDirectory {
  channelMember(channelId: string, principalId: string): Promise<boolean>;
  groupMember(groupId: string, principalId: string): Promise<boolean>;
  listChannelsFor?(principalId: string): Promise<DirectoryChannel[]>;
}

export async function isVisible(dir: VisibilityDirectory, actorId: string, target: VisibilityTarget): Promise<boolean> {
  switch (target.kind) {
    case "dm":
      return samePerson(actorId, target.ownerId);
    case "group":
      return dir.groupMember(target.groupId, actorId);
    case "channel":
      if (target.isPrivate === true) return dir.channelMember(target.channelId, actorId);
      if (target.isPrivate === false) return true;
      if (!dir.listChannelsFor) return false;
      return (await dir.listChannelsFor(actorId)).some((c) => c.channelId === target.channelId);
  }
}
