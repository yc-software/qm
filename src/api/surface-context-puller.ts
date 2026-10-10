import type { SurfaceContextQuery, SurfaceContextResult } from "../types.ts";
import type { SurfaceContextPuller } from "../core/orchestrator.ts";
import { swallow } from "../util/errors.ts";

const FULFILL_WAIT_MS = 25_000;
const FULFILL_RECHECK_MS = 2_000;

interface SurfaceContextApp {
  createContextRequest(source: string, query: SurfaceContextQuery): Promise<{ id: string }>;
  getContextRequest(id: string): Promise<{ status: string; result?: SurfaceContextResult; error?: string } | null>;
  deleteContextRequest(id: string): Promise<void>;
  onContextRequestSettled(listener: (id: string) => void, onResync: () => void): () => void;
}

export type ContextOutcome =
  { status: "done"; result: SurfaceContextResult } | { status: "failed"; error?: string } | { status: "timeout" };

export async function awaitContextOutcome(
  app: Pick<SurfaceContextApp, "getContextRequest" | "deleteContextRequest" | "onContextRequestSettled">,
  requestId: string,
  opts: { waitMs: number; recheckMs?: number; signal?: AbortSignal },
): Promise<ContextOutcome> {
  const deadline = Date.now() + opts.waitMs;
  const recheckMs = opts.recheckMs ?? FULFILL_RECHECK_MS;
  let woken: boolean;
  let wake: (() => void) | undefined;
  const nudge = () => {
    woken = true;
    wake?.();
  };
  const unsubscribe = app.onContextRequestSettled((id) => {
    if (id === requestId) nudge();
  }, nudge);
  try {
    for (;;) {
      if (opts.signal?.aborted) return { status: "timeout" };
      woken = false;
      const row = await app.getContextRequest(requestId);
      if (!row) return { status: "timeout" };
      if (row.status === "done") return { status: "done", result: row.result ?? { messages: [] } };
      if (row.status === "failed")
        return { status: "failed", ...(row.error !== undefined ? { error: row.error } : {}) };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: "timeout" };
      if (woken || opts.signal?.aborted) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(recheckMs, remaining));
        opts.signal?.addEventListener("abort", done, { once: true });
        wake = done;
        function done() {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", done);
          wake = undefined;
          resolve();
        }
      });
    }
  } finally {
    unsubscribe();
    await app.deleteContextRequest(requestId).catch((e) => swallow("surface-context: delete request", e));
  }
}

export function createSurfaceContextPuller(
  app: SurfaceContextApp,
  opts: {
    waitMs?: number;
    searchToken?: (source: string, viewer: string | undefined) => Promise<string | null>;
  } = {},
): SurfaceContextPuller {
  const waitMs = opts.waitMs ?? FULFILL_WAIT_MS;
  const parkAndWait = async (source: string, query: SurfaceContextQuery): Promise<SurfaceContextResult | null> => {
    const request = await app.createContextRequest(source, query);
    const outcome = await awaitContextOutcome(app, request.id, { waitMs });
    if (outcome.status === "done") return outcome.result;
    if (outcome.status === "failed" && outcome.error) return { messages: [], note: outcome.error };
    return null;
  };
  return {
    async pull(source, query): Promise<SurfaceContextResult | null> {
      return parkAndWait(source, query);
    },
    async searchLive(source, query): Promise<SurfaceContextResult | null> {
      const token = await opts.searchToken?.(source, query.viewer);
      return parkAndWait(source, token ? { ...query, viewerToken: token } : query);
    },
  };
}
