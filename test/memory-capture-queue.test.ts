import { PgBoss } from "pg-boss";
import { captureMemoryTurns } from "../src/memory/strategies/per-turn.ts";
import type { MemoryCaptureTurn } from "../src/memory/capture-context.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryCaptureQueue } from "../src/memory/capture-queue.ts";
import { installCronQueue } from "../src/cron/job-queue.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { grantAppRole } from "../src/persistence/app-role-grants.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { ambientTenant } from "../src/tenants/context.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { ownerUrl, APP_ROLE } from "./support/test-tenant.ts";

async function readyDatabase() {
  const databaseUrl = testDatabaseUrl();
  await installCronQueue(ownerUrl(databaseUrl).toString());
  const owner = createPgPool(ownerUrl(databaseUrl).toString());
  await grantAppRole((text, values) => owner.q(text, values), APP_ROLE, "pgboss").finally(() => owner.close());
  return databaseUrl;
}

function turn(index: number): MemoryCaptureTurn {
  return {
    scopeId: "personal:queue-owner",
    conversationScopeId: "personal:queue-owner",
    actorId: "queue-owner",
    sessionId: "private-session",
    idempotencyKey: `turn-${index}`,
    input: `Durable private fact ${index}`,
    reply: "Noted",
    personalOnly: true,
    inheritedFacts: [],
    document: { mode: "private", teamScopeId: "group:team", documentScopeId: "group:document" },
  };
}

test(
  "concurrent capture producers preserve a private burst across service recreation and deduplicate handoff retries",
  { timeout: 20_000 },
  async (t) => {
    const databaseUrl = await readyDatabase();
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const tenant = ambientTenant().id;
    const memory = createPostgresMemoryService(databaseUrl);
    const completed = Promise.withResolvers<void>();
    const captured: MemoryCaptureTurn[][] = [];
    const capture = async (turns: MemoryCaptureTurn[]) => {
      assert.equal(ambientTenant().id, tenant);
      captured.push(turns);
      for (const ctx of turns)
        await memory.capture(
          ctx.scopeId,
          [ctx.input],
          Date.now(),
          { actorId: ctx.actorId!, context: "conversation" },
          { ...ctx, mode: "automatic" },
        );
      completed.resolve();
    };
    const options = { databaseUrl, quietMs: 180_000, maxTurns: 3, capture };
    const first = createMemoryCaptureQueue(options);
    const sibling = createMemoryCaptureQueue(options);
    const recovered = createMemoryCaptureQueue(options);
    t.after(async () => {
      await Promise.all([first.stop(), sibling.stop(), recovered.stop()]);
    });
    const inherited = {
      sensitivity: "restricted" as const,
      sources: ["group:restricted-source"],
      sourceUnknown: true,
      personalOnly: true as const,
      text: "UNRELATED_PRIVATE_NOTE",
      id: "unrelated-fact",
    };
    const sensitive = { ...turn(1), inheritedFacts: [inherited] };
    await Promise.all([first.enqueue(sensitive), sibling.enqueue(turn(2)), first.enqueue(sensitive)]);
    await Promise.all([first.stop(), sibling.stop()]);
    assert.equal(captured.length, 0);
    await recovered.enqueue(turn(3));
    await recovered.start();
    await completed.promise;
    await recovered.stop();
    assert.equal(captured.length, 1);
    assert.deepEqual(new Set(captured[0]!.map((ctx) => ctx.idempotencyKey)), new Set(["turn-1", "turn-2", "turn-3"]));
    assert.ok(captured[0]!.every((ctx) => ctx.document?.mode === "private"));
    const facts = await memory.facts!("personal:queue-owner");
    assert.deepEqual(new Set(facts.map((fact) => fact.text)), new Set([1, 2, 3].map((index) => turn(index).input)));
    assert.ok(facts.every((fact) => fact.personalOnly));
    assert.doesNotMatch(JSON.stringify(captured), /UNRELATED_PRIVATE_NOTE|unrelated-fact/);
    const restricted = facts.find((fact) => fact.text === turn(1).input)!;
    assert.equal(restricted.sensitivity, "restricted");
    assert.equal(restricted.sourceUnknown, true);
    assert.ok(restricted.sources.includes("group:restricted-source"));
  },
);

test(
  "enqueueing during an active capture creates a separate durable burst without replaying the active turn",
  { timeout: 20_000 },
  async (t) => {
    const databaseUrl = await readyDatabase();
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const captured: number[][] = [];
    const capture = async (turns: MemoryCaptureTurn[]) => {
      const ids = turns.map((ctx) => Number(ctx.idempotencyKey!.slice(5)));
      captured.push(ids);
      if (ids.includes(1)) {
        started.resolve();
        await release.promise;
      }
      if (captured.length === 2) finished.resolve();
    };
    const options = { databaseUrl, quietMs: 0, maxTurns: 10, capture };
    const first = createMemoryCaptureQueue(options);
    const sibling = createMemoryCaptureQueue(options);
    t.after(async () => {
      release.resolve();
      await Promise.all([first.stop(), sibling.stop()]);
    });
    await first.enqueue(turn(1));
    await first.start();
    await started.promise;
    await sibling.enqueue(turn(2));
    await sibling.start();
    release.resolve();
    await finished.promise;
    await Promise.all([first.stop(), sibling.stop()]);
    assert.deepEqual(captured, [[1], [2]]);
  },
);

test(
  "an interrupted extraction is recovered and its late model result cannot write private memory",
  { timeout: 20_000 },
  async (t) => {
    const databaseUrl = await readyDatabase();
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const memory = createPostgresMemoryService(databaseUrl);
    const attempted = Promise.withResolvers<void>();
    const lateResult = Promise.withResolvers<string>();
    const recovered = Promise.withResolvers<void>();
    const first = createMemoryCaptureQueue({
      databaseUrl,
      quietMs: 0,
      maxTurns: 1,
      capture: (turns, id, signal) =>
        captureMemoryTurns(
          {
            memory,
            agent: {
              oneShot: () => {
                attempted.resolve();
                return lateResult.promise;
              },
            },
          },
          turns,
          id,
          signal,
        ),
    });
    const replacement = createMemoryCaptureQueue({
      databaseUrl,
      quietMs: 0,
      maxTurns: 1,
      capture: async (turns, id, signal) => {
        await captureMemoryTurns(
          { memory, agent: { oneShot: async () => "SENSITIVITY: ordinary\n- Recovered private fact" } },
          turns,
          id,
          signal,
        );
        recovered.resolve();
      },
    });
    t.after(async () => {
      lateResult.resolve("- Late private fact");
      await Promise.all([first.stop(), replacement.stop()]);
    });
    await first.enqueue(turn(1));
    await first.start();
    await attempted.promise;
    await first.stopClaims();
    await first.stop();
    lateResult.resolve("SENSITIVITY: ordinary\n- Late private fact");
    assert.equal((await memory.facts!("personal:queue-owner")).length, 0);
    await replacement.start();
    await recovered.promise;
    const facts = await memory.facts!("personal:queue-owner");
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.text, "Recovered private fact");
    assert.equal(facts[0]!.personalOnly, true);
  },
);

test(
  "standby during initialization cannot register consumers after stopClaims resolves",
  { timeout: 20_000 },
  async (t) => {
    const databaseUrl = await readyDatabase();
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const starting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<void>();
    const original = PgBoss.prototype.start;
    const work = t.mock.method(PgBoss.prototype, "work");
    t.mock.method(PgBoss.prototype, "start", async function (this: PgBoss) {
      starting.resolve();
      await release.promise;
      return original.call(this);
    });
    const queue = createMemoryCaptureQueue({
      databaseUrl,
      quietMs: 0,
      maxTurns: 1,
      capture: async () => {
        captured.resolve();
      },
    });
    t.after(async () => {
      release.resolve();
      await queue.stop();
    });
    const pending = queue.start();
    await starting.promise;
    await queue.stopClaims();
    release.resolve();
    await pending;
    assert.equal(work.mock.callCount(), 0);
    await queue.enqueue(turn(1));
    await queue.start();
    await captured.promise;
  },
);

test("a worker attempt between producer lookup and locking cannot mutate the burst's idempotency identity", { timeout: 20_000 }, async (t) => {
  const databaseUrl = await readyDatabase();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const attempted = Promise.withResolvers<void>();
  const fail = Promise.withResolvers<void>();
  const first = createMemoryCaptureQueue({
    databaseUrl,
    quietMs: 0,
    maxTurns: 10,
    capture: async () => {
      attempted.resolve();
      await fail.promise;
      throw new Error("temporary failure");
    },
  });
  const seen: Array<{ turns: MemoryCaptureTurn[]; id: string }> = [];
  const one = Promise.withResolvers<{ turns: MemoryCaptureTurn[]; id: string }>();
  const two = Promise.withResolvers<{ turns: MemoryCaptureTurn[]; id: string }>();
  const replacement = createMemoryCaptureQueue({
    databaseUrl,
    quietMs: 0,
    maxTurns: 10,
    capture: async (turns, id) => {
      const result = { turns, id };
      seen.push(result);
      (seen.length === 1 ? one : two).resolve(result);
    },
  });
  t.after(async () => {
    fail.resolve();
    await Promise.all([first.stop(), replacement.stop()]);
  });
  await first.enqueue(turn(1));
  const lookedUp = Promise.withResolvers<void>();
  const releaseLookup = Promise.withResolvers<void>();
  const findJobs = PgBoss.prototype.findJobs;
  let pause = true;
  t.mock.method(PgBoss.prototype, "findJobs", async function (this: PgBoss, ...args: Parameters<PgBoss["findJobs"]>) {
    const jobs = await findJobs.apply(this, args);
    if (pause) {
      pause = false;
      lookedUp.resolve();
      await releaseLookup.promise;
    }
    return jobs;
  });
  t.after(() => releaseLookup.resolve());
  const enqueue = replacement.enqueue(turn(2));
  await lookedUp.promise;
  await first.start();
  await attempted.promise;
  await first.stopClaims();
  fail.resolve();
  await first.stop();
  releaseLookup.resolve();
  await enqueue;
  await replacement.start();
  const [a, b] = await Promise.all([one.promise, two.promise]);
  assert.deepEqual([a, b].map((batch) => batch.turns.map((ctx) => ctx.idempotencyKey)).sort(), [
    ["turn-1"],
    ["turn-2"],
  ]);
  assert.notEqual(a.id, b.id);
});

test("completed capture handoffs remain idempotent after queue recreation", { timeout: 20_000 }, async (t) => {
  const databaseUrl = await readyDatabase();
  const done = Promise.withResolvers<void>();
  const captured: MemoryCaptureTurn[][] = [];
  const options = {
    databaseUrl,
    quietMs: 0,
    maxTurns: 1,
    capture: async (turns: MemoryCaptureTurn[]) => {
      captured.push(turns);
      done.resolve();
    },
  };
  const first = createMemoryCaptureQueue(options);
  const recovered = createMemoryCaptureQueue(options);
  t.after(async () => {
    await first.stop();
    await recovered.stop();
  });
  await first.enqueue(turn(91));
  await first.start();
  await done.promise;
  await first.stop();
  await recovered.enqueue(turn(91));
  await recovered.enqueue(turn(92));
  await recovered.start();
  await t.waitFor(() => assert.equal(captured.length, 2));
  assert.deepEqual(
    captured.flatMap((batch) => batch.map((item) => item.idempotencyKey)),
    ["turn-91", "turn-92"],
  );
  await recovered.enqueue({ ...turn(91), reply: "Different rendered answer" });
  await recovered.stop();
  assert.equal(captured.length, 2);
  assert.equal(captured[0]![0]!.reply, "Noted");
});

test("a failed job insert rolls its capture receipt back", { timeout: 20_000 }, async (t) => {
  const databaseUrl = await readyDatabase();
  const captured: MemoryCaptureTurn[][] = [];
  const queue = createMemoryCaptureQueue({
    databaseUrl,
    quietMs: 0,
    maxTurns: 1,
    capture: async (turns) => {
      captured.push(turns);
    },
  });
  t.after(() => queue.stop());
  const send = PgBoss.prototype.send;
  let fail = true;
  t.mock.method(PgBoss.prototype, "send", async function (this: PgBoss, ...args: Parameters<PgBoss["send"]>) {
    if (fail) {
      fail = false;
      throw new Error("job insert unavailable");
    }
    return send.apply(this, args);
  });
  await assert.rejects(queue.enqueue(turn(93)), /job insert unavailable/);
  await queue.enqueue(turn(93));
  await queue.start();
  await t.waitFor(() => assert.equal(captured.length, 1));
  assert.equal(captured[0]![0]!.idempotencyKey, "turn-93");
});
