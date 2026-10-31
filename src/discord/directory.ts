import type { DirectoryMember } from "../directory/directory-store.ts";
import type { ActorAssertion } from "../types.ts";

export const DISCORD_DIRECTORY_SYNC_MS = 300_000;

export interface DirectoryPerson {
  userId: string;
  avatarUrl: string;
}

export interface DirectorySyncDeps {
  ready(): boolean;
  people(): DirectoryPerson[];
  classify(userId: string, fallbackName: string): Promise<ActorAssertion>;
  hold<T>(fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
  push(members: DirectoryMember[]): Promise<void>;
}

export function createDirectorySync(deps: DirectorySyncDeps): () => Promise<void> {
  let running: Promise<void> | null = null;

  async function run(): Promise<void> {
    if (!deps.ready()) return;
    await deps.hold(async (lost) => {
      let leaseLost = false;
      void lost.then(() => {
        leaseLost = true;
      });
      const members: DirectoryMember[] = [];
      for (const person of deps.people()) {
        const actor = await deps.classify(person.userId, person.userId);
        if (actor.isExternalGuest || actor.isBot) continue;
        members.push({
          principalId: actor.externalId,
          displayName: actor.displayName ?? person.userId,
          type: "internal",
          avatarUrl: person.avatarUrl,
        });
      }
      if (!leaseLost) await deps.push(members);
    });
  }

  return () => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };
}
