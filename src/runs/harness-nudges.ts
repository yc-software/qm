import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { boundTenant, withTenant } from "../tenants/context.ts";

type HarnessNudge = { kind: "engage"; threadRef: string; tenant: string } | { kind: "poke" };

export interface HarnessNudges {
  engage(threadRef: string): void;
  pokeReaper(): void;
  subscribe(handlers: { engage(threadRef: string): void; poke(): void }): () => void;
  close(): Promise<void>;
}

export function createHarnessNudges(databaseUrl: string): HarnessNudges {
  const bus = createPostgresNotifyBus<HarnessNudge>(databaseUrl, "harness_nudge", "harness-nudge");
  return {
    engage: (threadRef) => {
      const tenant = boundTenant();
      if (tenant) bus.emit({ kind: "engage", threadRef, tenant });
      else console.error("[harness-nudge] dropped an engage nudge emitted with no tenant bound");
    },
    pokeReaper: () => bus.emit({ kind: "poke" }),
    subscribe: (handlers) =>
      bus.subscribe((nudge) =>
        nudge.kind === "engage" ? withTenant(nudge.tenant, () => handlers.engage(nudge.threadRef)) : handlers.poke(),
      ),
    close: async () => {
      await bus.close?.();
    },
  };
}
