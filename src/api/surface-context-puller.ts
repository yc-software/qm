import type { SurfaceContextQuery, SurfaceContextResult } from "../types.ts";
import type { SurfaceContextPuller } from "../core/orchestrator.ts";
import { sleep } from "../util/async.ts";
import { swallow } from "../util/errors.ts";

const FULFILL_WAIT_MS = 25_000;
const FULFILL_POLL_MS = 100;

interface SurfaceContextApp {
  createContextRequest(source: string, query: SurfaceContextQuery): Promise<{ id: string }>;
  getContextRequest(id: string): Promise<{ status: string; result?: SurfaceContextResult; error?: string } | null>;
  deleteContextRequest(id: string): Promise<void>;
}

export type ContextOutcome =
  { status: "done"; result: SurfaceContextResult } | { status: "failed"; error?: string } | { status: "timeout" };

export async function awaitContextOutcome(
  app: Pick<SurfaceContextApp, "getContextRequest" | "deleteContextRequest">,
  requestId: string,
  opts: { waitMs: number; pollMs: number },
): Promise<ContextOutcome> {
  const deadline = Date.now() + opts.waitMs;
  try {
    while (Date.now() < deadline) {
      await sleep(opts.pollMs);
      const row = await app.getContextRequest(requestId);
      if (!row) return { status: "timeout" };
      if (row.status === "done") return { status: "done", result: row.result ?? { messages: [] } };
      if (row.status === "failed")
        return { status: "failed", ...(row.error !== undefined ? { error: row.error } : {}) };
    }
    return { status: "timeout" };
  } finally {
    await app.deleteContextRequest(requestId).catch((e) => swallow("surface-context: delete request", e));
  }
}

export function createSurfaceContextPuller(
  app: SurfaceContextApp,
  opts: {
    waitMs?: number;
    pollMs?: number;
    searchToken?: (source: string, viewer: string | undefined) => Promise<string | null>;
  } = {},
): SurfaceContextPuller {
  const waitMs = opts.waitMs ?? FULFILL_WAIT_MS;
  const pollMs = opts.pollMs ?? FULFILL_POLL_MS;
  const parkAndWait = async (source: string, query: SurfaceContextQuery): Promise<SurfaceContextResult | null> => {
    const request = await app.createContextRequest(source, query);
    const outcome = await awaitContextOutcome(app, request.id, { waitMs, pollMs });
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
