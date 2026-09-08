import { randomUUID } from "node:crypto";
import { ModelVerificationError, verificationFailure, type ModelVerifier } from "./model-verification.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { parseModelOverlay, type ModelOverlay } from "./model-overlay.ts";
import { modelUnavailableReason, setModelOverlays, validateModelOverlay } from "./pi-models.ts";

export interface StoredModelOverlay {
  spec: ModelOverlay;
  disabled: boolean;
  updatedAt: number;
  updatedBy: string;
  verification?: { fingerprint: string; verifiedAt: number; revision: string };
}

export function createModelOverlayStore(
  backing: DurableMap<StoredModelOverlay>,
  write: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
  verifier?: ModelVerifier,
) {
  async function verificationReason(row: StoredModelOverlay, id: string): Promise<string | undefined> {
    if (!row?.verification || !verifier)
      return "Model has not been verified; an administrator must verify and enable it.";
    try {
      const context = await verifier(parseModelOverlay({ ...row.spec, id }));
      if (context.fingerprint === row.verification.fingerprint) return undefined;
      return "Model settings or serving credentials changed; verify and enable this model again.";
    } catch {
      return "Model verification is no longer valid; check serving credentials and verify again.";
    }
  }
  return {
    async statuses() {
      return Promise.all(
        (await backing.entries()).map(async ([id, row]) => {
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
            unavailableReason:
              modelUnavailableReason(id) ?? (row?.disabled ? undefined : await verificationReason(row, id)),
            verifiedAt: row?.verification?.verifiedAt,
            verificationScope: "organization" as const,
          };
        }),
      );
    },
    async refresh() {
      const rows = await backing.entries();
      const failures = new Map<string, string>();
      for (const [id, row] of rows) {
        if (!row || row.disabled) continue;
        const reason = await verificationReason(row, id);
        if (reason) failures.set(id, reason);
      }
      setModelOverlays(
        rows.filter(([, row]) => row?.disabled !== true).map(([id, row]) => ({ ...row?.spec, id })),
        rows.filter(([, row]) => row?.disabled === true).map(([id]) => id),
        failures,
      );
    },
    async upsert(value: unknown, updatedBy: string) {
      const spec = validateModelOverlay(value);
      if (!updatedBy.trim()) throw new Error("updatedBy is required");
      if (!verifier)
        throw new ModelVerificationError(
          "verification_unavailable",
          "Provider verification is unavailable; the model was not enabled.",
        );
      const previous = await write(async () => {
        validateModelOverlay(spec);
        const existing = await backing.get(spec.id);
        if (existing?.spec?.provider && existing.spec.provider !== spec.provider)
          throw new Error("provider cannot change for an existing model id");
        return JSON.stringify(existing);
      });
      try {
        const context = await verifier(spec);
        const signal = AbortSignal.timeout(15_000);
        await new Promise<void>((resolve, reject) => {
          const onAbort = () =>
            reject(new ModelVerificationError("timeout", "Verification timed out; the model was not enabled."));
          signal.addEventListener("abort", onAbort, { once: true });
          context
            .probe(signal)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", onAbort));
        });
        return await write(async () => {
          try {
            validateModelOverlay(spec);
          } catch {
            throw new ModelVerificationError(
              "configuration_conflict",
              "The model ID or template changed during verification. Reload and try again.",
            );
          }
          if (JSON.stringify(await backing.get(spec.id)) !== previous)
            throw new ModelVerificationError(
              "changed_during_verification",
              "The model changed during verification. Reload and try again.",
            );
          if ((await verifier(spec)).fingerprint !== context.fingerprint)
            throw new ModelVerificationError(
              "changed_during_verification",
              "Serving credentials changed during verification. Verify again.",
            );
          const verification = { fingerprint: context.fingerprint, verifiedAt: Date.now(), revision: randomUUID() };
          await backing.put(spec.id, { spec, disabled: false, updatedAt: Date.now(), updatedBy, verification });
          return { verifiedAt: verification.verifiedAt, verificationScope: "organization" as const };
        });
      } catch (error) {
        const failure = verificationFailure(error);
        await write(async () => {
          const current = await backing.get(spec.id);
          let sameSpec: boolean;
          try {
            sameSpec = JSON.stringify(parseModelOverlay(current?.spec)) === JSON.stringify(spec);
          } catch {
            sameSpec = false;
          }
          if (current && !current.disabled && JSON.stringify(current) === previous && sameSpec) {
            const { verification: _verification, ...saved } = current;
            await backing.put(spec.id, saved);
          }
        });
        throw failure;
      }
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
