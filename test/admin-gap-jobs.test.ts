import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundBroker } from "../src/connectors/background-exec-broker.ts";
import { createMonitorBroker } from "../src/monitors/monitor-broker.ts";

const bob = "personal:bob@x.com";
const adm = "personal:admin@x.com";
const job = { processId: "p1", scopeId: bob, sandboxId: "b1", kind: "background", command: "s", startedAt: 1 };
const [h1, h2] = ["b0", "b1"].map((resourceId, i) => ({ id: `h${i + 1}`, rootDir: "/w", resourceId }));
const reg = {
  get: async (id: string) => (id === "p1" ? { ...job, expiresAt: 9, status: "running" } : null),
  listByScope: async (s: string) => (s === bob ? [job] : []),
  listLive: async () => [job, { ...job, processId: "p2", scopeId: "env:s" }],
  markStatus: async () => true,
};

test("admin controls another user's job and watch by id; list stays own; non-admins and bots refused", async () => {
  let state: "running" | "exited" = "running";
  const sandbox = {
    readProcess: async () => ({ chunks: "ok", cursor: 2, status: state === "exited" ? { state, code: 0 } : { state } }),
    writeStdin: async () => {},
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
  assert.equal((await ok.stop(h1, "p1")).stopped, true);
  const no = bg(false);
  for (const fn of [
    () => no.handleFor!("p1"),
    () => no.poll(h1, "p1"),
    () => no.write(h1, "p1", "x"),
    () => no.stop(h1, "p1"),
  ])
    await assert.rejects(fn, /no such background job/);
  const m = { id: "m1", owner: "bob@x.com", ownerScopeId: bob, processId: "p1", enabled: true };
  const store = {
    list: async () => [m],
    get: async (id: string) => (id === "m1" ? m : null),
    create: async (x: any) => ({ ...x, id: "m2" }),
    delete: async () => {},
  };
  const mon = (orgAdmin: boolean, botActor?: boolean) => {
    const base = {
      store,
      registry: reg,
      readOutputTail: async () => ({ outputTail: "" }),
      scopeId: adm,
      owner: "a@x",
      ownerScopeId: adm,
    };
    return createMonitorBroker({ ...base, botActor, orgAdmin, threadRef: "t" } as any);
  };
  assert.equal("monitorId" in (await mon(true).watch("p1")), true);
  assert.equal((await mon(true).unwatch("m1")).removed, true);
  for (const d of [mon(false), mon(true, true)]) {
    await assert.rejects(() => d.watch("p1"), /no such background job/);
    assert.equal((await d.unwatch("m1")).removed, false);
  }
});
