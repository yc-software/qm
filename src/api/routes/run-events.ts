import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

const HEARTBEAT_MS = 15_000;
const MAX_BUFFER_BYTES = 1_048_576;

async function streamRun(ctx: ApiCtx): Promise<void> {
  const { app, req, res, actor } = ctx;
  const runId = ctx.params.id!;
  const initial = await app.getRun(runId, actor?.p);
  if (!initial) return sendJson(res, 404, { error: "not_found" });
  if (res.destroyed) return;
  let closed = false;
  let offset = 0;
  let syncing = false;
  let refreshing = false;
  let refreshAgain = false;
  const cleanup = (): void => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  const send = (data: unknown, id?: string): void => {
    if (closed) return;
    if (res.writableLength > MAX_BUFFER_BYTES) {
      res.destroy();
      return;
    }
    res.write(`${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`);
  };
  const sync = (): void => {
    if (syncing || closed) return;
    syncing = true;
    queueMicrotask(() => {
      syncing = false;
      if (!closed) app.syncRunStream(runId, offset);
    });
  };
  const snapshot = (run: NonNullable<typeof initial>): void => {
    offset = Math.max(offset, run.partial?.length ?? 0);
    send({ type: "CUSTOM", name: "run", value: run });
    if (run.status === "done" || run.status === "failed" || run.result !== null) {
      send({ type: "RUN_FINISHED", threadId: runId, runId }, "done");
      res.end();
      cleanup();
    }
  };
  const refresh = async (): Promise<void> => {
    if (closed) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshAgain = false;
        const run = await app.getRun(runId, actor?.p);
        if (closed) return;
        if (!run) {
          res.destroy();
          return;
        }
        snapshot(run);
      } while (refreshAgain && !closed);
    } catch {
      res.destroy();
    } finally {
      refreshing = false;
      sync();
    }
  };
  const unsubscribe = app.subscribeRun(
    runId,
    (event) => {
      if (closed) return;
      if (event.kind === "refresh") {
        void refresh();
        return;
      }
      if (event.kind !== "delta" || refreshing) return;
      if (event.offset > offset) {
        sync();
        return;
      }
      const delta = event.text.slice(offset - event.offset);
      if (!delta) return;
      send({ type: "CUSTOM", name: "delta", value: { offset, delta } }, `text:${offset + delta.length}`);
      offset += delta.length;
    },
    () => {
      sync();
      void refresh();
    },
  );
  const heartbeat = setInterval(() => {
    sync();
    void refresh();
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  res.on("close", cleanup);
  req.on("error", () => res.destroy());
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  send({ type: "RUN_STARTED", threadId: runId, runId });
  snapshot(initial);
  // Subscribe before the second snapshot so hydration cannot miss a publication.
  if (!closed) {
    sync();
    await refresh();
  }
}

export const runEventRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/runs/:id/events", auth: "source", handle: streamRun },
];
