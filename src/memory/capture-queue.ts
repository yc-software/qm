import { TENANCY, tenantRowSecurity } from "../tenants/migrations.ts";
import { mergeProvenance } from "./facts.ts";
import { inTenant } from "../tenants/claim.ts";
import { createHash } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { memoryCaptureGroup, type MemoryCaptureTurn } from "./capture-context.ts";
import { poolBoss, assertJobQueueInstalled } from "../persistence/job-queue.ts";
import { createPgPool, queryPoolSize, withPgTransaction } from "../persistence/pg-pool.ts";
import { ambientTenant, withoutTenant } from "../tenants/context.ts";
import { reportFailure, swallowAs } from "../util/errors.ts";

export const MEMORY_CAPTURE_QUEUE = "memory-capture";

export interface MemoryCaptureBatch {
  tenantId: string;
  turns: MemoryCaptureTurn[];
}

export function memoryCaptureKey(tenantId: string, turn: MemoryCaptureTurn): string {
  return createHash("sha256")
    .update(JSON.stringify([tenantId, memoryCaptureGroup(turn)]))
    .digest("hex");
}

export function createMemoryCaptureQueue(input: {
  databaseUrl: string;
  quietMs: number;
  maxTurns: number;
  capture: (turns: MemoryCaptureTurn[], id: string, signal: AbortSignal) => Promise<void>;
}) {
  if (!Number.isFinite(input.quietMs)) throw new Error("Memory capture quietMs must be finite");
  if (!Number.isFinite(input.maxTurns)) throw new Error("Memory capture maxTurns must be finite");
  const pg = createPgPool(input.databaseUrl, [
    ...TENANCY,
    {
      id: "memory/capture/0001-handoffs",
      statements: [
        `CREATE TABLE memory_capture_handoffs (
          tenant_id UUID NOT NULL,
          id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, id)
        )`,
        ...tenantRowSecurity("memory_capture_handoffs"),
        `DO $$ BEGIN
          IF to_regclass('pgboss.job') IS NOT NULL THEN
            INSERT INTO memory_capture_handoffs (tenant_id, id)
            SELECT (j.data->>'tenantId')::uuid, j.singleton_key || ':' || (t->>'idempotencyKey')
              FROM pgboss.job j CROSS JOIN LATERAL jsonb_array_elements(j.data->'turns') t
             WHERE j.name = 'memory-capture' AND j.data->>'tenantId' IS NOT NULL
               AND j.singleton_key IS NOT NULL AND t->>'idempotencyKey' IS NOT NULL
            ON CONFLICT DO NOTHING;
          END IF;
        END $$`,
      ],
    },
  ]);
  const schema = "pgboss";
  const boss: PgBoss = poolBoss(() => pg, { schema, migrate: false });
  boss.on("error", (error) => reportFailure("memory capture queue", error));
  let ready: Promise<void> | undefined;
  let worker: Promise<string> | undefined;
  let consuming = false;
  const lifetime = new AbortController();

  const initialize = (): Promise<void> => {
    if (ready) return ready;
    const starting = withoutTenant(async () => {
      await assertJobQueueInstalled(boss, schema);
      await boss.start();
      await boss.createQueue(MEMORY_CAPTURE_QUEUE, { policy: "singleton", notify: true });
    });
    ready = starting;
    starting.catch(() => {
      if (ready === starting) ready = undefined;
    });
    return starting;
  };

  const start = async (): Promise<void> => {
    consuming = true;
    await initialize();
    if (!consuming) return;
    if (worker) {
      await worker;
      return;
    }
    const starting = withoutTenant(() =>
      boss.work<MemoryCaptureBatch>(
        MEMORY_CAPTURE_QUEUE,
        {
          pollingIntervalSeconds: 1,
          localConcurrency: Math.max(1, Math.floor(queryPoolSize() / 2)),
        },
        async ([job]) => {
          if (!job) return;
          const signal = AbortSignal.any([job.signal, lifetime.signal]);
          try {
            await inTenant(job.data.tenantId, () => input.capture(job.data.turns, job.id, signal));
          } catch (error) {
            if (!signal.aborted) reportFailure("memory capture job failed", error, job.id);
            throw error;
          }
        },
      ),
    );
    worker = starting;
    starting.catch(() => {
      if (worker === starting) worker = undefined;
    });
    await starting;
  };

  return {
    async enqueue(original: MemoryCaptureTurn): Promise<void> {
      const turn: MemoryCaptureTurn = {
        ...original,
        ...(original.document
          ? {
              document: {
                teamScopeId: original.document.teamScopeId,
                documentScopeId: original.document.documentScopeId,
                mode: original.document.mode,
              },
            }
          : {}),
        ...(original.inheritedFacts === undefined
          ? {}
          : {
              inheritedFacts: original.inheritedFacts.length ? [mergeProvenance(original.inheritedFacts)] : [],
            }),
      };
      const tenantId = ambientTenant().id;
      const key = memoryCaptureKey(tenantId, turn);
      await initialize();
      await withPgTransaction(await pg.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`memory-capture:${key}`]);
        if (turn.idempotencyKey) {
          const id = `${key}:${turn.idempotencyKey}`;
          const inserted = await client.query(
            `INSERT INTO memory_capture_handoffs (tenant_id, id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`,
            [tenantId, id],
          );
          if (!inserted.rowCount) return;
        }
        const db = { executeSql: (text: string, values?: unknown[]) => client.query(text, values) };
        const pending = await boss.findJobs<MemoryCaptureBatch>(MEMORY_CAPTURE_QUEUE, { key, queued: true, db });
        for (const job of pending) {
          if (job.data.tenantId !== tenantId) throw new Error("Memory capture tenant mismatch");
          const duplicate =
            turn.idempotencyKey && job.data.turns.find((item) => item.idempotencyKey === turn.idempotencyKey);
          if (duplicate) {
            return;
          }
        }
        const previous = pending
          .toSorted((a, b) => b.createdOn.getTime() - a.createdOn.getTime())
          .find(
            (job) =>
              job.state === "created" &&
              job.retryCount === 0 &&
              job.startedOn === null &&
              job.data.turns.length < input.maxTurns,
          );
        if (previous) {
          const locked = await boss.update(MEMORY_CAPTURE_QUEUE, undefined, {
            id: previous.id,
            db,
          });
          const current = locked.updated
            ? await boss.getJobById<MemoryCaptureBatch>(MEMORY_CAPTURE_QUEUE, previous.id, { db })
            : null;
          if (current?.state === "created" && current.retryCount === 0 && current.startedOn === null) {
            const turns = [...current.data.turns, turn];
            await boss.update(
              MEMORY_CAPTURE_QUEUE,
              { tenantId, turns },
              {
                id: previous.id,
                db,
                startAfter: new Date(Date.now() + (turns.length >= input.maxTurns ? 0 : Math.max(0, input.quietMs))),
              },
            );
            return;
          }
        }
        const id = await boss.send(
          MEMORY_CAPTURE_QUEUE,
          { tenantId, turns: [turn] },
          {
            singletonKey: key,
            db,
            startAfter: new Date(Date.now() + (input.maxTurns <= 1 ? 0 : Math.max(0, input.quietMs))),
          },
        );
        if (!id) throw new Error("Memory capture was not queued");
      });
      if (consuming && !worker) void start().catch((error) => reportFailure("memory capture worker restart", error));
    },
    start,
    async stopClaims(): Promise<void> {
      consuming = false;
      if (!worker) return;
      await worker;
      await boss.offWork(MEMORY_CAPTURE_QUEUE, { wait: false });
      worker = undefined;
    },
    async stop(): Promise<void> {
      consuming = false;
      lifetime.abort();
      await worker?.catch(swallowAs("memory capture worker start during stop", undefined));
      await ready?.catch(swallowAs("memory capture queue start during stop", undefined));
      worker = undefined;
      ready = undefined;
      await boss.stop({ close: true });
      await pg.close();
    },
  };
}
