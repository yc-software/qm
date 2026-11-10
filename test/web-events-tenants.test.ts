import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { createWebEvents } from "../src/api/routes/web-events.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { boundTenant, currentTenant, withoutTenant, withTenant } from "../src/tenants/context.ts";
import { createMemoryEventBus } from "../src/util/event-bus.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import type { SessionStateEvent } from "../src/runs/session-state-bus.ts";
import type { OwnedLedgerEvent } from "../src/loops/ledger-events.ts";
import type { Delivery } from "../src/types.ts";

await bindBootTenant(async () => undefined);

const [a, b] = [randomUUID(), randomUUID()];

function browser(): ServerResponse & { text(): string } {
  let out = "";
  const handlers: Array<() => void> = [];
  return {
    writeHead: () => undefined,
    write: (chunk: string) => {
      out += chunk;
      return true;
    },
    on: (event: string, fn: () => void) => {
      if (event === "close") handlers.push(fn);
    },
    text: () => out,
  } as unknown as ServerResponse & { text(): string };
}

function hub(pending: Record<string, Delivery[]>, acked: string[]) {
  const states = createMemoryEventBus<SessionStateEvent>("test session-state");
  const ledger = createMemoryEventBus<OwnedLedgerEvent>("test ledger-event");
  const app = {
    pendingDeliveries: async () => pending[boundTenant()!] ?? [],
    ackDelivery: async (id: string) => void acked.push(`${boundTenant()}:${id}`),
    subscribeSessionStates: (cb: (event: SessionStateEvent) => void) =>
      states.subscribe(({ tenantId: _tenant, ...event }) => cb(event)),
    subscribeLedgerEvents: ledger.subscribe,
    membershipControlsScope: async () => false,
    managesScope: async () => false,
    samePerson: () => false,
  };
  return {
    app: app as unknown as Parameters<typeof createWebEvents>[0],
    state: (event: SessionStateEvent) => withoutTenant(() => states.emit(event)),
    ledger: (event: OwnedLedgerEvent) => withoutTenant(() => ledger.emit(event)),
  };
}

const delivery = (id: string, owner: string): Delivery =>
  ({ id, createdAt: Date.now(), destination: { type: "web", target: `web:${owner}:thread` } }) as unknown as Delivery;

test("the same person in two tenants only hears their own tenant's session states and deliveries", async () => {
  const acked: string[] = [];
  const pending = { [a]: [delivery("d-a", "pat")], [b]: [delivery("d-b", "pat")] };
  const fake = hub(pending, acked);
  const events = createWebEvents(fake.app, {
    deliveries: { undeliveredTenants: async () => [a, b].map((tenantId) => ({ tenantId, id: "web" })) },
  });
  withoutTenant(() => events.start());
  try {
    const inA = browser();
    const inB = browser();
    withTenant(a, (t) => events.stream("pat", inA, t));
    withTenant(b, (t) => events.stream("pat", inB, t));
    fake.state({ tenantId: a, threadRef: "web:pat:one", participants: ["pat"], state: "working", at: 1 });
    assert.match(inA.text(), /event: session_state\ndata: .*web:pat:one/);
    assert.doesNotMatch(inB.text(), /web:pat:one/);
    assert.doesNotMatch(inA.text(), /tenantId/);
    const deadline = Date.now() + 10_000;
    while (acked.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(acked.sort(), [`${a}:d-a`, `${b}:d-b`].sort());
    assert.match(inA.text(), /event: delivery/);
    assert.equal(inA.text().match(/event: delivery/g)?.length, 1);
    assert.equal(inB.text().match(/event: delivery/g)?.length, 1);
  } finally {
    await events.stop();
  }
});

test("an inbox event from one tenant never reaches another tenant's browsers", async () => {
  const fake = hub({}, []);
  const looked: Array<string | undefined> = [];
  const events = createWebEvents(fake.app, {
    loops: {
      store: {
        get: async () => {
          looked.push(boundTenant());
          return null;
        },
      },
    } as never,
  });
  withoutTenant(() => events.start());
  try {
    const inB = browser();
    withTenant(b, (t) => events.stream("pat", inB, t));
    fake.ledger({ tenantId: a, loopId: "loop", itemId: "item", owner: "pat" } as OwnedLedgerEvent);
    fake.ledger({ loopId: "loop", itemId: "item", owner: "pat" } as OwnedLedgerEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(looked, []);
    assert.doesNotMatch(inB.text(), /inbox/);
  } finally {
    await events.stop();
  }
});

test("an inbox event emitted outside any tenant binding is forwarded inside the event's tenant", async () => {
  const fake = hub({}, []);
  const events = createWebEvents(fake.app, {
    loops: {
      store: {
        get: async () => {
          throw new Error("loop store unavailable");
        },
      },
    } as never,
  });
  installPrincipalLinks({ canonical: () => (currentTenant(), undefined), aliases: () => [] });
  withoutTenant(() => events.start());
  try {
    const inB = browser();
    withTenant(b, (t) => events.stream("pat", inB, t));
    fake.ledger({ tenantId: b, loopId: "loop", itemId: "item", owner: "pat" } as OwnedLedgerEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(inB.text(), /event: inbox_resync/);
  } finally {
    installPrincipalLinks(null);
    await events.stop();
  }
});
