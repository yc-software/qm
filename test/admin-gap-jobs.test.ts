import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundBroker } from "../src/connectors/background-exec-broker.ts";
import { createMonitorBroker } from "../src/monitors/monitor-broker.ts";
import { manageSandboxResources } from "../src/api/routes/admin/sandbox.ts";

const bob = "personal:bob@x.com";
const adm = "personal:admin@x.com";
const job = { processId: "p1", scopeId: bob, sandboxId: "b1", kind: "background", command: "s", startedAt: 1 };
const h1 = { id: "h1", rootDir: "/w", resourceId: "b0" };
const h2 = { id: "h2", rootDir: "/w", resourceId: "b1" };
const reg = {
  get: async (id: string) => (id === "p1" ? { ...job, expiresAt: 9, status: "running" } : null),
  listByScope: async (s: string) => (s === bob ? [job] : []),
  listLive: async () => [job, { ...job, processId: "p2", scopeId: "env:s" }],
  markStatus: async () => true,
};

test("admin controls another user's job and watch by id; list stays own; non-admins and bots refused", async () => {
  let state: "running" | "exited" = "running";
  const written: string[] = [];
  const sandbox = {
    readProcess: async () => ({ chunks: "ok", cursor: 2, status: state === "exited" ? { state, code: 0 } : { state } }),
    writeStdin: async (_h: unknown, _id: string, d: string) => void written.push(d),
    signalProcess: async () => void (state = "exited"),
  };
  const bg = (orgAdmin: boolean) => {
    const opts = { sandbox, registry: reg, provisionSandbox: async () => h2, scopeId: adm, livePersonTurn: true };
    return createBackgroundBroker({ ...opts, orgAdmin } as any);
  };
  const ok = bg(true);
  assert.deepEqual(await ok.list(), []);
  assert.equal((await ok.handleFor!("p1"))?.resourceId, "b1");
  assert.equal((await ok.poll(h1, "p1")).chunks, "ok");
  assert.equal((await ok.write(h1, "p1", "hi")).bytes, 2);
  assert.deepEqual(written, ["hi"]);
  assert.equal((await ok.stop(h1, "p1")).stopped, true);
  const no = bg(false);
  const denied = [() => no.handleFor!("p1"), () => no.poll(h1, "p1"), () => no.write(h1, "p1", "x")];
  for (const fn of [...denied, () => no.stop(h1, "p1")]) await assert.rejects(fn, /no such background job/);

  const m = { id: "m1", owner: "bob@x.com", ownerScopeId: bob, processId: "p1", enabled: true };
  const deleted: string[] = [];
  const store = {
    list: async () => [m],
    get: async (id: string) => (id === "m1" ? m : null),
    create: async (x: any) => ({ ...x, id: "m2" }),
    delete: async (id: string) => void deleted.push(id),
  };
  const mon = (orgAdmin: boolean, botActor?: boolean) => {
    const tail = async () => ({ outputTail: "" });
    const base = { store, registry: reg, readOutputTail: tail, scopeId: adm, owner: "a@x", ownerScopeId: adm };
    return createMonitorBroker({ ...base, botActor, orgAdmin, threadRef: "t" } as any);
  };
  assert.equal("monitorId" in (await mon(true).watch("p1")), true);
  assert.equal((await mon(true).unwatch("m1")).removed, true);
  assert.deepEqual(deleted, ["m1"]);
  for (const d of [mon(false), mon(true, true)]) {
    await assert.rejects(() => d.watch("p1"), /no such background job/);
    assert.equal((await d.unwatch("m1")).removed, false);
  }
});

test("admin sandboxes GET lists a scope's background jobs", async () => {
  let body = "";
  const res = { getHeader() {}, writeHead() {}, end: (s: string) => (body = s) };
  const admin = { listGrants: async () => [{ principalId: "a@x", role: "org_admin" }] };
  const sandboxResources = { list: async () => ({ sandboxes: [{ id: "b1", ownerScopeId: bob }] }) };
  const deps = { admin, sandboxResources, processes: reg };
  const ctx = { req: { method: "GET" }, res, params: { scopeId: bob }, capability: { actorId: "a@x" }, deps };
  await manageSandboxResources({ ...ctx, tenant: { id: "t" } } as any);
  const ids = JSON.parse(body).jobs.map((j: any) => j.processId);
  assert.deepEqual(ids.sort(), ["p1", "p2"]);
});
