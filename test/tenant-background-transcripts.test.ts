import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { withWebTranscriptDeliveries } from "../src/delivery/web-transcript-delivery.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresSessionStateBus } from "../src/runs/postgres-session-state-bus.ts";
import type { SessionStateEvent } from "../src/runs/session-state-bus.ts";
import { createTurnMethods } from "../src/api/app-turn.ts";
import { currentTenant, withTenant } from "../src/tenants/context.ts";
import type { ScopeId } from "../src/types.ts";
import { testRuns } from "./support/live-run.ts";
import { describeTwoTenants } from "./support/two-tenants.ts";

const THREAD = "web:alice@example.com:conv-1";
const SCOPE = "personal:alice@example.com" as ScopeId;

describeTwoTenants("cron replies reach each tenant's web conversation and its open tabs without a web poll", (db) => {
  let sessions: ReturnType<typeof createPostgresSessionStore>;
  let inner: ReturnType<typeof createPostgresDeliveryStore>;
  let bus: ReturnType<typeof createPostgresSessionStateBus>;

  before(async () => {
    sessions = createPostgresSessionStore(db.appDatabaseUrl);
    inner = createPostgresDeliveryStore(db.appDatabaseUrl);
    bus = createPostgresSessionStateBus(db.appDatabaseUrl);
  });

  after(async () => {
    await bus?.close?.();
  });

  it("writes each tenant's cron delivery into that tenant's conversation", async () => {
    const deliveries = withWebTranscriptDeliveries(inner, sessions, testRuns(), bus);
    const methods = createTurnMethods(
      { sessionStateBus: bus, sessions } as unknown as Parameters<typeof createTurnMethods>[0],
      {} as Parameters<typeof createTurnMethods>[1],
      {} as Parameters<typeof createTurnMethods>[2],
    );
    const seen = new Map<string, SessionStateEvent[]>();
    const stops = db.tenants.map((tenant) =>
      withTenant(tenant, () => {
        seen.set(tenant, []);
        return methods.subscribeSessionStates((event) => void seen.get(tenant)!.push(event));
      }),
    );
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
    for (let i = 0; i < 200 && [...seen.values()].some((events) => !events.length); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const stop of stops) stop();
    for (const tenant of db.tenants)
      assert.deepEqual(
        seen.get(tenant)!.map(({ threadRef, sessionId, state }) => ({ threadRef, sessionId, state })),
        [{ threadRef: THREAD, sessionId: sessionIds.get(tenant), state: "idle" }],
      );
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
});

describeTwoTenants("live feeds call each subscriber back under its own tenant", (db) => {
  it("a notify from one tenant reaches only that tenant's subscribers, bound to that tenant", async () => {
    const bus = createPostgresSessionStateBus(db.appDatabaseUrl);
    const heard: string[] = [];
    const stops = db.tenants.map((tenant) =>
      withTenant(tenant, () => bus.subscribe((event) => void heard.push(`${event.threadRef} ${currentTenant()}`))),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      withTenant(db.tenants[1], () => bus.emit({ threadRef: "t", state: "idle", at: 1 }));
      for (let i = 0; i < 200 && heard.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      for (const stop of stops) stop();
      await bus.close?.();
    }
    assert.deepEqual(heard, [`t ${db.tenants[1]}`]);
  });
});
