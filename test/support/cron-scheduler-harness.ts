import { createScheduler } from "../../src/cron/scheduler.ts";
import { createCronStore, type CronStore } from "../../src/cron/cron-store.ts";
import { recordingOutbound } from "./recording-outbound.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import type { TurnRequest, TurnResult } from "../../src/types.ts";
import { type DirectoryStore } from "../../src/directory/directory-store.ts";
import { singleProcessDeps } from "./single-process.ts";
import { testDatabaseUrl } from "./test-database.ts";
import { createPostgresCronFireStore } from "../../src/cron/fire-store.ts";
import { manualFireJobs } from "./cron-slots.ts";

export function harness(
  reply: string | ((req: TurnRequest) => Promise<TurnResult>) = "CRON-OUTPUT-XYZ",
  directory?: DirectoryStore,
  maxFiresPerTick?: number,
) {
  const databaseUrl = testDatabaseUrl();
  const crons = createCronStore(databaseUrl, { fires: createPostgresCronFireStore(databaseUrl) });
  const outbound = recordingOutbound();
  const identity = createIdentityService(databaseUrl);
  const calls: TurnRequest[] = [];
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    if (typeof reply === "function") return reply(req);
    return { status: "ok", reply };
  };
  const scheduler = createScheduler({
    jobs: manualFireJobs(),
    ...singleProcessDeps(),
    crons,
    outbound,
    idempotency: createIdempotencyStore(databaseUrl),
    identity,
    run,
    ...(directory ? { directory } : {}),
    ...(maxFiresPerTick !== undefined ? { maxFiresPerTick } : {}),
  });
  return { crons, outbound, calls, scheduler, identity };
}

export function busyOnce(calls: TurnRequest[]) {
  return async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    return calls.length === 1
      ? { status: "refused", refusalKind: "session_busy", reason: "busy" }
      : { status: "ok", reply: "OUT" };
  };
}

/** The deps every scheduler test shares: single-process locks, recording outbound, real idempotency and identity. */
export function schedulerDeps(crons: CronStore, databaseUrl: string) {
  return {
    ...singleProcessDeps(),
    crons,
    outbound: recordingOutbound(),
    idempotency: createIdempotencyStore(databaseUrl),
    identity: createIdentityService(databaseUrl),
  };
}
