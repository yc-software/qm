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
  processes: Pick<ProcessRegistry, "claimLiveBotJobs" | "getMany">;
  resources: Pick<SandboxResources, "get" | "resolve">;
  swarms: Pick<SwarmService, "botMayUseComputer"> | undefined;
}): Promise<ClaimedRow[]> {
  return claimThenLoad(deps.processes.claimLiveBotJobs, async (ids, tenant) => {
    const reads = new Map<string, Promise<boolean>>();
    const once = (key: unknown[], read: () => Promise<boolean>): Promise<boolean> => {
      const id = JSON.stringify(key);
      const known = reads.get(id) ?? read();
      reads.set(id, known);
      return known;
    };
    const { swarms } = deps;
    const swarmRule: Pick<SwarmService, "botMayUseComputer"> | undefined = swarms && {
      botMayUseComputer: (computer, turn) =>
        once(["swarm", computer.swarmId, turn.actorId], () => swarms.botMayUseComputer(computer, turn)),
    };
    const barred = (job: ProcessRecord & { botActor: string }): Promise<boolean> =>
      once(["computer", job.scopeId, job.sandboxId, job.botActor], () =>
        assertBotMayUseComputer(
          deps.resources,
          job.scopeId,
          job.sandboxId,
          botMayUseComputers(swarmRule, { actorId: job.botActor, threadRef: "", sessionId: "" }),
        ).then(
          () => false,
          (error: unknown) => {
            if (error instanceof SandboxAccessError) return true;
            throw error;
          },
        ),
      );
    const jobs = (await deps.processes.getMany(tenant, ids)).filter(
      (job): job is ProcessRecord & { botActor: string } => Boolean(job.botActor),
    );
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
