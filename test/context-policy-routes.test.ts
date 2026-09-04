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
}): { ctx: ApiCtx; out: { status: number; body: unknown }; store: ReturnType<typeof createMemoryChannelPolicyStore> } {
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
  return { ctx, out, store };
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
