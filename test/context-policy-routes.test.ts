import assert from "node:assert/strict";
import { test } from "node:test";
import { getContextPolicy, setContextPolicy } from "../src/api/routes/context-policy.ts";
import { createMemoryChannelPolicyStore } from "../src/surface-cache/channel-policy-store.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

function fakeRes() {
  const out = { status: 0, body: undefined as unknown };
  return {
    res: {
      writeHead(status: number) {
        out.status = status;
        return this;
      },
      end(data?: string) {
        out.body = data ? JSON.parse(data) : undefined;
      },
    } as unknown as ApiCtx["res"],
    out,
  };
}

function makeCtx(over: {
  url?: string;
  body?: unknown;
  contexts?: string[];
  store?: ReturnType<typeof createMemoryChannelPolicyStore>;
}): {
  ctx: ApiCtx;
  out: { status: number; body: unknown };
  store: ReturnType<typeof createMemoryChannelPolicyStore>;
  audits: unknown[];
} {
  const { res, out } = fakeRes();
  const store = over.store ?? createMemoryChannelPolicyStore();
  const audits: unknown[] = [];
  const ctx = {
    res,
    url: new URL(over.url ?? "http://x/v1/contexts/policy"),
    body: over.body,
    params: {},
    app: {
      listContexts: async () => (over.contexts ?? []).map((scopeId) => ({ scopeId })),
    },
    deps: {
      channelPolicy: store,
      auditLog: { record: (e: unknown) => audits.push(e) },
    },
  } as unknown as ApiCtx;
  return { ctx, out, store, audits };
}

test("context policy read requires membership and a Slack-backed scope", async () => {
  const member = makeCtx({
    url: "http://x/v1/contexts/policy?principalId=alice&scope=channel:C1",
    contexts: ["channel:C1"],
  });
  await member.store.set("C1", "flag launches", { setBy: "someone", bots: { "Noisy Bot": { mode: "ignore" } } });
  await getContextPolicy(member.ctx);
  assert.equal(member.out.status, 200);
  const policy = (member.out.body as { policy: { orders: string; bots: Record<string, { mode: string }> } }).policy;
  assert.equal(policy.orders, "flag launches");
  assert.equal(policy.bots["Noisy Bot"]!.mode, "ignore");

  const outsider = makeCtx({ url: "http://x/v1/contexts/policy?principalId=mallory&scope=channel:C1", contexts: [] });
  await getContextPolicy(outsider.ctx);
  assert.equal(outsider.out.status, 403);

  const personal = makeCtx({
    url: "http://x/v1/contexts/policy?principalId=alice&scope=personal:alice",
    contexts: ["personal:alice"],
  });
  await getContextPolicy(personal.ctx);
  assert.equal(personal.out.status, 400);
});

test("context policy write validates the ledger, persists, and audits", async () => {
  const { ctx, out, store } = makeCtx({
    contexts: ["channel:C2"],
    body: {
      principalId: "alice",
      scope: "channel:C2",
      orders: "watch for deploy failures",
      bots: { "General Agent": { mode: "rollup", rollupHours: 4 } },
    },
  });
  await setContextPolicy(ctx);
  assert.equal(out.status, 200);
  const stored = await store.get("C2");
  assert.equal(stored?.orders, "watch for deploy failures");
  assert.deepEqual(stored?.bots["General Agent"], { mode: "rollup", rollupHours: 4 });
  assert.equal(stored?.setBy, "alice");

  const bad = makeCtx({
    contexts: ["channel:C2"],
    store,
    body: { principalId: "alice", scope: "channel:C2", orders: "", bots: { "General Agent": { mode: "sometimes" } } },
  });
  await setContextPolicy(bad.ctx);
  assert.equal(bad.out.status, 400);

  const outsider = makeCtx({
    contexts: [],
    store,
    body: { principalId: "mallory", scope: "channel:C2", orders: "", bots: {} },
  });
  await setContextPolicy(outsider.ctx);
  assert.equal(outsider.out.status, 403);
  assert.equal((await store.get("C2"))?.orders, "watch for deploy failures");
});

test("ambientEnabled round-trips through the member route and rejects non-booleans", async () => {
  const store = createMemoryChannelPolicyStore();
  const off = makeCtx({
    contexts: ["channel:C5"],
    store,
    body: { principalId: "alice", scope: "channel:C5", orders: "", bots: {}, ambientEnabled: false },
  });
  await setContextPolicy(off.ctx);
  assert.equal(off.out.status, 200);
  assert.equal((off.out.body as any).policy.ambientEnabled, false);
  assert.equal((await store.get("C5"))?.ambientEnabled, false);

  const read = makeCtx({
    url: "http://x/v1/contexts/policy?principalId=alice&scope=channel:C5",
    contexts: ["channel:C5"],
    store,
  });
  await getContextPolicy(read.ctx);
  assert.equal((read.out.body as any).policy.ambientEnabled, false);

  const bad = makeCtx({
    contexts: ["channel:C5"],
    store,
    body: { principalId: "alice", scope: "channel:C5", orders: "", bots: {}, ambientEnabled: "nope" },
  });
  await setContextPolicy(bad.ctx);
  assert.equal(bad.out.status, 400);
  assert.equal((await store.get("C5"))?.ambientEnabled, false, "a rejected write changes nothing");

  const cleared = makeCtx({
    contexts: ["channel:C5"],
    store,
    body: { principalId: "alice", scope: "channel:C5", orders: "", bots: {}, ambientEnabled: null },
  });
  await setContextPolicy(cleared.ctx);
  assert.equal(cleared.out.status, 200);
  assert.equal((cleared.out.body as any).policy.ambientEnabled, null, "null clears back to the default rule");
  assert.equal((await store.get("C5"))?.ambientEnabled, undefined);
});

test("a stale baseUpdatedAt bounces instead of reverting a concurrent edit", async () => {
  const store = createMemoryChannelPolicyStore();
  await store.set("C3", "v1", { setBy: "agent" });
  const current = await store.get("C3");
  const stale = makeCtx({
    contexts: ["channel:C3"],
    store,
    body: {
      principalId: "alice",
      scope: "channel:C3",
      orders: "v2",
      bots: {},
      baseUpdatedAt: (current?.updatedAt ?? 0) - 1,
    },
  });
  await setContextPolicy(stale.ctx);
  assert.equal(stale.out.status, 409);
  assert.equal((await store.get("C3"))?.orders, "v1");

  const fresh = makeCtx({
    contexts: ["channel:C3"],
    store,
    body: { principalId: "alice", scope: "channel:C3", orders: "v2", bots: {}, baseUpdatedAt: current?.updatedAt ?? 0 },
  });
  await setContextPolicy(fresh.ctx);
  assert.equal(fresh.out.status, 200);
  assert.equal((await store.get("C3"))?.orders, "v2");
});

for (const scope of [
  "group:web-project-317",
  "group:web-project-",
  "group:web-project-invalid:tail",
  "channel:C317",
  "group:G317",
]) {
  test(`policy applicability and orders-only saves preserve legacy options: ${scope}`, async () => {
    const ref = scope.slice(scope.indexOf(":") + 1);
    const store = createMemoryChannelPolicyStore();
    const bots = { CI: { mode: "action" as const } };
    await store.set(ref, "before", { bots, ambientEnabled: true });
    const before = await store.get(ref);
    const history = await store.history(ref);
    const supportsAmbient = !scope.startsWith("group:web-project-");
    const read = makeCtx({
      store,
      contexts: [scope],
      url: `http://x/v1/contexts/policy?principalId=alice&scope=${scope}`,
    });
    await getContextPolicy(read.ctx);
    assert.equal(read.out.status, 200);
    assert.equal((read.out.body as any).policy.supportsAmbient, supportsAmbient);
    const write = makeCtx({
      store,
      contexts: [scope],
      body: { principalId: "alice", scope, orders: "after", baseUpdatedAt: before!.updatedAt },
    });
    await setContextPolicy(write.ctx);
    assert.equal(write.out.status, 200);
    assert.equal((write.out.body as any).policy.supportsAmbient, supportsAmbient);
    assert.equal((await store.get(ref))!.orders, "after");
    assert.equal((await store.get(ref))!.ambientEnabled, true);
    assert.deepEqual((await store.get(ref))!.bots, supportsAmbient ? {} : bots);
    assert.equal(write.audits.length, 1);
    assert.deepEqual((await store.history(ref)).slice(1), history);
  });
}

for (const field of [
  { ambientEnabled: true },
  { ambientEnabled: false },
  { ambientEnabled: null },
  { ambientEnabled: {} },
  { bots: {} },
  { bots: null },
  { bots: { CI: { mode: "action" } } },
]) {
  test(`project policy rejects supplied fields atomically: ${JSON.stringify(field)}`, async () => {
    const scope = "group:web-project-317";
    const ref = "web-project-317";
    const store = createMemoryChannelPolicyStore();
    await store.set(ref, "keep", { ambientEnabled: false, bots: { CI: { mode: "ignore" } } });
    const before = await store.get(ref);
    const history = await store.history(ref);
    for (const orders of ["do not write this", undefined]) {
      const c = makeCtx({
        store,
        contexts: [scope],
        body: { principalId: "alice", scope, orders, supportsAmbient: true, ...field },
      });
      await setContextPolicy(c.ctx);
      assert.equal(c.out.status, 400);
      assert.match((c.out.body as any).message, /standing orders.*not.*ambient/i);
      assert.deepEqual(await store.get(ref), before);
      assert.deepEqual(await store.history(ref), history);
      assert.equal(c.audits.length, 0);
    }
  });
}

test("project membership, orders validation and conflicts fail independently without writes", async () => {
  const scope = "group:web-project-317";
  const store = createMemoryChannelPolicyStore();
  await store.set("web-project-317", "keep");
  const before = await store.get("web-project-317");
  const history = await store.history("web-project-317");
  const outsider = makeCtx({
    store,
    contexts: [],
    url: `http://x/v1/contexts/policy?principalId=alice&scope=${scope}`,
    body: { principalId: "alice", scope, orders: "bad" },
  });
  await getContextPolicy(outsider.ctx);
  assert.equal(outsider.out.status, 403);
  await setContextPolicy(outsider.ctx);
  assert.equal(outsider.out.status, 403);
  for (const [body, status] of [
    [{}, 400],
    [{ orders: "x".repeat(20_001) }, 400],
    [{ orders: "stale", baseUpdatedAt: -1 }, 409],
  ] as const) {
    const c = makeCtx({ store, contexts: [scope], body: { principalId: "alice", scope, ...body } });
    await setContextPolicy(c.ctx);
    assert.equal(c.out.status, status);
    assert.equal(c.audits.length, 0);
  }
  assert.deepEqual(await store.get("web-project-317"), before);
  assert.deepEqual(await store.history("web-project-317"), history);
});

for (const scope of ["channel:C317", "group:G317"])
  test(`Slack ambient controls still round-trip: ${scope}`, async () => {
    const store = createMemoryChannelPolicyStore();
    for (const ambientEnabled of [true, false, null]) {
      const bots = { CI: { mode: "rollup", rollupHours: 4 } };
      const c = makeCtx({
        store,
        contexts: [scope],
        body: { principalId: "alice", scope, orders: "watch", bots, ambientEnabled },
      });
      await setContextPolicy(c.ctx);
      assert.equal(c.out.status, 200);
      assert.deepEqual((c.out.body as any).policy.bots, bots);
      assert.equal((c.out.body as any).policy.ambientEnabled, ambientEnabled);
    }
  });

for (const scope of ["group:web-project-limit", "channel:C-limit", "group:G-limit"])
  test(`member policy size limit is applicability-neutral: ${scope}`, async () => {
    const store = createMemoryChannelPolicyStore();
    const ref = scope.slice(scope.indexOf(":") + 1);
    const valid = makeCtx({
      store,
      contexts: [scope],
      body: { principalId: "alice", scope, orders: "x".repeat(20_000) },
    });
    await setContextPolicy(valid.ctx);
    assert.equal(valid.out.status, 200);
    const before = await store.get(ref);
    const history = await store.history(ref);
    const oversized = makeCtx({
      store,
      contexts: [scope],
      body: { principalId: "alice", scope, orders: "x".repeat(20_001) },
    });
    await setContextPolicy(oversized.ctx);
    assert.equal(oversized.out.status, 400);
    assert.equal((oversized.out.body as { message: string }).message, "standing order is capped at 20000 characters");
    assert.deepEqual(await store.get(ref), before);
    assert.deepEqual(await store.history(ref), history);
    assert.deepEqual(oversized.audits, []);
  });
