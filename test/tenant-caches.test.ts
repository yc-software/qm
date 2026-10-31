import assert from "node:assert/strict";
import test from "node:test";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { createDeactivationStore, createIdentityService } from "../src/identity/identity-service.ts";
import { createExternalMemberStore } from "../src/identity/external-members.ts";
import { createPrincipalLinkService, createPrincipalLinkStore } from "../src/identity/principal-links.ts";
import { createEngagedRegistry } from "../src/wake/engaged-registry.ts";
import { createMemorySessionStateBus } from "../src/runs/session-state-bus.ts";
import { createMemoryLedgerEventBus } from "../src/loops/ledger-events.ts";
import {
  createRunStreamBus,
  emitRunText,
  serveRunStreamSync,
  type RunStreamEvent,
} from "../src/runs/run-stream-events.ts";
import { createTurnStream } from "../src/runs/turn-stream.ts";
import { cachedArtifactData } from "../src/files/artifact-data-cache.ts";

import { tenantScopedBus } from "../src/tenants/bus.ts";
import { createMemoryEventBus } from "../src/util/event-bus.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

test("identity roster is cached per tenant", async () => {
  const identity = createIdentityService({
    deactivations: createDeactivationStore(),
    externalMembers: createExternalMemberStore(),
  });
  await withTenant(A, () => identity.deactivate("dana@example.com"));
  await withTenant(B, () => identity.refresh(true));
  assert.equal(
    withTenant(A, () => identity.classify("dana@example.com").type),
    "guest",
  );
  assert.equal(
    withTenant(B, () => identity.classify("dana@example.com").type),
    "internal",
  );
  await withTenant(B, () => identity.deactivate("dana@example.com"));
  await withTenant(A, () => identity.reactivate("dana@example.com"));
  await withTenant(A, () => identity.refresh(true));
  assert.equal(
    withTenant(A, () => identity.classify("dana@example.com").type),
    "internal",
  );
  assert.equal(
    withTenant(B, () => identity.classify("dana@example.com").type),
    "guest",
  );
  assert.throws(() => identity.classify("dana@example.com"), /No tenant is bound/);
});

test("principal links resolve per tenant", async () => {
  const links = createPrincipalLinkService(createPrincipalLinkStore());
  await withTenant(A, () =>
    links.link({ principalId: "U1", canonicalId: "dana@example.com", evidence: "same person", linkedBy: "admin" }),
  );
  await withTenant(B, () => links.refresh(true));
  assert.equal(
    withTenant(A, () => links.canonical("U1")),
    "dana@example.com",
  );
  assert.equal(
    withTenant(B, () => links.canonical("U1")),
    undefined,
  );
  assert.throws(() => links.canonical("U1"), /No tenant is bound/);
});

test("engaged threads are tracked per tenant", () => {
  const engaged = createEngagedRegistry();
  withTenant(A, () => engaged.engage("thread-1"));
  withTenant(B, () => engaged.engage("thread-1"));
  withTenant(A, () => engaged.settle("thread-1"));
  assert.deepEqual(
    withTenant(A, () => engaged.list()),
    [],
  );
  assert.deepEqual(
    withTenant(B, () => engaged.list()),
    ["thread-1"],
  );
  assert.throws(() => engaged.list(), /No tenant is bound/);
});

test("event buses deliver only to subscribers of the emitting tenant", () => {
  const bus = createMemorySessionStateBus();
  const seen: Array<[string, string | undefined]> = [];
  withTenant(A, () => bus.subscribe((e) => seen.push(["a", e.tenant])));
  withTenant(B, () => bus.subscribe((e) => seen.push(["b", e.tenant])));
  withTenant(A, () => bus.emit({ threadRef: "t", state: "idle", at: 1 }));
  assert.deepEqual(seen, [["a", A]]);
  bus.emit({ threadRef: "t", state: "idle", at: 2 });
  assert.deepEqual(seen, [["a", A]]);
  assert.throws(() => bus.subscribe(() => {}), /No tenant is bound/);

  const ledger = createMemoryLedgerEventBus();
  const items: string[] = [];
  withTenant(B, () => ledger.subscribe((e) => items.push(e.itemId)));
  withTenant(A, () => ledger.emit({ loopId: "l", itemId: "a-item", op: "ready", at: 1, owner: "o" }));
  withTenant(B, () => ledger.emit({ loopId: "l", itemId: "b-item", op: "ready", at: 1, owner: "o" }));
  assert.deepEqual(items, ["b-item"]);
});

test("an all-tenant subscriber runs bound to each event's tenant", () => {
  const stream = createRunStreamBus();
  const routed: Array<[string, string | undefined]> = [];
  stream.subscribe((e) => routed.push([e.runId, boundTenant()]), { allTenants: true });
  withTenant(A, () => stream.emit({ runId: "r1", kind: "refresh" }));
  withTenant(B, () => stream.emit({ runId: "r2", kind: "refresh" }));
  assert.deepEqual(routed, [
    ["r1", A],
    ["r2", B],
  ]);
});

test("a subscriber runs bound to its own tenant whatever context delivers the event", () => {
  const inner = createMemoryEventBus<{ n: number; tenant?: string }>("probe");
  const bus = tenantScopedBus(inner);
  const seen: Array<string | undefined> = [];
  withTenant(B, () => bus.subscribe(() => seen.push(boundTenant())));
  withTenant(A, () => inner.emit({ n: 1, tenant: B }));
  inner.emit({ n: 2 });
  assert.deepEqual(seen, [B]);
});

test("a run-stream sync from one tenant never replays another tenant's run text", () => {
  const bus = createRunStreamBus();
  const stream = createTurnStream({
    onDelta: (runId, text, offset, startOffset) => emitRunText(bus, runId, text, offset, startOffset),
  });
  serveRunStreamSync(bus, stream);
  withTenant(A, () => {
    stream.begin("run-a");
    stream.publish("run-a", "secret from tenant a");
  });
  const seenByB: RunStreamEvent[] = [];
  withTenant(B, () => bus.subscribe((e) => seenByB.push(e)));
  withTenant(B, () => bus.emit({ runId: "run-a", kind: "sync", offset: 0 }));
  assert.deepEqual(
    seenByB.filter((e) => e.kind === "delta"),
    [],
  );
  const seenByA: RunStreamEvent[] = [];
  withTenant(A, () => bus.subscribe((e) => seenByA.push(e)));
  withTenant(A, () => bus.emit({ runId: "run-a", kind: "sync", offset: 0 }));
  assert.ok(seenByA.some((e) => e.kind === "delta" && e.text === "secret from tenant a"));
});

test("artifact data cache does not serve another tenant's load", async () => {
  const artifact = { id: "f1", sha256: "abc" };
  assert.equal(await withTenant(A, () => cachedArtifactData("document", artifact, async () => "tenant-a")), "tenant-a");
  assert.equal(await withTenant(B, () => cachedArtifactData("document", artifact, async () => "tenant-b")), "tenant-b");
  await assert.rejects(() => cachedArtifactData("document", artifact, async () => "x"), /No tenant is bound/);
});
