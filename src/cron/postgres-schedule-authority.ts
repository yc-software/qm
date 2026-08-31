import { createHash, randomUUID } from "node:crypto";
import { createPgPool, withPgTransaction, type PoolClient } from "../persistence/pg-pool.ts";
import {
  createTransactionalOutboxEntry,
  insertTransactionalOutbox,
  TRANSACTIONAL_OUTBOX_SCHEMA,
} from "../persistence/transactional-outbox.ts";
import type { Run } from "../runs/run-store.ts";
import type { SessionType, ScopeId, Cron } from "../types.ts";
import { advanceNextFireAt, recoverNextFireAt } from "./schedule.ts";
import {
  canonicalJson,
  canonicalTimestamp,
  cronConfigurationRevision,
  parseScheduleDisableReceipt,
  parseScheduleFireReceipt,
  scheduledOccurrence,
  scheduleLocalOccurrence,
  scheduleRunRequestSha256,
  scheduleRunRequestTemplateSha256,
  sha256Canonical,
  signScheduleDisableReceipt,
  signScheduleFireReceipt,
  withCronRevision,
  type QmScheduleDisableReceipt,
  type QmScheduleFireReceipt,
  type PersistedScheduleRunRequest,
  type ScheduleAuthoritySigner,
} from "./schedule-authority.ts";

const OUTBOX_TOPIC_FIRE = "qm.schedule-fire.receipt";
const OUTBOX_TOPIC_DISABLE = "qm.schedule-disable.receipt";
const MAP_VERSIONS_TABLE = "durable_map_versions";

export type ScheduleAuthorityFailpoint =
  "slot" | "session" | "run" | "receipt" | "outbox" | "cron" | "disable-receipt" | "disable-outbox" | "disable-cron";

export interface ScheduleRunClaimInput {
  cronId: string;
  scheduledAt: number;
  threadRef: string;
  session: {
    type: SessionType;
    scopeId: ScopeId;
    channelName?: string;
    surface: "cron";
  };
  request: PersistedScheduleRunRequest;
  maxAttempts?: number;
}

export type ScheduleRunClaim =
  | {
      status: "enqueued" | "deduped";
      runId: string;
      sessionId: string;
      threadRef: string;
      fireKey: string;
      receipt: QmScheduleFireReceipt;
      receiptBytes: string;
    }
  | {
      status: "disabled";
      receipt: QmScheduleDisableReceipt;
      receiptBytes: string;
    }
  | {
      status: "skipped";
    };

export interface CurrentScheduleRunAuthority {
  readonly contractType: "qm-current-schedule-run-authority";
  readonly contractVersion: 1;
  readonly runId: string;
  readonly sessionId: string;
  readonly threadRef: string;
  readonly receiptSha256: string;
  readonly attempt: number;
  readonly leaseGenerationSha256: string;
  readonly leaseExpiresAt: number;
}

export interface TrustedScheduleRun {
  authority: CurrentScheduleRunAuthority;
  receipt: QmScheduleFireReceipt;
  receiptBytes: string;
  request: PersistedScheduleRunRequest;
  run: Pick<Run, "id" | "status" | "attempts" | "workerId" | "leaseExpiresAt">;
}

export interface CurrentScheduleRunInvocation {
  readonly authority: CurrentScheduleRunAuthority;
  assertCurrent(handler: object): Promise<TrustedScheduleRun>;
}

interface AuthoritySecretState {
  invocation: object;
  leaseToken: string;
}

interface FireRow {
  fire_key: string;
  cron_id: string;
  scheduled_at: string | number;
  run_id: string;
  session_id: string;
  session_type: string;
  session_scope_id: string;
  thread_ref: string;
  run_request_sha256: string;
  run_request_template_sha256: string;
  cron_revision_sha256: string;
  receipt_json: string;
  receipt_sha256: string;
}

export interface PostgresScheduleAuthority {
  claim(input: ScheduleRunClaimInput): Promise<ScheduleRunClaim>;
  current(input: { runId: string; leaseToken: string; invocation: object }): Promise<CurrentScheduleRunAuthority>;
  assertCurrent(authority: CurrentScheduleRunAuthority, invocation: object): Promise<TrustedScheduleRun>;
  close(): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS crons(id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${MAP_VERSIONS_TABLE}(tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions(
     id TEXT PRIMARY KEY, type TEXT NOT NULL, scope_id TEXT NOT NULL,
     thread_ref TEXT UNIQUE NOT NULL, created_at BIGINT NOT NULL, title TEXT, channel_name TEXT
   )`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS surface TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity BIGINT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS messages INT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turns INT`,
  `CREATE TABLE IF NOT EXISTS runs(
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
     request TEXT NOT NULL, result TEXT, idempotency_key TEXT UNIQUE,
     attempts INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT 3,
     lease_token TEXT, lease_expires_at BIGINT, worker_id TEXT,
     created_at BIGINT NOT NULL, started_at BIGINT, finished_at BIGINT
   )`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS delivery_state TEXT`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS error_attempts INT NOT NULL DEFAULT 0`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS seq BIGSERIAL`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS durable_session_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_runs_durable_session ON runs(durable_session_id) WHERE durable_session_id IS NOT NULL`,
  `DO $qm$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='runs'::regclass AND conname='runs_durable_session_fk') THEN
       ALTER TABLE runs ADD CONSTRAINT runs_durable_session_fk
       FOREIGN KEY(durable_session_id) REFERENCES sessions(id) ON DELETE RESTRICT NOT VALID;
     END IF;
   END $qm$`,
  `CREATE TABLE IF NOT EXISTS cron_schedule_slots(
     fire_key TEXT PRIMARY KEY, cron_id TEXT NOT NULL, scheduled_at BIGINT NOT NULL,
     cron_revision_sha256 TEXT NOT NULL, run_request_sha256 TEXT NOT NULL,
     run_request_template_sha256 TEXT NOT NULL, created_at BIGINT NOT NULL,
     UNIQUE(cron_id, scheduled_at)
   )`,
  `CREATE TABLE IF NOT EXISTS cron_schedule_fire_receipts(
     fire_key TEXT PRIMARY KEY, cron_id TEXT NOT NULL, scheduled_at BIGINT NOT NULL,
     run_id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL,
     session_type TEXT NOT NULL, session_scope_id TEXT NOT NULL, thread_ref TEXT NOT NULL,
     run_request_sha256 TEXT NOT NULL, run_request_template_sha256 TEXT NOT NULL,
     cron_revision_sha256 TEXT NOT NULL, receipt_json TEXT NOT NULL,
     receipt_sha256 TEXT NOT NULL, created_at BIGINT NOT NULL,
     UNIQUE(cron_id, scheduled_at),
     FOREIGN KEY(fire_key) REFERENCES cron_schedule_slots(fire_key) ON DELETE RESTRICT,
     CONSTRAINT schedule_receipt_run_fk FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE RESTRICT,
     CONSTRAINT schedule_receipt_session_fk FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE RESTRICT
   )`,
  `ALTER TABLE cron_schedule_fire_receipts ADD COLUMN IF NOT EXISTS session_type TEXT`,
  `ALTER TABLE cron_schedule_fire_receipts ADD COLUMN IF NOT EXISTS session_scope_id TEXT`,
  `DO $qm$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cron_schedule_fire_receipts'::regclass AND conname='schedule_receipt_run_fk') THEN
       ALTER TABLE cron_schedule_fire_receipts ADD CONSTRAINT schedule_receipt_run_fk
       FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE RESTRICT NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cron_schedule_fire_receipts'::regclass AND conname='schedule_receipt_session_fk') THEN
       ALTER TABLE cron_schedule_fire_receipts ADD CONSTRAINT schedule_receipt_session_fk
       FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE RESTRICT NOT VALID;
     END IF;
   END $qm$`,
  `CREATE TABLE IF NOT EXISTS cron_schedule_disable_receipts(
     cron_revision_sha256 TEXT PRIMARY KEY, cron_id TEXT NOT NULL,
     first_rejected_scheduled_at BIGINT NOT NULL, receipt_json TEXT NOT NULL,
     receipt_sha256 TEXT NOT NULL, created_at BIGINT NOT NULL
   )`,
  ...TRANSACTIONAL_OUTBOX_SCHEMA,
] as const;

function exactInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
}

async function databaseNow(client: PoolClient): Promise<number> {
  const row = (
    await client.query<{ now_ms: string }>(
      "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms",
    )
  ).rows[0];
  const now = Number(row?.now_ms);
  exactInteger(now, "database clock");
  return now;
}

async function lockCronMapVersion(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO ${MAP_VERSIONS_TABLE}(tbl,v) VALUES('crons',0)
     ON CONFLICT(tbl) DO NOTHING`,
  );
  await client.query(`SELECT v FROM ${MAP_VERSIONS_TABLE} WHERE tbl='crons' FOR UPDATE`);
}

async function bumpCronMapVersion(client: PoolClient): Promise<void> {
  await client.query(`UPDATE ${MAP_VERSIONS_TABLE} SET v=v+1 WHERE tbl='crons'`);
}

function fireKey(cronId: string, scheduledAt: number): string {
  return `cron:${cronId}:${scheduledAt}`;
}

function parseFireRow(row: FireRow, status: "enqueued" | "deduped", signer: ScheduleAuthoritySigner): ScheduleRunClaim {
  const receiptBytes = row.receipt_json;
  const receipt = parseScheduleFireReceipt(Buffer.from(receiptBytes, "utf8"), signer.publicKey);
  if (
    receipt.receiptSha256 !== row.receipt_sha256 ||
    receipt.fireKey !== row.fire_key ||
    receipt.qmCronId !== row.cron_id ||
    receipt.scheduledAt !== canonicalTimestamp(Number(row.scheduled_at)) ||
    receipt.runId !== row.run_id ||
    receipt.sessionId !== row.session_id ||
    receipt.threadRef !== row.thread_ref ||
    receipt.runRequestSha256 !== row.run_request_sha256 ||
    receipt.runRequestTemplateSha256 !== row.run_request_template_sha256 ||
    receipt.cronRevisionSha256 !== row.cron_revision_sha256
  ) {
    throw new Error("stored schedule-fire receipt is not canonical");
  }
  return {
    status,
    runId: row.run_id,
    sessionId: row.session_id,
    threadRef: row.thread_ref,
    fireKey: row.fire_key,
    receipt,
    receiptBytes,
  };
}

function assertRedelivery(
  row: FireRow,
  input: ScheduleRunClaimInput,
  requestSha256: string,
  templateSha256: string,
): void {
  if (
    row.cron_id !== input.cronId ||
    Number(row.scheduled_at) !== input.scheduledAt ||
    row.thread_ref !== input.threadRef ||
    row.session_type !== input.session.type ||
    row.session_scope_id !== input.session.scopeId ||
    row.run_request_sha256 !== requestSha256 ||
    row.run_request_template_sha256 !== templateSha256
  ) {
    throw new Error("schedule fire key is already bound to a conflicting run");
  }
}

async function getFire(client: PoolClient, key: string): Promise<FireRow | undefined> {
  return (await client.query<FireRow>("SELECT * FROM cron_schedule_fire_receipts WHERE fire_key=$1", [key])).rows[0];
}

function signerMatchesCron(
  signer: ScheduleAuthoritySigner,
  cron: Cron,
): asserts cron is Cron & { scheduleAuthority: NonNullable<Cron["scheduleAuthority"]> } {
  const authority = cron.scheduleAuthority;
  if (!authority) throw new Error("cron has no schedule authority configuration");
  if (
    authority.authorityRef !== signer.authorityRef ||
    authority.issuerRef !== signer.issuerRef ||
    authority.keyId !== signer.keyId
  ) {
    throw new Error("cron schedule authority does not match the configured signer");
  }
  const checked = withCronRevision(cron, authority);
  if (checked.cronRevisionSha256 !== authority.cronRevisionSha256) {
    throw new Error("cron configuration revision is stale");
  }
  if (sha256Canonical(cronConfigurationRevision(cron, authority)) !== authority.cronRevisionSha256) {
    throw new Error("cron configuration revision is invalid");
  }
}

function requestMatchesClaim(input: ScheduleRunClaimInput, key: string): void {
  if (
    input.request.surface !== "cron" ||
    input.request.idempotencyKey !== key ||
    input.request.conversation.threadRef !== input.threadRef ||
    input.session.surface !== "cron"
  ) {
    throw new Error("scheduled run request does not match its claimed slot");
  }
  if (input.request.conversation.kind !== input.session.type) {
    throw new Error("scheduled run session type does not match its request");
  }
}

function leaseGenerationSha256(runId: string, attempt: number, workerId: string, leaseToken: string): string {
  return createHash("sha256").update(canonicalJson({ attempt, leaseToken, runId, workerId }), "utf8").digest("hex");
}

export function createPostgresScheduleAuthority(input: {
  connectionString: string;
  signer: ScheduleAuthoritySigner;
  failpoint?: (phase: ScheduleAuthorityFailpoint) => void | Promise<void>;
}): PostgresScheduleAuthority {
  const pg = createPgPool(input.connectionString, [...SCHEMA]);
  const secrets = new WeakMap<CurrentScheduleRunAuthority, AuthoritySecretState>();
  const fail = async (phase: ScheduleAuthorityFailpoint): Promise<void> => input.failpoint?.(phase);

  async function disableExpired(
    client: PoolClient,
    cron: Cron & { scheduleAuthority: NonNullable<Cron["scheduleAuthority"]> },
    scheduledAt: number,
    disabledAt: number,
  ): Promise<ScheduleRunClaim> {
    const authority = cron.scheduleAuthority;
    const existing = (
      await client.query<{
        cron_id: string;
        first_rejected_scheduled_at: string;
        receipt_json: string;
        receipt_sha256: string;
        created_at: string;
      }>(
        `SELECT cron_id,first_rejected_scheduled_at,receipt_json,receipt_sha256,created_at
           FROM cron_schedule_disable_receipts WHERE cron_revision_sha256=$1`,
        [authority.cronRevisionSha256],
      )
    ).rows[0];
    if (existing) {
      const receiptBytes = existing.receipt_json;
      const receipt = parseScheduleDisableReceipt(Buffer.from(receiptBytes, "utf8"), input.signer.publicKey);
      if (
        receipt.receiptSha256 !== existing.receipt_sha256 ||
        receipt.qmCronId !== existing.cron_id ||
        receipt.cronRevisionSha256 !== authority.cronRevisionSha256 ||
        receipt.firstRejectedScheduledAt !== canonicalTimestamp(Number(existing.first_rejected_scheduled_at)) ||
        receipt.disabledAt !== canonicalTimestamp(Number(existing.created_at))
      ) {
        throw new Error("stored schedule-disable receipt is not canonical");
      }
      return { status: "disabled", receipt, receiptBytes };
    }
    if (!cron.enabled || cron.archived) throw new Error("cron is not active");
    const lastEligible = (
      await client.query<{ scheduled_at: string }>(
        `SELECT scheduled_at FROM cron_schedule_fire_receipts
         WHERE cron_id=$1 AND cron_revision_sha256=$2 ORDER BY scheduled_at DESC LIMIT 1`,
        [cron.id, authority.cronRevisionSha256],
      )
    ).rows[0];
    const priorStateRevision = authority.stateRevision;
    const resultingStateRevision = priorStateRevision + 1;
    const receipt = signScheduleDisableReceipt(input.signer, {
      profileRef: authority.profileRef,
      profileSha256: authority.profileSha256,
      scheduleRef: authority.scheduleDefinition.scheduleRef,
      qmCronId: cron.id,
      scheduleDefinitionSha256: authority.scheduleDefinitionSha256,
      cronRevisionSha256: authority.cronRevisionSha256,
      lastEligibleScheduledAt: lastEligible ? canonicalTimestamp(Number(lastEligible.scheduled_at)) : null,
      firstRejectedScheduledAt: canonicalTimestamp(scheduledAt),
      disabledAt: canonicalTimestamp(disabledAt),
      priorStateRevision,
      resultingStateRevision,
    });
    const receiptBytes = canonicalJson(receipt);
    await client.query(
      `INSERT INTO cron_schedule_disable_receipts(
         cron_revision_sha256,cron_id,first_rejected_scheduled_at,receipt_json,receipt_sha256,created_at
       ) VALUES($1,$2,$3,$4,$5,$6)`,
      [authority.cronRevisionSha256, cron.id, scheduledAt, receiptBytes, receipt.receiptSha256, disabledAt],
    );
    await fail("disable-receipt");
    await insertTransactionalOutbox(
      client,
      createTransactionalOutboxEntry({
        id: `qm-schedule-disable:${authority.cronRevisionSha256}`,
        topic: OUTBOX_TOPIC_DISABLE,
        payloadJson: receiptBytes,
        createdAt: disabledAt,
      }),
    );
    await fail("disable-outbox");
    const nextCron: Cron = {
      ...cron,
      enabled: false,
      scheduleAuthority: {
        ...authority,
        stateRevision: resultingStateRevision,
        disabledReason: "active_until_elapsed",
      },
    };
    await client.query("UPDATE crons SET json=$2::jsonb WHERE id=$1", [cron.id, canonicalJson(nextCron)]);
    await bumpCronMapVersion(client);
    await fail("disable-cron");
    return { status: "disabled", receipt, receiptBytes };
  }

  async function lookupCurrent(client: PoolClient, runId: string) {
    return (
      await client.query(
        `SELECT r.id,r.status,r.request,r.idempotency_key,r.attempts,r.lease_token,r.lease_expires_at,r.worker_id,
                r.durable_session_id,r.session_id AS run_thread_ref,
                f.fire_key,f.cron_id,f.scheduled_at,f.session_id AS receipt_session_id,
                f.session_type AS receipt_session_type,f.session_scope_id AS receipt_session_scope_id,f.thread_ref,
                f.cron_revision_sha256,f.receipt_json,f.receipt_sha256,
                f.run_request_sha256,f.run_request_template_sha256,
                s.cron_id AS slot_cron_id,s.scheduled_at AS slot_scheduled_at,
                s.cron_revision_sha256 AS slot_cron_revision_sha256,
                s.run_request_sha256 AS slot_run_request_sha256,
                s.run_request_template_sha256 AS slot_run_request_template_sha256,
                sess.id AS committed_session_id,sess.thread_ref AS committed_session_thread_ref,
                sess.type AS committed_session_type,sess.scope_id AS committed_session_scope_id,
                sess.surface AS committed_session_surface
           FROM runs r
           JOIN cron_schedule_fire_receipts f ON f.run_id=r.id
           JOIN cron_schedule_slots s ON s.fire_key=f.fire_key
           JOIN sessions sess ON sess.id=r.durable_session_id
          WHERE r.id=$1
          FOR SHARE OF r,f,s,sess`,
        [runId],
      )
    ).rows[0];
  }

  function mintAuthority(row: Record<string, unknown>, runId: string, leaseToken: string): CurrentScheduleRunAuthority {
    const attempt = Number(row.attempts);
    const leaseExpiresAt = Number(row.lease_expires_at);
    if (!Number.isSafeInteger(attempt) || attempt <= 0) throw new Error("run attempt is invalid");
    exactInteger(leaseExpiresAt, "run lease expiry");
    return Object.freeze({
      contractType: "qm-current-schedule-run-authority" as const,
      contractVersion: 1 as const,
      runId,
      sessionId: row.durable_session_id as string,
      threadRef: row.thread_ref as string,
      receiptSha256: row.receipt_sha256 as string,
      attempt,
      leaseGenerationSha256: leaseGenerationSha256(runId, attempt, row.worker_id as string, leaseToken),
      leaseExpiresAt,
    });
  }

  async function trustedSnapshot(
    authority: CurrentScheduleRunAuthority,
    invocation: object,
    secret: AuthoritySecretState,
    row: Record<string, unknown> | undefined,
    client: PoolClient,
  ): Promise<TrustedScheduleRun> {
    try {
      const leaseExpiresAt = Number(row?.lease_expires_at);
      if (
        !row ||
        row.status !== "running" ||
        row.lease_token !== secret.leaseToken ||
        Number(row.attempts) !== authority.attempt ||
        row.worker_id === null ||
        !Number.isSafeInteger(leaseExpiresAt) ||
        row.durable_session_id !== authority.sessionId ||
        row.receipt_session_id !== authority.sessionId ||
        row.committed_session_id !== authority.sessionId ||
        row.committed_session_thread_ref !== authority.threadRef ||
        row.committed_session_type !== row.receipt_session_type ||
        row.committed_session_scope_id !== row.receipt_session_scope_id ||
        row.committed_session_surface !== "cron" ||
        row.run_thread_ref !== authority.threadRef ||
        row.run_thread_ref !== row.thread_ref ||
        row.receipt_sha256 !== authority.receiptSha256
      ) {
        throw new Error("schedule run authority is no longer current");
      }
      const expectedLeaseGeneration = leaseGenerationSha256(
        authority.runId,
        authority.attempt,
        row.worker_id as string,
        secret.leaseToken,
      );
      if (expectedLeaseGeneration !== authority.leaseGenerationSha256) {
        throw new Error("schedule run lease generation changed");
      }
      const request = JSON.parse(row.request as string) as PersistedScheduleRunRequest;
      const receiptBytes = row.receipt_json as string;
      const receipt = parseScheduleFireReceipt(Buffer.from(receiptBytes, "utf8"), input.signer.publicKey);
      if (
        receiptBytes !== row.receipt_json ||
        canonicalJson(request) !== row.request ||
        scheduleRunRequestSha256(request) !== row.run_request_sha256 ||
        scheduleRunRequestTemplateSha256(request) !== row.run_request_template_sha256 ||
        receipt.runRequestSha256 !== row.run_request_sha256 ||
        receipt.runRequestTemplateSha256 !== row.run_request_template_sha256 ||
        receipt.fireKey !== request.idempotencyKey ||
        receipt.fireKey !== row.idempotency_key ||
        receipt.fireKey !== row.fire_key ||
        receipt.qmCronId !== row.cron_id ||
        receipt.qmCronId !== row.slot_cron_id ||
        receipt.scheduledAt !== canonicalTimestamp(Number(row.scheduled_at)) ||
        receipt.scheduledAt !== canonicalTimestamp(Number(row.slot_scheduled_at)) ||
        receipt.cronRevisionSha256 !== row.cron_revision_sha256 ||
        receipt.cronRevisionSha256 !== row.slot_cron_revision_sha256 ||
        row.run_request_sha256 !== row.slot_run_request_sha256 ||
        row.run_request_template_sha256 !== row.slot_run_request_template_sha256 ||
        request.conversation.threadRef !== authority.threadRef ||
        request.conversation.kind !== row.receipt_session_type ||
        receipt.runId !== authority.runId ||
        receipt.sessionId !== authority.sessionId ||
        receipt.threadRef !== authority.threadRef ||
        receipt.receiptSha256 !== authority.receiptSha256
      ) {
        throw new Error("durable schedule run lineage is invalid");
      }
      const returnAt = await databaseNow(client);
      const receiptIssuedAt = Date.parse(receipt.issuedAt);
      const receiptExpiresAt = Date.parse(receipt.expiresAt);
      if (receiptIssuedAt > returnAt || returnAt >= receiptExpiresAt) {
        throw new Error("schedule-fire receipt is not current");
      }
      if (leaseExpiresAt <= returnAt) throw new Error("schedule run authority is no longer current");
      const refreshed =
        leaseExpiresAt === authority.leaseExpiresAt
          ? authority
          : mintAuthority(row, authority.runId, secret.leaseToken);
      if (refreshed !== authority) {
        secrets.delete(authority);
        secrets.set(refreshed, { invocation, leaseToken: secret.leaseToken });
      }
      return {
        authority: refreshed,
        receipt,
        receiptBytes,
        request,
        run: {
          id: authority.runId,
          status: "running",
          attempts: authority.attempt,
          workerId: row.worker_id as string,
          leaseExpiresAt,
        },
      };
    } catch (error) {
      secrets.delete(authority);
      throw error;
    }
  }

  async function trustedCurrent(
    authority: CurrentScheduleRunAuthority,
    invocation: object,
  ): Promise<TrustedScheduleRun> {
    const secret = secrets.get(authority);
    if (!secret || secret.invocation !== invocation) throw new Error("schedule run authority is foreign or serialized");
    return withPgTransaction(await pg.pool(), async (client) =>
      trustedSnapshot(authority, invocation, secret, await lookupCurrent(client, authority.runId), client),
    );
  }

  return {
    async claim(claimInput) {
      const claimedInput = JSON.parse(canonicalJson(claimInput)) as ScheduleRunClaimInput;
      exactInteger(claimedInput.scheduledAt, "scheduledAt");
      const key = fireKey(claimedInput.cronId, claimedInput.scheduledAt);
      requestMatchesClaim(claimedInput, key);
      const requestBytes = canonicalJson(claimedInput.request);
      const requestSha256 = scheduleRunRequestSha256(claimedInput.request);
      const templateSha256 = scheduleRunRequestTemplateSha256(claimedInput.request);
      return withPgTransaction(await pg.pool(), async (client) => {
        const prior = await getFire(client, key);
        if (prior) {
          assertRedelivery(prior, claimedInput, requestSha256, templateSha256);
          return parseFireRow(prior, "deduped", input.signer);
        }
        await lockCronMapVersion(client);
        const cronRow = (
          await client.query<{ json: Cron }>("SELECT json FROM crons WHERE id=$1 FOR UPDATE", [claimedInput.cronId])
        ).rows[0];
        if (!cronRow) throw new Error("cron does not exist");
        const committedAfterLock = await getFire(client, key);
        if (committedAfterLock) {
          assertRedelivery(committedAfterLock, claimedInput, requestSha256, templateSha256);
          return parseFireRow(committedAfterLock, "deduped", input.signer);
        }
        const cron = cronRow.json;
        const firedAt = await databaseNow(client);
        if (firedAt < claimedInput.scheduledAt) throw new Error("a schedule cannot fire before its slot");
        signerMatchesCron(input.signer, cron);
        const authority = cron.scheduleAuthority;
        if (claimedInput.session.scopeId !== cron.ownerScopeId) {
          throw new Error("scheduled run session scope does not match its cron owner scope");
        }
        if (
          recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt) !==
          claimedInput.scheduledAt
        ) {
          throw new Error("scheduled slot is not the cron's current immutable cursor");
        }
        if (templateSha256 !== authority.runRequestTemplateSha256) {
          throw new Error("scheduled run request template does not match the immutable cron revision");
        }
        const occurrence = scheduledOccurrence(authority.scheduleDefinition, claimedInput.scheduledAt);
        if (!occurrence.eligible) {
          const localDate = scheduleLocalOccurrence(
            claimedInput.scheduledAt,
            authority.scheduleDefinition.timeZone,
          ).localDate;
          if (localDate > authority.scheduleDefinition.activeUntil) {
            return disableExpired(client, cron, claimedInput.scheduledAt, firedAt);
          }
          if (!cron.enabled || cron.archived || authority.disabledReason) throw new Error("cron is not active");
          const nextFireAt = advanceNextFireAt(cron.schedule, claimedInput.scheduledAt);
          const nextCron: Cron = {
            ...cron,
            scheduleAuthority: { ...authority, stateRevision: authority.stateRevision + 1 },
            ...(nextFireAt === undefined ? {} : { nextFireAt }),
          };
          if (nextFireAt === undefined) delete nextCron.nextFireAt;
          await client.query("UPDATE crons SET json=$2::jsonb WHERE id=$1", [cron.id, canonicalJson(nextCron)]);
          await bumpCronMapVersion(client);
          return { status: "skipped" as const };
        }
        if (!cron.enabled || cron.archived || authority.disabledReason) throw new Error("cron is not active");
        const insertedSlot = await client.query(
          `INSERT INTO cron_schedule_slots(
             fire_key,cron_id,scheduled_at,cron_revision_sha256,run_request_sha256,
             run_request_template_sha256,created_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING fire_key`,
          [
            key,
            cron.id,
            claimedInput.scheduledAt,
            authority.cronRevisionSha256,
            requestSha256,
            templateSha256,
            firedAt,
          ],
        );
        if (!insertedSlot.rows[0]) {
          const concurrent = await getFire(client, key);
          if (!concurrent) throw new Error("schedule slot was claimed without a committed receipt");
          assertRedelivery(concurrent, claimedInput, requestSha256, templateSha256);
          return parseFireRow(concurrent, "deduped", input.signer);
        }
        await fail("slot");
        const sessionId = randomUUID();
        const runId = randomUUID();
        await client.query(
          `INSERT INTO sessions(
             id,type,scope_id,thread_ref,created_at,channel_name,surface,last_activity,messages,turns
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$5,0,0)`,
          [
            sessionId,
            claimedInput.session.type,
            claimedInput.session.scopeId,
            claimedInput.threadRef,
            firedAt,
            claimedInput.session.channelName ?? null,
            claimedInput.session.surface,
          ],
        );
        await fail("session");
        await client.query(
          `INSERT INTO runs(
             id,session_id,durable_session_id,status,request,idempotency_key,attempts,max_attempts,created_at
           ) VALUES($1,$2,$3,'pending',$4,$5,0,$6,$7)`,
          [runId, claimedInput.threadRef, sessionId, requestBytes, key, claimedInput.maxAttempts ?? 3, firedAt],
        );
        await fail("run");
        const resultingStateRevision = authority.stateRevision + 1;
        const receipt = signScheduleFireReceipt(input.signer, {
          profileRef: authority.profileRef,
          profileSha256: authority.profileSha256,
          scheduleRef: authority.scheduleDefinition.scheduleRef,
          qmCronId: cron.id,
          scheduleDefinitionSha256: authority.scheduleDefinitionSha256,
          cronRevisionSha256: authority.cronRevisionSha256,
          cronStateRevision: resultingStateRevision,
          runRequestTemplateSha256: templateSha256,
          fireKey: key,
          scheduledAt: canonicalTimestamp(claimedInput.scheduledAt),
          firedAt: canonicalTimestamp(firedAt),
          issuedAt: canonicalTimestamp(firedAt),
          expiresAt: canonicalTimestamp(firedAt + authority.receiptLifetimeMs),
          localOccurrence: occurrence.occurrence,
          runId,
          sessionId,
          threadRef: claimedInput.threadRef,
          runRequestSha256: requestSha256,
        });
        const receiptBytes = canonicalJson(receipt);
        await client.query(
          `INSERT INTO cron_schedule_fire_receipts(
             fire_key,cron_id,scheduled_at,run_id,session_id,session_type,session_scope_id,thread_ref,run_request_sha256,
             run_request_template_sha256,cron_revision_sha256,receipt_json,receipt_sha256,created_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            key,
            cron.id,
            claimedInput.scheduledAt,
            runId,
            sessionId,
            claimedInput.session.type,
            claimedInput.session.scopeId,
            claimedInput.threadRef,
            requestSha256,
            templateSha256,
            authority.cronRevisionSha256,
            receiptBytes,
            receipt.receiptSha256,
            firedAt,
          ],
        );
        await fail("receipt");
        await insertTransactionalOutbox(
          client,
          createTransactionalOutboxEntry({
            id: `qm-schedule-fire:${key}`,
            topic: OUTBOX_TOPIC_FIRE,
            payloadJson: receiptBytes,
            createdAt: firedAt,
          }),
        );
        await fail("outbox");
        const nextFireAt = advanceNextFireAt(cron.schedule, claimedInput.scheduledAt);
        const nextCron: Cron = {
          ...cron,
          lastFiredAt: firedAt,
          scheduleAuthority: { ...authority, stateRevision: resultingStateRevision },
          ...(nextFireAt === undefined ? {} : { nextFireAt }),
        };
        if (nextFireAt === undefined) delete nextCron.nextFireAt;
        await client.query("UPDATE crons SET json=$2::jsonb WHERE id=$1", [cron.id, canonicalJson(nextCron)]);
        await bumpCronMapVersion(client);
        await fail("cron");
        return {
          status: "enqueued" as const,
          runId,
          sessionId,
          threadRef: claimedInput.threadRef,
          fireKey: key,
          receipt,
          receiptBytes,
        };
      });
    },

    async current(currentInput) {
      if (!currentInput.invocation || typeof currentInput.invocation !== "object") {
        throw new TypeError("invocation must be an object identity");
      }
      return withPgTransaction(await pg.pool(), async (client) => {
        const row = await lookupCurrent(client, currentInput.runId);
        if (
          !row ||
          row.status !== "running" ||
          row.lease_token !== currentInput.leaseToken ||
          row.worker_id === null ||
          row.lease_expires_at === null ||
          row.durable_session_id === null ||
          row.durable_session_id !== row.receipt_session_id ||
          row.durable_session_id !== row.committed_session_id ||
          row.run_thread_ref !== row.committed_session_thread_ref ||
          row.committed_session_surface !== "cron" ||
          row.run_thread_ref !== row.thread_ref
        ) {
          throw new Error("run has no current committed schedule authority");
        }
        const authority = mintAuthority(row, currentInput.runId, currentInput.leaseToken);
        const secret = { invocation: currentInput.invocation, leaseToken: currentInput.leaseToken };
        secrets.set(authority, secret);
        return (await trustedSnapshot(authority, currentInput.invocation, secret, row, client)).authority;
      });
    },

    assertCurrent: trustedCurrent,
    close: () => pg.close(),
  };
}
