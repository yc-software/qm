import type { ProcessSandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import type { SandboxResources } from "../sandbox/sandbox-resources.ts";
import type { ProcessRecord, ProcessRegistry } from "./process-registry.ts";
import { reconcileProcesses } from "./reconcile.ts";

const STARTUP_GRACE_MS = 2 * 60_000;
const PROVISION_LIMIT_MS = 15 * 60_000;
const RETRY_EVERY_MS = 5 * 60_000;

const live = (job: ProcessRecord): boolean => job.status === "running" || Boolean(job.credentialsPending);

export function createJobComputerSweep(deps: {
  resources: Pick<SandboxResources, "jobComputers" | "retireJobComputer">;
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
    for (const computer of await deps.resources.jobComputers()) {
      try {
        const retire = async () => {
          await deps.resources.retireJobComputer(computer.id, computer.state);
          attemptedAt.delete(computer.id);
          emptySince.delete(computer.id);
        };
        const throttled = now - (attemptedAt.get(computer.id) ?? 0) < RETRY_EVERY_MS;
        if (computer.state === "provisioning") {
          if (now - Date.parse(computer.createdAt) < PROVISION_LIMIT_MS || throttled) continue;
          attemptedAt.set(computer.id, now);
          await retire();
          continue;
        }
        if (computer.state === "retired" || computer.error) {
          if (throttled) continue;
          attemptedAt.set(computer.id, now);
          await retire();
          continue;
        }
        const jobs = async () =>
          (await deps.processes.listByScope(computer.ownerScopeId)).filter((job) => job.sandboxId === computer.id);
        let current = await jobs();
        if (!current.length) {
          const since = emptySince.get(computer.id) ?? now;
          emptySince.set(computer.id, since);
          if (now - since < STARTUP_GRACE_MS) continue;
        }
        if (current.some(live)) {
          emptySince.delete(computer.id);
          if (throttled) continue;
          attemptedAt.set(computer.id, now);
          const handle = await deps.sandbox.provision([{ scopeId: computer.ownerScopeId, mode: "rw", mountPath: "" }], {
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
          if (current.some(live)) continue;
        }
        attemptedAt.set(computer.id, now);
        await retire();
      } catch (error) {
        deps.onError(error, computer.ownerScopeId);
      }
    }
  };
}
