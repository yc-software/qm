import type { StoresModule } from "./stores.ts";
import { hasRows } from "../jobs/job-worker.ts";
import type { HarnessModule } from "./harness.ts";
import type { FilesModule } from "./files.ts";
import type { Head } from "./late.ts";
import type { MemoryService } from "../memory/memory-service.ts";
import { createPostgresMemoryService } from "../memory/postgres-memory-service.ts";
import { createSemanticMemory } from "../memory/semantic-memory.ts";
import { withMemoryTidy } from "../memory/tidy.ts";
import { classifiedMemory } from "../memory/classification.ts";
import { createPerTurnStrategy } from "../memory/strategies/per-turn.ts";
import { errMessage } from "../util/errors.ts";

type MemoryInputs = Pick<Head, "late" | "config"> & {
  stores: StoresModule;
  harness: HarnessModule;
  files: FilesModule;
};

export function buildMemory(deps: MemoryInputs) {
  const { databaseUrl, configStore, every } = deps.stores;
  const { resolveMemoryEmbedder, harness } = deps.harness;
  const { late, config } = deps;
  const { errors } = deps.files;

  const notebookMemory: MemoryService = createPostgresMemoryService(databaseUrl);
  const semanticMemory = createSemanticMemory({
    notebook: notebookMemory,
    databaseUrl,
    embeddingModel: () => configStore.getEmbeddingModelDurable(),
    resolveEmbedder: (id) => resolveMemoryEmbedder(id),
  });
  const baseMemory: MemoryService = withMemoryTidy(semanticMemory.memory, (scope) => late.memoryTidy.ensure(scope));
  const memory = classifiedMemory(baseMemory, harness.models);
  const memoryStrategy = createPerTurnStrategy({
    harness: harness.models,
    memory,
    captureQuietMs: config.memoryCaptureQuietMs,
    databaseUrl,
    onCaptureError: (e, scope) =>
      errors.record({ category: "memory", code: "capture_failed", message: errMessage(e), scopeLabel: scope }, e),
  });
  every("memory-vector-index", 30_000, () => semanticMemory.index(), {
    immediate: true,
    due: `${hasRows(
      "memory_facts",
      `w.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM memory_fact_vectors v WHERE v.tenant_id = w.tenant_id
         AND v.scope_id = w.scope_id AND v.fact_id = w.id AND v.fact_hash = w.text_hash)`,
    )} OR ${hasRows(
      "memory_fact_vectors",
      `w.model <> (SELECT b.embedding_model_id FROM base_model_configs b
         WHERE b.tenant_id = w.tenant_id AND b.embedding_model_id IS NOT NULL LIMIT 1)
       OR NOT EXISTS (SELECT 1 FROM memory_facts f WHERE f.tenant_id = w.tenant_id AND f.scope_id = w.scope_id
         AND f.id = w.fact_id AND f.deleted_at IS NULL)`,
    )}`,
  });
  every("memory:capture-sweep", 60_000, () => memoryStrategy.sweep(), { due: hasRows("memory_capture_pending") });
  return { memory, memoryStrategy, baseMemory, semanticMemory };
}

export type MemoryModule = ReturnType<typeof buildMemory>;
