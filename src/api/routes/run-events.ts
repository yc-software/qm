import { sendJson } from "../http.ts";
import type { SessionEntry } from "../../types.ts";
import type { ApiCtx, Route } from "./route.ts";

const HEARTBEAT_MS = 15_000;
const MAX_BUFFER_BYTES = 1_048_576;

function toolEvent(entry: SessionEntry): { id: string; data: Record<string, unknown> } | null {
  const payload = (entry.payload ?? {}) as Record<string, unknown>;
  const { tool, callId, ...rest } = payload;
  if (typeof callId !== "string" || !callId) return null;
  if (entry.type === "tool_call") {
    return {
      id: `tool:${callId}:start`,
      data: {
        type: "TOOL_CALL_START",
        toolCallId: callId,
        toolCallName: typeof tool === "string" ? tool : "tool",
        args: rest,
      },
    };
  }
  return {
    id: `tool:${callId}:result`,
    data: {
      type: "TOOL_CALL_RESULT",
      toolCallId: callId,
      content: String(payload.result ?? ""),
      isError: payload.isError === true,
    },
  };
}

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
  const sentToolEvents = new Set<string>();
  let toolCursor: number | undefined;
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
  const drained = (): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        res.off("drain", done);
        res.off("close", done);
        resolve();
      };
      res.on("drain", done);
      res.on("close", done);
    });
  const sync = (): void => {
    if (syncing || closed) return;
    syncing = true;
    queueMicrotask(() => {
      syncing = false;
      if (!closed) app.syncRunStream(runId, offset);
    });
  };
  const sendDrained = async (data: unknown, id?: string): Promise<void> => {
    if (res.writableNeedDrain) await drained();
    send(data, id);
  };
  const snapshot = async (run: NonNullable<typeof initial>): Promise<void> => {
    const toolEntries = await app.getRunToolEntries(runId, actor?.p, toolCursor);
    if (closed) return;
    offset = Math.max(offset, run.partial?.length ?? 0);
    for (const entry of toolEntries) {
      const event = toolEvent(entry);
      if (event && !sentToolEvents.has(event.id)) {
        await sendDrained(event.data, event.id);
        if (closed) return;
        sentToolEvents.add(event.id);
      }
      toolCursor = entry.seq;
    }
    await sendDrained({ type: "CUSTOM", name: "run", value: run });
    if (closed) return;
    if (run.status === "done" || run.status === "failed" || run.result !== null) {
      await sendDrained({ type: "RUN_FINISHED", threadId: runId, runId }, "done");
      if (closed) return;
      res.end();
      cleanup();
    }
  };
  const refresh = async (hydrated?: typeof initial): Promise<void> => {
    if (closed) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshAgain = false;
        const run = hydrated ?? (await app.getRun(runId, actor?.p));
        hydrated = undefined;
        if (closed) return;
        if (!run) {
          res.destroy();
          return;
        }
        await snapshot(run);
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
  await refresh(initial);
  if (!closed) await refresh();
}

export const runEventRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/runs/:id/events", auth: "source", handle: streamRun },
];
