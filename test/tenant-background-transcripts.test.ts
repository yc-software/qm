import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { withWebTranscriptDeliveries } from "../src/delivery/web-transcript-delivery.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { withTenant, withoutTenant } from "../src/tenants/context.ts";
import type { ScopeId } from "../src/types.ts";
import { testRuns } from "./support/live-run.ts";
import { twoTenants, type TwoTenants } from "./support/two-tenants.ts";

const THREAD = "web:alice@example.com:conv-1";
const SCOPE = "personal:alice@example.com" as ScopeId;

withoutTenant(() =>
  describe("cron replies reach each tenant's web conversation without a web poll", () => {
    let db: TwoTenants;
    let sessions: ReturnType<typeof createPostgresSessionStore>;
    let inner: ReturnType<typeof createPostgresDeliveryStore>;

    before(async () => {
      db = await twoTenants();
      sessions = createPostgresSessionStore(db.appDatabaseUrl);
      inner = createPostgresDeliveryStore(db.appDatabaseUrl);
    });

    after(async () => {
      await db?.close();
    });

    it("writes each tenant's cron delivery into that tenant's conversation", async () => {
      const deliveries = withWebTranscriptDeliveries(inner, sessions, testRuns());
      const sessionIds = new Map<string, string>();
      for (const [tenant, text] of [
        [db.tenants[0], "reminder for A"],
        [db.tenants[1], "reminder for B"],
      ] as const)
        await withTenant(tenant, async () => {
          const session = await sessions.getOrCreateByThread(THREAD, "dm", SCOPE, undefined, "web");
          sessionIds.set(tenant, session.id);
          await deliveries.enqueue({
            destination: { type: "web", target: THREAD, audienceScopeId: SCOPE },
            text,
            idempotencyKey: `agent:main:cron:c1:${tenant}`,
            provenance: {
              trigger: "cron",
              surface: "cron",
              fireKey: `agent:main:cron:c1:${tenant}`,
              sourceScopeId: SCOPE,
              sourceThreadRef: "agent:main:cron:c1",
              sourceSessionId: "cron-session",
            },
          });
        });
      await deliveries.transcribeUndelivered("web");
      for (const [tenant, text] of [
        [db.tenants[0], "reminder for A"],
        [db.tenants[1], "reminder for B"],
      ] as const)
        await withTenant(tenant, async () => {
          const items = await sessions.getItems(sessionIds.get(tenant)!);
          assert.deepEqual(
            items.map((item) => item.text),
            [text],
          );
        });
    });
  }),
);
