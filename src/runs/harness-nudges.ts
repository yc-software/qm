import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";

type HarnessNudge = { kind: "engage"; threadRef: string } | { kind: "poke" };

export interface HarnessNudges {
  engage(threadRef: string): void;
  pokeReaper(): void;
  subscribe(handlers: { engage(threadRef: string): void; poke(): void }): () => void;
  close(): Promise<void>;
}

export function createHarnessNudges(databaseUrl: string): HarnessNudges {
  const bus = createPostgresNotifyBus<HarnessNudge>(databaseUrl, "harness_nudge", "harness-nudge");
  return {
    engage: (threadRef) => bus.emit({ kind: "engage", threadRef }),
    pokeReaper: () => bus.emit({ kind: "poke" }),
    subscribe: (handlers) =>
      bus.subscribe((nudge) => (nudge.kind === "engage" ? handlers.engage(nudge.threadRef) : handlers.poke())),
    close: async () => {
      await bus.close?.();
    },
  };
}
