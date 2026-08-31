import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { before, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createCronStore } from "../src/cron/cron-store.ts";
import {
  createPostgresScheduleAuthority,
  type ScheduleAuthorityFailpoint,
  type ScheduleRunClaimInput,
} from "../src/cron/postgres-schedule-authority.ts";
import {
  createScheduleAuthoritySigner,
  scheduledOccurrence,
  scheduleRunRequestSha256,
  scheduleRunRequestTemplateSha256,
  type PersistedScheduleRunRequest,
  type QmScheduleDefinition,
} from "../src/cron/schedule-authority.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { startSignalPoll } from "../src/runs/run-signal-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createApp, type AppDeps } from "../src/api/app.ts";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createWorker, processRun } from "../src/runs/worker.ts";
import type { Orchestrator } from "../src/core/orchestrator.ts";
import { createOrchestrator } from "../src/core/orchestrator.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import type { Harness } from "../src/harness/harness.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { scopeId, type Cron } from "../src/types.ts";

const BASE_URL = process.env.DATABASE_URL;
const skip = BASE_URL ? false : "set DATABASE_URL (a Postgres) to run the schedule authority tests";
const SCHEMA = "qm_schedule_authority_test";
const TEST_URL: string | undefined = (() => {
  if (!BASE_URL) return undefined;
  const parsed = new globalThis.URL(BASE_URL);
  parsed.searchParams.set("options", `-c search_path=${SCHEMA}`);
  return parsed.toString();
})();

const { privateKey } = generateKeyPairSync("ed25519");
const signer = createScheduleAuthoritySigner({
  authorityRef: "qm:test:scheduler",
  issuerRef: "qm:test",
  keyId: "schedule-test-1",
  privateKey,
});

function scheduleOrchestrator(
  sessions: SessionStore,
  harness: Harness = createMockHarness(),
  sandboxOverride?: Sandbox,
): Orchestrator {
  const config = createMemoryConfigStore("default-org");
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "qm-schedule-authority-")));
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "qm-schedule-authority-deploy"),
    auditLog,
    acl,
  });
  const blocked = () => {
    throw new Error("schedule authority test must not invoke a sandbox");
  };
  const sandbox: Sandbox =
    sandboxOverride ??
    ({
      profile: { backend: "test", writablePersistence: "snapshot_to_workspace", processSessions: false },
      provision: blocked as never,
      run: blocked as never,
      readFile: blocked as never,
      writeFile: blocked as never,
      writeFileBytes: blocked as never,
      readFileBytes: blocked as never,
      listDir: blocked as never,
      removeDir: blocked as never,
      teardown: blocked as never,
    } as Sandbox);
  return createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService("default-org", config, acl),
    sessions,
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox,
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 1_000, windowMs: 60_000 }),
    harness,
    memory: createMemoryService(workspace),
    deploy,
    acl,
  });
}

before(async () => {
  if (!BASE_URL) return;
  const pool = new pg.Pool({ connectionString: BASE_URL });
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.end();
});

function definition(tag: string, activeUntil = "2020-09-30"): QmScheduleDefinition {
  const septemberFirst = `${activeUntil.slice(0, 4)}-09-01`;
  return {
    scheduleRef: `schedule-${tag}`,
    cadence: "daily",
    timeZone: "America/Los_Angeles",
    localTime: "09:00",
    weeklyDay: null,
    monthlyDay: null,
    activeFrom: activeUntil < septemberFirst ? activeUntil : septemberFirst,
    activeUntil,
  };
}

function request(tag: string, cronId: string, scheduledAt: number): PersistedScheduleRunRequest {
  return {
    surface: "cron",
    actor: { id: "U1", type: "internal" },
    conversation: {
      kind: "dm",
      threadRef: `cron:${cronId}:fire:${tag}:${scheduledAt}`,
      audience: [{ id: "U1", type: "internal" }],
    },
    origin: { kind: "automation" },
    text: `scheduled task ${tag}`,
    idempotencyKey: `cron:${cronId}:${scheduledAt}`,
  };
}

async function fixture(
  tag: string,
  activeUntil = "2020-09-30",
  scheduledAt = Date.parse("2020-09-01T16:00:00.000Z"),
  receiptLifetimeMs = 300_000,
) {
  const maps = createPostgresMapFactory(TEST_URL!);
  const crons = createCronStore(maps.map<Cron>("crons"));
  const scheduleDefinition = definition(tag, activeUntil);
  const template = request(tag, "template-cron", scheduledAt);
  const cron = await crons.create({
    schedule: { cron: "0 9 * * *", timezone: scheduleDefinition.timeZone },
    action: `scheduled task ${tag}`,
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    scheduleAuthority: {
      contractVersion: 1,
      authorityRef: signer.authorityRef,
      issuerRef: signer.issuerRef,
      keyId: signer.keyId,
      profileRef: `profile:${tag}:1`,
      profileSha256: "1".repeat(64),
      scheduleDefinition,
      runRequestTemplateSha256: scheduleRunRequestTemplateSha256(template),
      receiptLifetimeMs,
    },
  });
  const persisted = request(tag, cron.id, scheduledAt);
  assert.equal(scheduleRunRequestTemplateSha256(persisted), cron.scheduleAuthority?.runRequestTemplateSha256);
  const claim: ScheduleRunClaimInput = {
    cronId: cron.id,
    scheduledAt,
    threadRef: persisted.conversation.threadRef,
    session: { type: "dm", scopeId: cron.ownerScopeId, surface: "cron" },
    request: persisted,
  };
  return { maps, crons, cron, claim };
}

async function rows(sql: string, params: unknown[] = []) {
  const pool = new pg.Pool({ connectionString: TEST_URL });
  try {
    return (await pool.query(sql, params)).rows;
  } finally {
    await pool.end();
  }
}

async function currentDatabaseTime(): Promise<number> {
  const result = await rows("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms");
  return Number(result[0]?.now_ms);
}

test(
  "slot, true session, run, signed receipt, and audit outbox commit atomically with byte-identical redelivery",
  { skip },
  async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2020-08-31T20:00:00.000Z"));
    const { claim, maps } = await fixture("atomic");
    const authority = createPostgresScheduleAuthority({
      connectionString: TEST_URL!,
      signer,
    });
    try {
      await assert.rejects(
        authority.claim({
          ...claim,
          session: { ...claim.session, scopeId: scopeId("personal", "U2") },
        }),
        /session scope/u,
      );
      const beforeFire = await currentDatabaseTime();
      const first = await authority.claim(claim);
      const afterFire = await currentDatabaseTime();
      const second = await authority.claim(claim);
      assert.equal(first.status, "enqueued");
      assert.equal(second.status, "deduped");
      assert.equal(second.runId, first.runId);
      assert.equal(second.sessionId, first.sessionId);
      assert.equal(second.receiptBytes, first.receiptBytes);
      assert.equal(second.receipt.signature, first.receipt.signature);
      assert.ok(Date.parse(first.receipt.firedAt) >= beforeFire);
      assert.ok(Date.parse(first.receipt.firedAt) <= afterFire);
      assert.equal(first.receipt.issuedAt, first.receipt.firedAt);
      assert.equal((await rows("SELECT count(*)::int AS n FROM sessions WHERE id=$1", [first.sessionId]))[0]?.n, 1);
      assert.equal(
        (
          await rows("SELECT count(*)::int AS n FROM runs WHERE id=$1 AND durable_session_id=$2", [
            first.runId,
            first.sessionId,
          ])
        )[0]?.n,
        1,
      );
      assert.equal(
        (
          await rows("SELECT count(*)::int AS n FROM transactional_outbox WHERE id=$1", [
            `qm-schedule-fire:${first.fireKey}`,
          ])
        )[0]?.n,
        1,
      );
      await assert.rejects(
        authority.claim({ ...claim, request: { ...claim.request, text: "conflicting task" } }),
        /conflicting run/u,
      );
    } finally {
      await authority.close();
      await maps.pool.close();
    }
  },
);

test("concurrent duplicate slot claims converge on one session, run, and receipt", { skip }, async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2020-08-31T20:00:00.000Z"));
  const { claim, maps } = await fixture("concurrent");
  const firstAuthority = createPostgresScheduleAuthority({
    connectionString: TEST_URL!,
    signer,
  });
  const secondAuthority = createPostgresScheduleAuthority({
    connectionString: TEST_URL!,
    signer,
  });
  try {
    const [left, right] = await Promise.all([firstAuthority.claim(claim), secondAuthority.claim(claim)]);
    if (
      left.status === "disabled" ||
      right.status === "disabled" ||
      left.status === "skipped" ||
      right.status === "skipped"
    ) {
      assert.fail("eligible slot did not enqueue");
    }
    assert.equal(left.runId, right.runId);
    assert.equal(left.sessionId, right.sessionId);
    assert.equal(left.receiptBytes, right.receiptBytes);
    assert.deepEqual(new Set([left.status, right.status]), new Set(["enqueued", "deduped"]));
  } finally {
    await firstAuthority.close();
    await secondAuthority.close();
    await maps.pool.close();
  }
});

test("schedule claims follow the durable-map version-before-cron lock order", { skip }, async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2020-08-31T20:00:00.000Z"));
  const { claim, maps } = await fixture("lock-order");
  const authority = createPostgresScheduleAuthority({ connectionString: TEST_URL!, signer });
  const pool = new pg.Pool({ connectionString: TEST_URL });
  const client = await pool.connect();
  let transactionOpen = false;
  let claiming: ReturnType<typeof authority.claim> | undefined;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("UPDATE durable_map_versions SET v=v+1 WHERE tbl='crons'");
    claiming = authority.claim(claim);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.query("SET LOCAL lock_timeout='1s'");
    await client.query("SELECT json FROM crons WHERE id=$1 FOR UPDATE", [claim.cronId]);
    await client.query("COMMIT");
    transactionOpen = false;
    const result = await claiming;
    assert.equal(result.status, "enqueued");
  } finally {
    if (transactionOpen) await client.query("ROLLBACK");
    await claiming?.catch(() => undefined);
    client.release();
    await pool.end();
    await authority.close();
    await maps.pool.close();
  }
});

test("every injected write failure rolls back the slot, session, run, receipt, and outbox", { skip }, async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2020-08-31T20:00:00.000Z"));
  for (const phase of ["slot", "session", "run", "receipt", "outbox", "cron"] as const) {
    const { claim, maps } = await fixture(`rollback-${phase}`);
    const authority = createPostgresScheduleAuthority({
      connectionString: TEST_URL!,
      signer,
      failpoint: (at) => {
        if (at === phase) throw new Error(`injected ${phase}`);
      },
    });
    await assert.rejects(authority.claim(claim), new RegExp(`injected ${phase}`, "u"));
    const key = claim.request.idempotencyKey;
    for (const table of [
      "cron_schedule_slots",
      "cron_schedule_fire_receipts",
      "runs",
      "sessions",
      "transactional_outbox",
    ]) {
      const predicates: Record<string, string> = {
        runs: "idempotency_key=$1",
        sessions: "thread_ref=$1",
        transactional_outbox: "id=$1",
      };
      const predicate = predicates[table] ?? "fire_key=$1";
      let identity = key;
      if (table === "transactional_outbox") identity = `qm-schedule-fire:${key}`;
      if (table === "sessions") identity = claim.threadRef;
      assert.equal((await rows(`SELECT count(*)::int AS n FROM ${table} WHERE ${predicate}`, [identity]))[0]?.n, 0);
    }
    await authority.close();
    await maps.pool.close();
  }
});

test("a worker cannot observe a run before the authority transaction commits", { skip }, async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2020-08-31T20:00:00.000Z"));
  const { claim, maps } = await fixture("uncommitted");
  let inserted!: () => void;
  let release!: () => void;
  const afterRun = new Promise<void>((resolve) => (inserted = resolve));
  const continueTransaction = new Promise<void>((resolve) => (release = resolve));
  const runtime = createPostgresRunStore(TEST_URL!);
  await runtime.runs.get("schema-ready");
  const authority = createPostgresScheduleAuthority({
    connectionString: TEST_URL!,
    signer,
    failpoint: async (phase) => {
      if (phase !== "run") return;
      inserted();
      await continueTransaction;
      throw new Error("injected rollback after run");
    },
  });
  const pending = authority.claim(claim);
  await afterRun;
  assert.equal(
    (await rows("SELECT count(*)::int AS n FROM runs WHERE idempotency_key=$1", [claim.request.idempotencyKey]))[0]?.n,
    0,
  );
  release();
  await assert.rejects(pending, /injected rollback/u);
  assert.equal(
    (await rows("SELECT count(*)::int AS n FROM runs WHERE idempotency_key=$1", [claim.request.idempotencyKey]))[0]?.n,
    0,
  );
  await runtime.close();
  await authority.close();
  await maps.pool.close();
});

test("a claim persists one immutable snapshot while its transaction is paused", { skip }, async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2020-08-31T20:00:00.000Z"));
  const { claim, maps } = await fixture("immutable-claim");
  const mutable = structuredClone(claim);
  const expected = structuredClone(claim);
  let inserted!: () => void;
  let release!: () => void;
  const afterSlot = new Promise<void>((resolve) => (inserted = resolve));
  const continueTransaction = new Promise<void>((resolve) => (release = resolve));
  const authority = createPostgresScheduleAuthority({
    connectionString: TEST_URL!,
    signer,
    failpoint: async (phase) => {
      if (phase !== "slot") return;
      inserted();
      await continueTransaction;
    },
  });
  const pending = authority.claim(mutable);
  try {
    await afterSlot;
    mutable.request.text = "mutated after claim began";
    mutable.request.conversation.threadRef = "mutated-thread";
    mutable.threadRef = "mutated-thread";
    mutable.session.scopeId = scopeId("personal", "U2");
    mutable.maxAttempts = 99;
    release();
    const claimed = await pending;
    if (claimed.status === "disabled" || claimed.status === "skipped") assert.fail("eligible slot did not enqueue");
    const stored = (
      await rows("SELECT request, max_attempts, durable_session_id FROM runs WHERE id=$1", [claimed.runId])
    )[0];
    const persisted = JSON.parse(stored.request as string) as PersistedScheduleRunRequest;
    assert.deepEqual(persisted, expected.request);
    assert.equal(stored.max_attempts, expected.maxAttempts ?? 3);
    assert.equal(stored.durable_session_id, claimed.sessionId);
    assert.equal(claimed.threadRef, expected.threadRef);
    assert.equal(claimed.receipt.threadRef, expected.threadRef);
    assert.equal(claimed.receipt.runRequestSha256, scheduleRunRequestSha256(persisted));
    assert.equal(
      (
        await rows("SELECT count(*)::int AS n FROM sessions WHERE id=$1 AND scope_id=$2 AND thread_ref=$3", [
          claimed.sessionId,
          expected.session.scopeId,
          expected.threadRef,
        ])
      )[0]?.n,
      1,
    );
  } finally {
    release();
    await pending.catch(() => undefined);
    await authority.close();
    await maps.pool.close();
  }
});

test("an ambiguous fall-back slot advances state without a run or receipt", { skip }, async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2020-10-31T20:00:00.000Z"));
  const maps = createPostgresMapFactory(TEST_URL!);
  const crons = createCronStore(maps.map<Cron>("crons"));
  const scheduleDefinition: QmScheduleDefinition = {
    scheduleRef: "schedule-fold",
    cadence: "daily",
    timeZone: "America/Los_Angeles",
    localTime: "01:30",
    weeklyDay: null,
    monthlyDay: null,
    activeFrom: "2020-11-01",
    activeUntil: "2020-11-03",
  };
  const template = request("fold", "template-cron", Date.parse("2020-11-01T08:30:00.000Z"));
  const cron = await crons.create({
    schedule: { cron: "30 1 * * *", timezone: scheduleDefinition.timeZone },
    action: "scheduled task fold",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    scheduleAuthority: {
      contractVersion: 1,
      authorityRef: signer.authorityRef,
      issuerRef: signer.issuerRef,
      keyId: signer.keyId,
      profileRef: "profile:fold:1",
      profileSha256: "1".repeat(64),
      scheduleDefinition,
      runRequestTemplateSha256: scheduleRunRequestTemplateSha256(template),
      receiptLifetimeMs: 300_000,
    },
  });
  const scheduledAt = cron.nextFireAt!;
  assert.deepEqual(scheduledOccurrence(scheduleDefinition, scheduledAt), { eligible: false, reason: "ambiguous" });
  const persisted = request("fold", cron.id, scheduledAt);
  const authority = createPostgresScheduleAuthority({
    connectionString: TEST_URL!,
    signer,
  });
  try {
    const skipped = await authority.claim({
      cronId: cron.id,
      scheduledAt,
      threadRef: persisted.conversation.threadRef,
      session: { type: "dm", scopeId: cron.ownerScopeId, surface: "cron" },
      request: persisted,
    });
    assert.deepEqual(skipped, { status: "skipped" });
    assert.equal(
      (await rows("SELECT count(*)::int AS n FROM runs WHERE idempotency_key=$1", [persisted.idempotencyKey]))[0]?.n,
      0,
    );
    assert.equal(
      (await rows("SELECT count(*)::int AS n FROM cron_schedule_fire_receipts WHERE cron_id=$1", [cron.id]))[0]?.n,
      0,
    );
    const after = await crons.get(cron.id);
    assert.equal(after?.nextFireAt, Date.parse("2020-11-02T09:30:00.000Z"));
    assert.equal(after?.scheduleAuthority?.stateRevision, cron.scheduleAuthority!.stateRevision + 1);
  } finally {
    await authority.close();
    await maps.pool.close();
  }
});

test("weekly and monthly calendar slots receive durable signed claims", { skip }, async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2020-08-31T20:00:00.000Z"));
  const maps = createPostgresMapFactory(TEST_URL!);
  const crons = createCronStore(maps.map<Cron>("crons"));
  const scheduledAt = Date.parse("2020-09-01T16:00:00.000Z");
  const weeklyDay = new Date(Date.UTC(2020, 8, 1)).getUTCDay();
  try {
    for (const calendar of [
      { tag: "weekly", cadence: "weekly" as const, weeklyDay, monthlyDay: null, cron: `0 9 * * ${weeklyDay}` },
      { tag: "monthly", cadence: "monthly" as const, weeklyDay: null, monthlyDay: 1, cron: "0 9 1 * *" },
    ]) {
      const scheduleDefinition: QmScheduleDefinition = {
        scheduleRef: `schedule-${calendar.tag}`,
        cadence: calendar.cadence,
        timeZone: "America/Los_Angeles",
        localTime: "09:00",
        weeklyDay: calendar.weeklyDay,
        monthlyDay: calendar.monthlyDay,
        activeFrom: "2020-09-01",
        activeUntil: "2020-09-30",
      };
      const template = request(calendar.tag, "template-cron", scheduledAt);
      const cron = await crons.create({
        schedule: { cron: calendar.cron, timezone: scheduleDefinition.timeZone },
        action: `scheduled task ${calendar.tag}`,
        owner: "U1",
        createdBy: "U1",
        ownerScopeId: scopeId("personal", "U1"),
        scheduleAuthority: {
          contractVersion: 1,
          authorityRef: signer.authorityRef,
          issuerRef: signer.issuerRef,
          keyId: signer.keyId,
          profileRef: `profile:${calendar.tag}:1`,
          profileSha256: "1".repeat(64),
          scheduleDefinition,
          runRequestTemplateSha256: scheduleRunRequestTemplateSha256(template),
          receiptLifetimeMs: 300_000,
        },
      });
      const persisted = request(calendar.tag, cron.id, scheduledAt);
      const authority = createPostgresScheduleAuthority({
        connectionString: TEST_URL!,
        signer,
      });
      try {
        const claimed = await authority.claim({
          cronId: cron.id,
          scheduledAt,
          threadRef: persisted.conversation.threadRef,
          session: { type: "dm", scopeId: cron.ownerScopeId, surface: "cron" },
          request: persisted,
        });
        if (claimed.status === "disabled" || claimed.status === "skipped") assert.fail("calendar slot did not claim");
        assert.equal(claimed.receipt.scheduleRef, scheduleDefinition.scheduleRef);
        assert.equal(claimed.receipt.scheduledAt, new Date(scheduledAt).toISOString());
        assert.equal((await rows("SELECT count(*)::int AS n FROM runs WHERE id=$1", [claimed.runId]))[0]?.n, 1);
      } finally {
        await authority.close();
      }
    }
  } finally {
    await maps.pool.close();
  }
});

test("authority rejects a slot before its trusted fire time", { skip }, async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2100-08-31T20:00:00.000Z"));
  const { claim, maps } = await fixture("premature", "2100-09-30", Date.parse("2100-09-01T16:00:00.000Z"));
  const authority = createPostgresScheduleAuthority({
    connectionString: TEST_URL!,
    signer,
  });
  try {
    await assert.rejects(authority.claim(claim), /before its slot/u);
    assert.equal(
      (await rows("SELECT count(*)::int AS n FROM runs WHERE idempotency_key=$1", [claim.request.idempotencyKey]))[0]
        ?.n,
      0,
    );
  } finally {
    await authority.close();
    await maps.pool.close();
  }
});

test(
  "scheduler through App and worker preserves the committed session and invocation authority",
  { skip },
  async (t) => {
    let wallAt = Date.parse("2020-08-31T20:00:00.000Z");
    t.mock.method(Date, "now", () => wallAt);
    const maps = createPostgresMapFactory(TEST_URL!);
    const crons = createCronStore(maps.map<Cron>("crons"));
    const sessions = createPostgresSessionStore(TEST_URL!);
    const runtime = createPostgresRunStore(TEST_URL!);
    const authority = createPostgresScheduleAuthority({ connectionString: TEST_URL!, signer });
    const runSignals = createPostgresRunSignalStore(TEST_URL!);
    const identity = createIdentityService();
    let observedAuthority = false;
    const handledSignals: string[] = [];
    const baseHarness = createMockHarness();
    const signalHarness: Harness = {
      ...baseHarness,
      turns: {
        async runTurn(turn) {
          assert.equal(turn.acceptRunSignals, false);
          assert.ok(turn.runId);
          const stopSignals = startSignalPoll(
            runSignals,
            turn.runId,
            {
              onSteer: async (text) => {
                handledSignals.push(text);
              },
              onAbort: async () => {
                handledSignals.push("abort");
              },
            },
            { intervalMs: 60_000, discard: turn.acceptRunSignals === false },
          );
          try {
            return await baseHarness.turns.runTurn(turn);
          } finally {
            await stopSignals();
          }
        },
      },
    };
    const coreOrchestrator = scheduleOrchestrator(sessions, signalHarness);
    const orchestrator: Orchestrator = {
      ...coreOrchestrator,
      async handleTurn(input) {
        assert.ok(input.scheduleAuthority);
        await assert.rejects(input.scheduleAuthority.assertCurrent({}), /foreign or serialized/u);
        const initial = await input.scheduleAuthority.assertCurrent(input);
        await new Promise((resolve) => setTimeout(resolve, 25));
        const trusted = await input.scheduleAuthority.assertCurrent(input);
        assert.equal(trusted.authority.leaseGenerationSha256, initial.authority.leaseGenerationSha256);
        assert.ok(trusted.authority.leaseExpiresAt > initial.authority.leaseExpiresAt);
        const session = await sessions.get(trusted.authority.sessionId);
        assert.ok(session);
        assert.equal(session.id, trusted.authority.sessionId);
        assert.equal(session.threadRef, trusted.authority.threadRef);
        assert.equal((await sessions.getByThread(trusted.authority.threadRef))?.id, trusted.authority.sessionId);
        observedAuthority = true;
        return coreOrchestrator.handleTurn(input);
      },
    };
    const app = createApp({
      identity,
      sessions,
      orchestrator,
      runs: runtime.runs,
      leaseTtlMs: 30_000,
      maxAttempts: 3,
      scheduleAuthority: authority,
      signals: runSignals,
      config: createMemoryConfigStore("default-org"),
    } as unknown as AppDeps);
    const scheduler = createScheduler({
      crons,
      deliveries: createDeliveryStore(),
      idempotency: createIdempotencyStore(),
      identity,
      run: (req) => app.turn({ ...req, async: true }),
      runScheduled: (req, context) => app.turn({ ...req, async: true }, context),
    });
    let worker: ReturnType<typeof createWorker> | undefined;
    try {
      await crons.get("__schema_ready__");
      await assert.rejects(
        authority.current({ runId: "missing-run", leaseToken: "missing-lease", invocation: {} }),
        /no current committed/u,
      );
      await rows("UPDATE crons SET json=jsonb_set(json,'{enabled}','false'::jsonb)");
      const scheduleDefinition = definition("end-to-end");
      const scheduledAt = Date.parse("2020-09-01T16:00:00.000Z");
      const cron = await crons.create({
        schedule: { cron: "0 9 * * *", timezone: scheduleDefinition.timeZone },
        action: "scheduled task end-to-end",
        owner: "U1",
        createdBy: "U1",
        ownerScopeId: scopeId("personal", "U1"),
        scheduleAuthority: {
          contractVersion: 1,
          authorityRef: signer.authorityRef,
          issuerRef: signer.issuerRef,
          keyId: signer.keyId,
          profileRef: "profile:end-to-end:1",
          profileSha256: "1".repeat(64),
          scheduleDefinition,
          runRequestTemplateSha256: "0".repeat(64),
          receiptLifetimeMs: 300_000,
        },
      });
      let template: PersistedScheduleRunRequest | undefined;
      const templateApp = createApp({
        identity,
        sessions,
        orchestrator,
        runs: runtime.runs,
        leaseTtlMs: 30_000,
        maxAttempts: 3,
        scheduleAuthority: {
          async claim(input: ScheduleRunClaimInput) {
            template = input.request;
            return { status: "skipped" };
          },
        },
        signals: runSignals,
        config: createMemoryConfigStore("default-org"),
      } as unknown as AppDeps);
      const templateScheduler = createScheduler({
        crons,
        deliveries: createDeliveryStore(),
        idempotency: createIdempotencyStore(),
        identity,
        run: (req) => templateApp.turn({ ...req, async: true }),
        runScheduled: (req, context) => templateApp.turn({ ...req, async: true }, context),
      });
      try {
        await templateScheduler.tick(scheduledAt + 1_000);
      } finally {
        templateScheduler.stop();
      }
      assert.ok(template);
      await crons.update(cron.id, {
        scheduleAuthority: {
          contractVersion: 1,
          authorityRef: signer.authorityRef,
          issuerRef: signer.issuerRef,
          keyId: signer.keyId,
          profileRef: "profile:end-to-end:1",
          profileSha256: "1".repeat(64),
          scheduleDefinition,
          runRequestTemplateSha256: scheduleRunRequestTemplateSha256(template),
          receiptLifetimeMs: 300_000,
        },
      });
      await assert.rejects(crons.delete(cron.id), /signed schedule crons cannot be deleted/u);
      const manualRunsBefore = Number(
        (
          await rows("SELECT count(*)::int AS n FROM runs WHERE idempotency_key LIKE $1", [`cron:${cron.id}:manual:%`])
        )[0]?.n,
      );
      await assert.rejects(scheduler.runNow(cron.id), /authority-managed crons cannot be fired manually/u);
      assert.equal(
        Number(
          (
            await rows("SELECT count(*)::int AS n FROM runs WHERE idempotency_key LIKE $1", [
              `cron:${cron.id}:manual:%`,
            ])
          )[0]?.n,
        ),
        manualRunsBefore,
      );
      assert.equal(
        Number(
          (await rows("SELECT count(*)::int AS n FROM cron_schedule_fire_receipts WHERE cron_id=$1", [cron.id]))[0]?.n,
        ),
        0,
      );
      const interval = await crons.create({
        schedule: { everyMs: 60_000 },
        action: "unsigned interval task",
        owner: "U1",
        createdBy: "U1",
        ownerScopeId: scopeId("personal", "U1"),
      });
      const message = await crons.create({
        schedule: { everyMs: 60_000 },
        message: "unsigned delivery",
        owner: "U1",
        createdBy: "U1",
        ownerScopeId: scopeId("personal", "U1"),
      });
      wallAt = scheduledAt + 1_000;
      await scheduler.tick(wallAt);
      const queued = await runtime.runs.list({ limit: 20 });
      const unsignedInterval = queued.find((run) => run.dedupKey?.startsWith(`cron:${interval.id}:`));
      assert.ok(unsignedInterval);
      assert.equal(unsignedInterval.durableSessionId, null);
      assert.equal(
        (
          await rows("SELECT count(*)::int AS n FROM cron_schedule_fire_receipts WHERE cron_id=$1 OR run_id=$2", [
            interval.id,
            unsignedInterval.id,
          ])
        )[0]?.n,
        0,
      );
      assert.equal(await runtime.runs.withdraw(unsignedInterval.id), true);
      assert.equal(
        (await rows("SELECT count(*)::int AS n FROM cron_schedule_fire_receipts WHERE cron_id=$1", [message.id]))[0]?.n,
        0,
      );
      const scheduled = queued.find((run) => run.dedupKey === `cron:${cron.id}:${scheduledAt}`);
      assert.ok(scheduled?.durableSessionId);
      await assert.rejects(rows("DELETE FROM sessions WHERE id=$1", [scheduled.durableSessionId]), /foreign key/u);
      await runSignals.send(scheduled.id, { kind: "steer", text: "requestless provider write" });
      await runSignals.send(scheduled.id, {
        kind: "steer",
        text: "request-bearing provider write",
        request: {
          surface: "slack",
          actor: { externalId: "U1" },
          conversation: { kind: "dm", threadRef: scheduled.sessionId, audience: [{ externalId: "U1" }] },
          text: "request-bearing provider write",
          triggered: true,
          ownerKeychainUnion: true,
          unattendedGrants: ["admin.sessions.read"],
          surfaceTools: true,
        },
      });
      await runSignals.send(scheduled.id, { kind: "abort" });
      worker = createWorker({
        runs: runtime.runs,
        sessions,
        orchestrator,
        scheduleAuthority: authority,
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 5,
        pollMs: 5,
      });
      worker.start();
      const finished = await runtime.runs.waitFor(scheduled.id, 10_000);
      assert.equal(finished.status, "done");
      assert.equal(finished.result?.sessionId, scheduled.durableSessionId);
      assert.equal(observedAuthority, true);
      assert.deepEqual(handledSignals, []);
      assert.deepEqual(await runSignals.takePending(scheduled.id), []);
    } finally {
      await worker?.stop();
      await runSignals.close?.();
      await runtime.close();
      await authority.close();
      await maps.pool.close();
    }
  },
);

test("effect authority is rechecked after harness admission and before sandbox provisioning", { skip }, async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2020-08-31T20:00:00.000Z"));
  const { claim, maps } = await fixture("effect-expiry", "2020-09-30", undefined, 1_500);
  const authority = createPostgresScheduleAuthority({ connectionString: TEST_URL!, signer });
  const runtime = createPostgresRunStore(TEST_URL!);
  const sessions = createPostgresSessionStore(TEST_URL!);
  const baseHarness = createMockHarness();
  let enterHarness = () => {};
  const harnessEntered = new Promise<void>((resolve) => {
    enterHarness = resolve;
  });
  let releaseHarness = () => {};
  const harnessRelease = new Promise<void>((resolve) => {
    releaseHarness = resolve;
  });
  const effects = { provision: 0, run: 0 };
  const sandbox = {
    profile: { backend: "test", writablePersistence: "snapshot_to_workspace", processSessions: false },
    async provision() {
      effects.provision += 1;
      return { id: "effect-expiry", rootDir: "/workspace" };
    },
    async run() {
      effects.run += 1;
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
  } as unknown as Sandbox;
  const harness: Harness = {
    ...baseHarness,
    turns: {
      async runTurn(turn) {
        enterHarness();
        await harnessRelease;
        await assert.rejects(turn.tools.execute("echo forbidden"), /schedule-fire receipt is not current/u);
        return { reply: "must not complete" };
      },
    },
  };
  let pending: ReturnType<typeof processRun> | undefined;
  try {
    const enqueued = await authority.claim(claim);
    if (enqueued.status === "disabled" || enqueued.status === "skipped") assert.fail("eligible slot did not enqueue");
    const running = await runtime.runs.claimById(enqueued.runId, "effect-expiry-worker", 30_000);
    assert.ok(running?.leaseToken);
    pending = processRun(
      {
        runs: runtime.runs,
        orchestrator: scheduleOrchestrator(sessions, harness, sandbox),
        scheduleAuthority: authority,
        leaseTtlMs: 30_000,
      },
      running,
    );
    await harnessEntered;
    const expiresAt = Date.parse(enqueued.receipt.expiresAt);
    while ((await currentDatabaseTime()) < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    releaseHarness();
    await assert.rejects(pending, /schedule-fire receipt is not current/u);
    assert.deepEqual(effects, { provision: 0, run: 0 });
    const after = await runtime.runs.get(enqueued.runId);
    assert.equal(after?.status, "pending");
    assert.equal(after?.result, null);
  } finally {
    releaseHarness();
    await pending?.catch(() => undefined);
    await runtime.close();
    await authority.close();
    await maps.pool.close();
  }
});

test(
  "current invocation authority binds status, attempt, lease token, expiry, and handler identity",
  { skip },
  async (t) => {
    const wallAt = Date.parse("2020-08-31T20:00:00.000Z");
    t.mock.method(Date, "now", () => wallAt);
    const { claim, maps } = await fixture("lease");
    const authority = createPostgresScheduleAuthority({ connectionString: TEST_URL!, signer });
    const runtime = createPostgresRunStore(TEST_URL!);
    try {
      const enqueued = await authority.claim(claim);
      if (enqueued.status === "disabled" || enqueued.status === "skipped") assert.fail("eligible slot did not enqueue");
      await assert.rejects(rows("DELETE FROM sessions WHERE id=$1", [enqueued.sessionId]), /foreign key/u);
      await rows(
        `INSERT INTO sessions(id,type,scope_id,thread_ref,created_at,surface,last_activity,messages,turns)
         VALUES($1,'dm',$2,$3,$4,'cron',$4,0,0)`,
        ["replacement-session", scopeId("personal", "U1"), `${enqueued.threadRef}:replacement`, claim.scheduledAt],
      );
      await rows("UPDATE runs SET durable_session_id=$2 WHERE id=$1", [enqueued.runId, "replacement-session"]);
      await assert.rejects(
        authority.current({ runId: enqueued.runId, leaseToken: "not-yet-leased", invocation: {} }),
        /no current committed/u,
      );
      await rows("UPDATE runs SET durable_session_id=$2 WHERE id=$1", [enqueued.runId, enqueued.sessionId]);
      await assert.rejects(
        authority.current({ runId: enqueued.runId, leaseToken: "not-a-current-token", invocation: {} }),
        /no current committed/u,
      );
      await assert.rejects(
        authority.current({ runId: "missing-run", leaseToken: "missing-token", invocation: {} }),
        /no current committed/u,
      );
      const running = await runtime.runs.claimById(enqueued.runId, "worker-1", 30_000);
      assert.ok(running?.leaseToken);
      const handler = {};
      await rows("UPDATE runs SET idempotency_key=$2 WHERE id=$1", [enqueued.runId, `${enqueued.fireKey}:forged`]);
      await assert.rejects(
        authority.current({ runId: enqueued.runId, leaseToken: running.leaseToken, invocation: handler }),
        /lineage/u,
      );
      await rows("UPDATE runs SET idempotency_key=$2 WHERE id=$1", [enqueued.runId, enqueued.fireKey]);
      const current = await authority.current({
        runId: enqueued.runId,
        leaseToken: running.leaseToken,
        invocation: handler,
      });
      assert.equal((await authority.assertCurrent(current, handler)).receipt.runId, enqueued.runId);
      await assert.rejects(authority.assertCurrent(current, {}), /foreign or serialized/u);
      await assert.rejects(authority.assertCurrent(structuredClone(current), handler), /foreign or serialized/u);
      assert.equal(await runtime.runs.heartbeat(enqueued.runId, running.leaseToken, 60_000), true);
      const refreshed = (await authority.assertCurrent(current, handler)).authority;
      const renewed = await runtime.runs.get(enqueued.runId);
      const currentAfterHeartbeat = refreshed;
      assert.equal(currentAfterHeartbeat.attempt, current.attempt);
      assert.equal(currentAfterHeartbeat.leaseGenerationSha256, current.leaseGenerationSha256);
      assert.notEqual(currentAfterHeartbeat.leaseExpiresAt, current.leaseExpiresAt);
      await assert.rejects(authority.assertCurrent(current, handler), /foreign or serialized/u);
      assert.ok(renewed?.leaseExpiresAt);
      assert.equal(await runtime.runs.releaseLease(enqueued.runId, running.leaseToken), true);
      await assert.rejects(authority.assertCurrent(currentAfterHeartbeat, handler), /no longer current/u);
      const reassigned = await runtime.runs.claimById(enqueued.runId, "worker-2", 30_000);
      assert.ok(reassigned?.leaseToken);
      const currentAfterRetry = await authority.current({
        runId: enqueued.runId,
        leaseToken: reassigned.leaseToken,
        invocation: handler,
      });
      assert.equal(currentAfterRetry.attempt, current.attempt + 1);
      assert.notEqual(currentAfterRetry.leaseGenerationSha256, current.leaseGenerationSha256);
      await rows(
        `UPDATE runs
         SET lease_expires_at=floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
         WHERE id=$1`,
        [enqueued.runId],
      );
      assert.equal(await runtime.runs.heartbeat(enqueued.runId, reassigned.leaseToken, 30_000), false);
      await rows(
        `UPDATE runs
         SET lease_expires_at=floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint-1
         WHERE id=$1`,
        [enqueued.runId],
      );
      assert.equal(await runtime.runs.heartbeat(enqueued.runId, reassigned.leaseToken, 30_000), false);
      await assert.rejects(authority.assertCurrent(currentAfterRetry, handler), /no longer current/u);
      assert.equal(await runtime.runs.releaseLease(enqueued.runId, reassigned.leaseToken), true);
    } finally {
      await runtime.close();
      await authority.close();
      await maps.pool.close();
    }
  },
);

test("current authority rejects the exact signed receipt expiry boundary", { skip }, async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2020-08-31T20:00:00.000Z"));
  const { claim, maps } = await fixture("receipt-expiry", "2020-09-30", Date.parse("2020-09-01T16:00:00.000Z"), 2_000);
  const authority = createPostgresScheduleAuthority({ connectionString: TEST_URL!, signer });
  const runtime = createPostgresRunStore(TEST_URL!);
  try {
    const enqueued = await authority.claim(claim);
    if (enqueued.status === "disabled" || enqueued.status === "skipped") assert.fail("eligible slot did not enqueue");
    const running = await runtime.runs.claimById(enqueued.runId, "receipt-expiry-worker", 30_000);
    assert.ok(running?.leaseToken);
    const handler = {};
    const current = await authority.current({
      runId: enqueued.runId,
      leaseToken: running.leaseToken,
      invocation: handler,
    });
    const remaining = Date.parse(enqueued.receipt.expiresAt) - (await currentDatabaseTime());
    if (remaining >= 0) await new Promise((resolve) => setTimeout(resolve, remaining + 2));
    await assert.rejects(authority.assertCurrent(current, handler), /receipt is not current/u);
    await assert.rejects(
      authority.current({ runId: enqueued.runId, leaseToken: running.leaseToken, invocation: {} }),
      /receipt is not current/u,
    );
    assert.equal((await runtime.runs.get(enqueued.runId))?.status, "running");
    assert.equal(await runtime.runs.releaseLease(enqueued.runId, running.leaseToken), true);
  } finally {
    await runtime.close();
    await authority.close();
    await maps.pool.close();
  }
});

test(
  "first otherwise-matching slot after activeUntil disables atomically and same-value re-enable revises generation",
  { skip },
  async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2020-08-31T20:00:00.000Z"));
    const { maps, crons, cron, claim } = await fixture("disable", "2020-09-01");
    const authority = createPostgresScheduleAuthority({
      connectionString: TEST_URL!,
      signer,
    });
    const concurrentAuthority = createPostgresScheduleAuthority({
      connectionString: TEST_URL!,
      signer,
    });
    try {
      const eligible = await authority.claim(claim);
      if (eligible.status === "disabled" || eligible.status === "skipped") assert.fail("activeUntil must be inclusive");
      assert.equal(eligible.receipt.cronStateRevision, cron.scheduleAuthority!.stateRevision + 1);
      const rejectedAt = Date.parse("2020-09-02T16:00:00.000Z");
      const rejectedRequest = request("disable", cron.id, rejectedAt);
      const disabledInput = {
        ...claim,
        scheduledAt: rejectedAt,
        threadRef: rejectedRequest.conversation.threadRef,
        request: rejectedRequest,
      };
      const [disabled, duplicate] = await Promise.all([
        authority.claim(disabledInput),
        concurrentAuthority.claim(disabledInput),
      ]);
      assert.equal(disabled.status, "disabled");
      assert.equal(duplicate.status, "disabled");
      if (disabled.status !== "disabled" || duplicate.status !== "disabled") {
        assert.fail("post-window slot must disable");
      }
      assert.equal(duplicate.receiptBytes, disabled.receiptBytes);
      assert.equal(disabled.receipt.lastEligibleScheduledAt, "2020-09-01T16:00:00.000Z");
      assert.equal(disabled.receipt.firstRejectedScheduledAt, "2020-09-02T16:00:00.000Z");
      const afterDisable = await crons.get(cron.id);
      assert.equal(afterDisable?.enabled, false);
      assert.equal(afterDisable?.scheduleAuthority?.disabledReason, "active_until_elapsed");
      assert.equal(afterDisable?.scheduleAuthority?.stateRevision, cron.scheduleAuthority!.stateRevision + 2);
      await crons.setEnabled(cron.id, false);
      const stillDisabled = await crons.get(cron.id);
      assert.equal(stillDisabled?.scheduleAuthority?.disabledReason, "active_until_elapsed");
      assert.equal(
        stillDisabled?.scheduleAuthority?.cronRevisionSha256,
        afterDisable?.scheduleAuthority?.cronRevisionSha256,
      );
      assert.equal(stillDisabled?.scheduleAuthority?.stateRevision, afterDisable?.scheduleAuthority?.stateRevision);
      assert.equal(
        (
          await rows("SELECT count(*)::int AS n FROM runs WHERE idempotency_key=$1", [rejectedRequest.idempotencyKey])
        )[0]?.n,
        0,
      );
      const oldRevision = stillDisabled!.scheduleAuthority!.cronRevisionSha256;
      const oldGeneration = stillDisabled!.scheduleAuthority!.configurationGeneration;
      await crons.setEnabled(cron.id, true);
      const reenabled = await crons.get(cron.id);
      assert.equal(reenabled?.scheduleAuthority?.configurationGeneration, oldGeneration + 1);
      assert.notEqual(reenabled?.scheduleAuthority?.cronRevisionSha256, oldRevision);
      assert.equal(reenabled?.scheduleAuthority?.disabledReason, undefined);
    } finally {
      await concurrentAuthority.close();
      await authority.close();
      await maps.pool.close();
    }
  },
);

test("disable failure injection rolls back both signed audit and state", { skip }, async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2020-08-31T20:00:00.000Z"));
  for (const phase of ["disable-receipt", "disable-outbox", "disable-cron"] satisfies ScheduleAuthorityFailpoint[]) {
    const { maps, crons, cron, claim } = await fixture(`disable-rollback-${phase}`, "2020-08-31");
    const rejectedAt = claim.scheduledAt;
    const authority = createPostgresScheduleAuthority({
      connectionString: TEST_URL!,
      signer,
      failpoint: (at) => {
        if (at === phase) throw new Error(`injected ${phase}`);
      },
    });
    await assert.rejects(authority.claim(claim), new RegExp(`injected ${phase}`, "u"));
    assert.equal((await crons.get(cron.id))?.enabled, true);
    assert.equal(
      (await rows("SELECT count(*)::int AS n FROM cron_schedule_disable_receipts WHERE cron_id=$1", [cron.id]))[0]?.n,
      0,
    );
    assert.equal(
      (await rows("SELECT count(*)::int AS n FROM runs WHERE idempotency_key=$1", [`cron:${cron.id}:${rejectedAt}`]))[0]
        ?.n,
      0,
    );
    await authority.close();
    await maps.pool.close();
  }
});
