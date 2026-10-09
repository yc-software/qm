import type { ProcessSandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import type { ProcessRegistry } from "./process-registry.ts";

export async function reconcileProcesses(
  sandbox: ProcessSandbox,
  handle: SandboxHandle,
  registry: ProcessRegistry,
  scopeId: string,
  onExit?: (handle: SandboxHandle, processId: string) => Promise<void>,
): Promise<void> {
  const records = (await registry.listByScope(scopeId)).filter(
    (r) => !r.sandboxId || r.sandboxId === handle.resourceId,
  );
  const running = records.filter((r) => r.status === "running");
  const finished = records.filter((r) => r.status !== "running" && r.credentialsPending).map((r) => r.processId);
  if (running.length) {
    const byId = new Map((await sandbox.listProcesses(handle)).map((s) => [s.processId, s]));
    for (const rec of running) {
      const backend = byId.get(rec.processId);
      if (!backend || backend.status.state === "exited") {
        await registry.markStatus(rec.processId, "exited");
        finished.push(rec.processId);
      }
    }
  }
  if (!onExit) return;
  const failures: unknown[] = [];
  for (const processId of finished) await onExit(handle, processId).catch((error) => failures.push(error));
  if (failures.length) throw new AggregateError(failures, "Could not finish exited background jobs");
}
