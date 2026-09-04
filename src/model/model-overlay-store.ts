import type { DurableMap } from "../persistence/durable-map.ts";
import { parseModelOverlay, type ModelOverlay } from "./model-overlay.ts";
import { modelUnavailableReason, setModelOverlays, validateModelOverlay } from "./pi-models.ts";

export interface StoredModelOverlay {
  spec: ModelOverlay;
  disabled: boolean;
  updatedAt: number;
  updatedBy: string;
}

export function createModelOverlayStore(
  backing: DurableMap<StoredModelOverlay>,
  write: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
) {
  return {
    async statuses() {
      return (await backing.entries()).map(([id, row]) => {
        let spec: Partial<ModelOverlay> & { id: string };
        try {
          spec = parseModelOverlay({ ...row?.spec, id });
        } catch {
          spec = { id, name: id };
        }
        return {
          spec,
          disabled: row?.disabled === true,
          updatedAt: row?.updatedAt,
          updatedBy: row?.updatedBy,
          unavailableReason: modelUnavailableReason(id),
        };
      });
    },
    async refresh() {
      const rows = await backing.entries();
      setModelOverlays(
        rows.filter(([, row]) => row?.disabled !== true).map(([id, row]) => ({ ...row?.spec, id })),
        rows.filter(([, row]) => row?.disabled === true).map(([id]) => id),
      );
    },
    async upsert(value: unknown, updatedBy: string) {
      return write(async () => {
        const spec = validateModelOverlay(value);
        if (!updatedBy.trim()) throw new Error("updatedBy is required");
        const existing = await backing.get(spec.id);
        if (existing?.spec?.provider && existing.spec.provider !== spec.provider)
          throw new Error("provider cannot change for an existing model id");
        await backing.put(spec.id, { spec, disabled: false, updatedAt: Date.now(), updatedBy });
      });
    },
    async delete(id: string, updatedBy: string) {
      return write(async () => {
        if (!updatedBy.trim()) throw new Error("updatedBy is required");
        const existing = await backing.get(id);
        if (!existing || existing.disabled) return false;
        await backing.put(id, { ...existing, disabled: true, updatedAt: Date.now(), updatedBy });
        return true;
      });
    },
  };
}

export type ModelOverlayStore = ReturnType<typeof createModelOverlayStore>;
