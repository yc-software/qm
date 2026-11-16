import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryEventBus } from "../src/util/event-bus.ts";
import { boundTenant, currentTenant, withoutTenant, withTenant } from "../src/tenants/context.ts";

test("memory bus: resync rings every subscriber's onResync hook and tolerates a throwing one", () => {
  const bus = createMemoryEventBus<string>("t");
  const rung: string[] = [];
  bus.subscribe(() => {}, {
    onResync: () => {
      throw new Error("boom");
    },
  });
  bus.subscribe(() => {}, { onResync: () => void rung.push("b") });
  const off = bus.subscribe(() => {}, { onResync: () => void rung.push("c") });
  assert.equal(bus.size(), 3);
  bus.resync();
  assert.deepEqual(rung, ["b", "c"]);
  off();
  bus.resync();
  assert.deepEqual(rung, ["b", "c", "b"], "an unsubscribed hook is not rung");
  assert.equal(bus.size(), 2);
});

test("memory bus: a subscriber without an onResync hook is skipped by resync", () => {
  const bus = createMemoryEventBus<number>("t");
  const got: number[] = [];
  bus.subscribe((n) => void got.push(n));
  bus.resync();
  bus.emit(1);
  assert.deepEqual(got, [1]);
});

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

test("memory bus: an unbound subscriber runs inside the tenant the event carries", async () => {
  const bus = createMemoryEventBus<{ tenantId?: string }>("t");
  const seen: Array<string | undefined> = [];
  withoutTenant(() => {
    bus.subscribe(async () => {
      await Promise.resolve();
      seen.push(currentTenant());
    });
    bus.subscribe(() => void seen.push(boundTenant()));
    bus.emit({ tenantId: A });
    bus.emit({});
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [A, undefined, A]);
});

test("memory bus: a throwing or rejecting subscriber is swallowed and the rest still run", async () => {
  const bus = createMemoryEventBus<{ tenantId?: string }>("t");
  const got: string[] = [];
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (msg: string) => void warned.push(msg);
  try {
    withoutTenant(() => {
      bus.subscribe(() => {
        throw new Error("sync boom");
      });
      bus.subscribe(async () => {
        throw new Error("async boom");
      });
      bus.subscribe(() => void currentTenant());
      bus.subscribe(() => void got.push("ok"));
    });
    withoutTenant(() => bus.emit({}));
    await new Promise((r) => setImmediate(r));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(got, ["ok"]);
  assert.equal(warned.length, 3);
  assert.ok(warned.every((w) => w.startsWith("[swallowed] t listener: ")));
});

test("memory bus: a tenant-bound subscriber sees its own and tenantless events, bound to its tenant", () => {
  const bus = createMemoryEventBus<{ n: number; tenantId?: string }>("t");
  const got: Array<[number, string | undefined]> = [];
  withTenant(A, () => bus.subscribe((e) => void got.push([e.n, boundTenant()])));
  bus.emit({ n: 1, tenantId: A });
  bus.emit({ n: 2, tenantId: B });
  bus.emit({ n: 3 });
  assert.deepEqual(got, [
    [1, A],
    [3, A],
  ]);
});

test("memory bus: resync runs each hook in its subscriber's tenant and swallows rejections", async () => {
  const bus = createMemoryEventBus<string>("t");
  const rung: Array<string | undefined> = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    withTenant(B, () => bus.subscribe(() => {}, { onResync: () => void rung.push(boundTenant()) }));
    bus.subscribe(() => {}, { onResync: () => Promise.reject(new Error("resync boom")) });
    withoutTenant(() => bus.resync());
    await new Promise((r) => setImmediate(r));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(rung, [B]);
});
