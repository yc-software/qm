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
  const chatMember = async (id: string) => (await deps.directory.getMany([id, ...personIds(id)])).size > 0;
  const signsIn = async (id: string) => {
    const keys = new Set([id, ...personIds(id)].map(personKey));
    return (await deps.signInMembers()).some((member) => keys.has(personKey(member.principalId)));
  };
  const toWebHome = async (
    input: Parameters<DeliveryStore["enqueue"]>[0],
    recipient: string,
    idempotencyKey: string,
  ) => {
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
      idempotencyKey,
      destination: { type: "web", target: home.threadRef, webTranscript: { kind: "reply" } },
    });
  };
  return {
    ...store,
    async enqueue(input) {
      const { destination } = input;
      if (destination.type !== "principal") return store.enqueue(input);
      const card = destination.webHome === true;
      if (await chatMember(destination.target)) {
        const delivered = await store.enqueue(input);
        if (card) await toWebHome(input, destination.target, `web-home:${input.idempotencyKey}`);
        return delivered;
      }
      if (card || (await signsIn(destination.target)))
        return toWebHome(input, destination.target, input.idempotencyKey);
      return store.enqueue(input);
    },
  };
}
