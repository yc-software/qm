import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerResponse } from "node:http";
import { mintPortalIdentity, verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";
import { createTenantFeeds } from "../server/tenant-feeds.ts";

const secret = "tenant-feeds-identity-secret-0123456789";
const alpha = "00000000-0000-4000-8000-00000000000a";
const beta = "00000000-0000-4000-8000-00000000000b";
const token = (p: string, t?: string) =>
  mintPortalIdentity({ p, ...(t ? { t } : {}), exp: Date.now() + 60_000 }, secret);
const tenantOf = (tok: string | undefined) => (tok ? verifyPortalIdentity(tok, secret, Date.now())?.t : undefined);

function harness() {
  const store = new AsyncLocalStorage<string | undefined>();
  const feeds: Array<{ path: string; tenant: string | undefined; push(frame: string): void; signal: AbortSignal }> = [];
  const calls: Array<{ path: string; tenant: string | undefined }> = [];
  const pending = new Map<string | undefined, unknown[]>();
  const sent: Array<{ res: string; event: string; data: unknown }> = [];
  const rejected = new Set<string | undefined>();
  const notes: Array<[string | undefined, unknown]> = [];
  const res = (name: string) => ({ name }) as unknown as ServerResponse;
  const tenantFeeds = createTenantFeeds({
    identitySecret: secret,
    currentToken: () => store.getStore(),
    asToken: (tok, fn) => store.run(tok, fn),
    coreFetch: async (method, path, body) => {
      const tenant = tenantOf(store.getStore());
      calls.push({ path: `${method} ${path}`, tenant });
      if (rejected.has(tenant)) return { status: 401, text: "unauthorized" };
      if (path.startsWith("/v1/deliveries?"))
        return { status: 200, text: JSON.stringify({ deliveries: pending.get(tenant) ?? [] }) };
      if (path === "/v1/inbox/viewers")
        return { status: 200, text: JSON.stringify({ viewers: JSON.parse(body!).candidates }) };
      return { status: 200, text: "{}" };
    },
    openFeed: async (path, signal) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
      signal.addEventListener("abort", () => controller.error(new Error("aborted")));
      feeds.push({
        path,
        tenant: tenantOf(store.getStore()),
        signal,
        push: (f) => controller.enqueue(new TextEncoder().encode(f)),
      });
      return new Response(body, { status: 200 });
    },
    sseEvent: (r, event, data) => void sent.push({ res: (r as unknown as { name: string }).name, event, data }),
    ownerOfWebThread: (ref) => ref.split(":")[1] ?? null,
    noteDeliveries: (tenant, failure) => void notes.push([tenant, failure]),
    reconnectMs: 10_000,
    giveupMs: 60_000,
  });
  const attach = (user: string, tenant: string | undefined, name: string) =>
    store.run(tenant ? token(user, tenant) : undefined, () => tenantFeeds.attach(user, res(name)));
  return { tenantFeeds, feeds, calls, pending, sent, attach, rejected, notes };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("each tenant with a connected browser gets its own feeds, bound to that tenant", async () => {
  const h = harness();
  const detachA = h.attach("both@x.test", alpha, "inA");
  h.attach("both@x.test", beta, "inB");
  await tick();
  assert.deepEqual(h.feeds.map((f) => [f.path, f.tenant]).sort(), [
    ["/v1/loop-items/events", alpha],
    ["/v1/loop-items/events", beta],
    ["/v1/session-state/events", alpha],
    ["/v1/session-state/events", beta],
  ]);
  const stateA = h.feeds.find((f) => f.tenant === alpha && f.path === "/v1/session-state/events")!;
  stateA.push(`event: session_state\ndata: ${JSON.stringify({ threadRef: "web:both@x.test:t1", state: "idle" })}\n\n`);
  await tick();
  assert.deepEqual(
    h.sent.map((s) => [s.res, s.event]),
    [["inA", "session_state"]],
  );
  detachA();
  assert.equal(stateA.signal.aborted, true);
  assert.equal(h.feeds.find((f) => f.tenant === beta)!.signal.aborted, false);
});

test("deliveries are polled per tenant and only reach that tenant's browsers", async () => {
  const h = harness();
  h.attach("both@x.test", alpha, "inA");
  h.attach("both@x.test", beta, "inB");
  h.pending.set(beta, [{ id: "d1", createdAt: Date.now(), destination: { target: "web:both@x.test:t9" } }]);
  await h.tenantFeeds.drain();
  assert.deepEqual(
    h.sent.filter((s) => s.event === "delivery").map((s) => s.res),
    ["inB"],
  );
  assert.deepEqual(
    h.calls.filter((c) => c.path.startsWith("POST /v1/deliveries/")),
    [{ path: "POST /v1/deliveries/d1/ack", tenant: beta }],
  );
  assert.deepEqual(
    h.calls
      .filter((c) => c.path.startsWith("GET /v1/deliveries"))
      .map((c) => c.tenant ?? "untenanted")
      .sort(),
    [alpha, beta],
  );
});

test("no feed is opened or polled until a browser connects, and a tenantless browser's feeds close when it leaves", async () => {
  const h = harness();
  await h.tenantFeeds.drain();
  await tick();
  assert.deepEqual(h.feeds, []);
  assert.deepEqual(h.calls, []);
  const detach = h.attach("solo@x.test", undefined, "plain");
  await tick();
  assert.deepEqual(
    h.feeds.map((f) => f.tenant),
    [undefined, undefined],
  );
  await h.tenantFeeds.drain();
  assert.deepEqual(
    h.calls.map((c) => c.tenant),
    [undefined],
  );
  detach();
  assert.equal(
    h.feeds.every((f) => f.signal.aborted),
    true,
  );
});

test("each tenant's delivery poll reports its own failure without masking the others", async () => {
  const h = harness();
  h.attach("both@x.test", alpha, "inA");
  h.attach("both@x.test", beta, "inB");
  h.rejected.add(beta);
  await h.tenantFeeds.drain();
  const notes = new Map(h.notes);
  assert.equal(notes.get(alpha), undefined);
  assert.match(String(notes.get(beta)), /http 401/);
  assert.equal(h.notes.length, 2);
});
