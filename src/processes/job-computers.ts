import type { ProcessSandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import {
  assertBotMayUseComputer,
  botMayUseComputers,
  SandboxAccessError,
  type SandboxResources,
} from "../sandbox/sandbox-resources.ts";
import type { SwarmService } from "../swarms/swarm-service.ts";
import { claimThenLoad, type ClaimedRow } from "../tenants/claim.ts";
import type { ProcessRecord, ProcessRegistry } from "./process-registry.ts";
import { reconcileProcesses } from "./reconcile.ts";

const STARTUP_GRACE_MS = 2 * 60_000;
const PROVISION_LIMIT_MS = 15 * 60_000;
const RETRY_EVERY_MS = 5 * 60_000;

const live = (job: ProcessRecord): boolean => job.status === "running" || Boolean(job.credentialsPending);

export function claimBarredBotJobs(deps: {
  processes: Pick<ProcessRegistry, "claimLiveBotJobs" | "listLive">;
  resources: Pick<SandboxResources, "get" | "resolve">;
  swarms: Pick<SwarmService, "botMayUseComputer"> | undefined;
}): Promise<ClaimedRow[]> {
  return claimThenLoad(deps.processes.claimLiveBotJobs, async (ids) => {
    const claimed = new Set(ids);
    const jobs = (await deps.processes.listLive()).filter((job) => job.botActor && claimed.has(job.processId));
    const verdicts = new Map<string, Promise<boolean>>();
    const barred = (job: ProcessRecord): Promise<boolean> => {
      const key = JSON.stringify([job.scopeId, job.sandboxId, job.botActor, job.sessionRef]);
      const known = verdicts.get(key);
      if (known) return known;
      const turn = { actorId: job.botActor!, threadRef: job.sessionRef ?? "", sessionId: "" };
      const botMayUse = botMayUseComputers(deps.swarms, turn);
      const verdict = assertBotMayUseComputer(deps.resources, job.scopeId, job.sandboxId, botMayUse).then(
        () => false,
        (error: unknown) => {
          if (error instanceof SandboxAccessError) return true;
          throw error;
        },
      );
      verdicts.set(key, verdict);
      return verdict;
    };
    const stops = await Promise.all(jobs.map(async (job) => ((await barred(job)) ? [{ id: job.processId }] : [])));
    return stops.flat();
  });
}

export function createJobComputerSweep(deps: {
  resources: Pick<SandboxResources, "eachJobComputer" | "retireJobComputer">;
  sandbox: ProcessSandbox;
  processes: ProcessRegistry;
  finish: (handle: SandboxHandle, processId: string) => Promise<void>;
  onError: (error: unknown, scopeId: string) => void;
  now?: () => number;
}): () => Promise<void> {
  const attemptedAt = new Map<string, number>();
  const emptySince = new Map<string, number>();
  const clock = deps.now ?? Date.now;
  return async () => {
    const now = clock();
    await deps.resources.eachJobComputer(async (computer) => {
      try {
        const retire = async () => {
          await deps.resources.retireJobComputer(computer.id, computer.state);
          attemptedAt.delete(computer.id);
          emptySince.delete(computer.id);
        };
        const throttled = now - (attemptedAt.get(computer.id) ?? 0) < RETRY_EVERY_MS;
        if (computer.state === "provisioning") {
          if (now - Date.parse(computer.createdAt) < PROVISION_LIMIT_MS || throttled) return;
          attemptedAt.set(computer.id, now);
          await retire();
          return;
        }
        if (computer.state === "retired" || computer.error) {
          if (throttled) return;
          attemptedAt.set(computer.id, now);
          await retire();
          return;
        }
        const jobs = async () =>
          (await deps.processes.listByScope(computer.ownerScopeId)).filter((job) => job.sandboxId === computer.id);
        let current = await jobs();
        if (!current.length) {
          const since = emptySince.get(computer.id) ?? now;
          emptySince.set(computer.id, since);
          if (now - since < STARTUP_GRACE_MS) return;
        }
        if (current.some(live)) {
          emptySince.delete(computer.id);
          if (throttled) return;
          attemptedAt.set(computer.id, now);
          const handle = await deps.sandbox.provision(computer.ownerScopeId, {
            sandboxId: computer.id,
          });
          try {
            await reconcileProcesses(deps.sandbox, handle, deps.processes, computer.ownerScopeId, deps.finish);
          } finally {
            await deps.sandbox
              .teardown(handle, { keepWarm: true })
              .catch((error: unknown) => deps.onError(error, computer.ownerScopeId));
          }
          current = await jobs();
          if (current.some(live)) return;
        }
        attemptedAt.set(computer.id, now);
        await retire();
      } catch (error) {
        deps.onError(error, computer.ownerScopeId);
      }
    });
  };
}
