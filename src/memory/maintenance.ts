import type { ScopeId } from "../types.ts";
import type { MemoryService } from "./memory-service.ts";

export type MemoryMaintenanceResult = "committed" | "idle" | "conflict" | "unsupported";

export async function runMemoryMaintenance(opts: {
  memory: MemoryService;
  scopeId: ScopeId;
  author: string;
  attempts?: number;
  prepare: (content: string, attempt: number) => Promise<string | undefined>;
}): Promise<MemoryMaintenanceResult> {
  if (!opts.memory.readHead || !opts.memory.replaceIfRevision) return "unsupported";
  const attempts = Math.max(1, opts.attempts ?? 2);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const head = await opts.memory.readHead(opts.scopeId);
    if (!head.revision) return "unsupported";
    const next = await opts.prepare(head.content, attempt);
    if (next === undefined) return "idle";
    if (await opts.memory.replaceIfRevision(opts.scopeId, next, head.revision, opts.author)) return "committed";
  }
  return "conflict";
}
