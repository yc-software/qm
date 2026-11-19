import type { DeliveryStore } from "./delivery-store.ts";
import type { DirectoryMember, DirectoryStore } from "../directory/directory-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { personIds, personKey } from "../directory/person.ts";
import { scopeId } from "../types.ts";

export function withOffChatRecipients<T extends DeliveryStore>(
  store: T,
  deps: {
    directory: Pick<DirectoryStore, "getMany">;
    sessions: Pick<SessionStore, "getOrCreateByThread" | "addParticipant">;
    signInMembers: () => Promise<DirectoryMember[]>;
  },
): T {
  const webOnly = async (id: string) => {
    const ids = [id, ...personIds(id)];
    if ((await deps.directory.getMany(ids)).size) return false;
    const keys = new Set(ids.map(personKey));
    return (await deps.signInMembers()).some((member) => keys.has(personKey(member.principalId)));
  };
  return {
    ...store,
    async enqueue(input) {
      const { destination } = input;
      if (destination.type !== "principal" || !(await webOnly(destination.target))) return store.enqueue(input);
      const recipient = destination.target;
      const home = await deps.sessions.getOrCreateByThread(
        `web:${recipient}:direct`,
        "dm",
        scopeId("personal", recipient),
        undefined,
        "web",
      );
      await deps.sessions.addParticipant(home.id, recipient);
      return store.enqueue({
        ...input,
        destination: { type: "web", target: home.threadRef, webTranscript: { kind: "reply" } },
      });
    },
  };
}
