import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createWorker } from "../src/runs/worker.ts";
import { createDrainController } from "../src/runs/drain.ts";
import { createEcsTaskProtection } from "../src/runs/task-protection.ts";
import type { InstanceRegistry } from "../src/runs/instance-registry.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal, TurnResult } from "../src/types.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const actor: Principal = { id: "internal:U1", type: "internal" };
const turn: OrchestratorInput = {
  actor,
  conversation: { kind: "dm", threadRef: "t1", audience: [actor] },
  origin: { kind: "direct" },
  text: "x",
};
const ok: TurnResult = { status: "ok", reply: "done" };

test("a superseded worker stops claiming; in-flight turns finish; claiming resumes when the newer build dies", async () => {
  const { runs } = createMemoryRunStore();
  const sessions = createMemorySessionStore();
  let superseded = false;
  const registry: InstanceRegistry = { beat: async () => superseded };
  const drain = createDrainController({ registry, protection: null, busy: () => false, sweepMs: 10 });
  drain.start();

  let release: (() => void) | null = null;
  const turns: Promise<void>[] = [];
  const orchestrator = {
    handleTurn: () =>
      new Promise<TurnResult>((resolve) => {
        const p = new Promise<void>((r) => (release = () => (resolve(ok), r())));
        turns.push(p);
      }),
  } as unknown as Orchestrator;
  const worker = createWorker({
    runs,
    sessions,
    orchestrator,
    leaseTtlMs: 10_000,
    pollMs: 5,
    canClaim: () => drain.canClaim(),
  });
  worker.start();

  await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 3 });
  await sleep(50);
  assert.equal(worker.busy(), true, "the first run was claimed");

  superseded = true;
  await sleep(50);
  await runs.enqueue({ sessionId: "s2", request: turn, maxAttempts: 3 });
  release!();
  await sleep(80);
  assert.equal(worker.busy(), false, "the in-flight turn finished");
  const pending = (await runs.list()).filter((r) => r.status === "pending");
  assert.equal(pending.length, 1, "the new run was NOT claimed while superseded");

  superseded = false;
  await sleep(80);
  assert.equal(worker.busy(), true, "claiming resumed once the newer build disappeared");
  release!();
  await worker.stop();
  drain.stop();
});

test("task protection tracks busyness: asserted while a turn runs, released once idle", async () => {
  const puts: Array<{ ProtectionEnabled: boolean; ExpiresInMinutes?: number }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += String(c)));
    req.on("end", () => {
      puts.push(JSON.parse(body) as (typeof puts)[number]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const uri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let busy = true;
  const drain = createDrainController({
    registry: { beat: async () => false },
    protection: createEcsTaskProtection(uri),
    busy: () => busy,
    sweepMs: 10,
  });
  drain.start();
  await sleep(60);
  assert.ok(
    puts.some((p) => p.ProtectionEnabled === true),
    "protection asserted while busy",
  );
  assert.equal(puts.at(-1)?.ProtectionEnabled, true, "re-asserted every sweep (expiry refresh)");
  assert.ok((puts.at(-1)?.ExpiresInMinutes ?? 0) > 0);

  busy = false;
  await sleep(60);
  assert.equal(puts.at(-1)?.ProtectionEnabled, false, "released once idle");
  const releases = puts.filter((p) => p.ProtectionEnabled === false).length;
  await sleep(40);
  assert.equal(puts.filter((p) => p.ProtectionEnabled === false).length, releases, "released once, not every sweep");

  drain.stop();
  server.close();
});

test("noteBusy asserts protection at the idle→busy edge without waiting for a sweep", async () => {
  const puts: Array<{ ProtectionEnabled: boolean }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += String(c)));
    req.on("end", () => {
      puts.push(JSON.parse(body) as (typeof puts)[number]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const uri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const drain = createDrainController({
    registry: { beat: async () => false },
    protection: createEcsTaskProtection(uri),
    busy: () => true,
    sweepMs: 60_000,
  });
  drain.noteBusy();
  await sleep(50);
  assert.deepEqual(puts.length && puts[0]?.ProtectionEnabled, true, "protection asserted immediately on claim");
  drain.noteBusy();
  await sleep(30);
  assert.equal(puts.length, 1, "already-on is a no-op");
  drain.stop();
  await sleep(30);
  assert.equal(puts.at(-1)?.ProtectionEnabled, false, "stop releases protection best-effort");
  server.close();
});

test("a failing protection endpoint degrades silently and canClaim stays governed by supersession only", async () => {
  const protection = createEcsTaskProtection("http://127.0.0.1:1");
  const drain = createDrainController({
    registry: { beat: async () => false },
    protection,
    busy: () => true,
    sweepMs: 10,
  });
  drain.start();
  await sleep(50);
  assert.equal(drain.canClaim(), true);
  drain.stop();
});
