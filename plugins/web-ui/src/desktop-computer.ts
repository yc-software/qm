import { fetchServerSentEvents } from "@tanstack/ai-client";
import { errMessage } from "../../chassis/src/errors.ts";
import type { RunActivityEntry } from "./items.ts";

type Result = {
  content: string;
  isError?: boolean;
  images?: Array<{ data: string; mimeType: "image/png" | "image/jpeg" }>;
};
type Desk = {
  call(args: unknown, clientId?: string, deadline?: number): Promise<Result>;
  stop?(clientId: string): Promise<unknown>;
};
export type DesktopRun = {
  desktopClientId?: string;
  status?: string;
  alive?: boolean;
  activity?: RunActivityEntry[];
};

function desktop(): Desk | undefined {
  return (globalThis as { window?: { qmDesktop?: { computer?: Desk; platform?: string } } }).window?.qmDesktop
    ?.platform === "darwin"
    ? (globalThis as { window?: { qmDesktop?: { computer?: Desk } } }).window?.qmDesktop?.computer
    : undefined;
}

export function desktopTurnId(): string | undefined {
  return desktop() ? crypto.randomUUID() : undefined;
}

async function executeComputer(desk: Desk, raw: unknown, deadline?: number): Promise<Result> {
  try {
    return await desk.call(raw, undefined, deadline);
  } catch (error) {
    return { content: errMessage(error), isError: true };
  }
}

export function createDesktopExecutor(
  clientId: string,
  desk: Desk,
  send: (callId: string, result: Result) => Promise<unknown>,
) {
  const handled = new Set<string>();
  return async (run: DesktopRun): Promise<void> => {
    if (run.desktopClientId !== clientId || run.status !== "running" || !run.alive) return;
    const items = (run.activity ?? []).flatMap((entry) => ("item" in entry ? [entry.item] : []));
    const complete = new Set(items.filter((item) => item.kind === "ToolResult").map((item) => item.callId));
    for (const item of items) {
      const callId = item.callId;
      if (
        item.kind !== "ToolCall" ||
        item.body.client !== true ||
        item.tool !== "desktop" ||
        !callId ||
        complete.has(callId) ||
        handled.has(callId)
      )
        continue;
      handled.add(callId);
      if (!item.createdAt || Date.now() - item.createdAt > 55_000) continue;
      const result = await executeComputer(desk, item.body.args, item.createdAt + 50_000);
      await send(callId, result);
    }
  };
}

export async function serveDesktopRun(
  runId: string,
  clientId: string,
  base: (path: string) => string,
  send: (path: string, init: RequestInit) => Promise<unknown>,
): Promise<void> {
  const desk = desktop();
  if (!desk) return;
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    void desk.stop?.(clientId);
  };
  window.addEventListener("pagehide", stop, { once: true });
  const scopedDesk: Desk = {
    call: (args, _client, deadline) => desk.call(args, clientId, deadline),
  };
  let failure: unknown;
  const execute = createDesktopExecutor(clientId, scopedDesk, (callId, result) =>
    send(`/api/runs/${encodeURIComponent(runId)}/signal`, {
      method: "POST",
      body: JSON.stringify({ kind: "client_result", desktopClientId: clientId, callId, result }),
    }),
  );
  try {
    let connected = false;
    let active = false;
    const transport = fetchServerSentEvents(base(`/api/runs/${encodeURIComponent(runId)}/events`), {
      credentials: "same-origin",
      fetchClient: async (input, init) => {
        if (connected) {
          stop();
          throw new Error("Desktop connection ended; submit a new turn to reconnect.");
        }
        connected = true;
        const response = await fetch(input, init);
        const reader = response.body?.getReader();
        if (!reader) {
          stop();
          throw new Error("Desktop connection has no stream");
        }
        const body = new ReadableStream<Uint8Array>({
          async pull(output) {
            try {
              const item = await reader.read();
              if (item.done) {
                stop();
                output.close();
              } else output.enqueue(item.value);
            } catch (error) {
              stop();
              output.error(error);
            }
          },
          cancel: () => reader.cancel(),
        });
        return new Response(body, { status: response.status, headers: response.headers });
      },
    });
    for await (const event of transport.joinRun(runId, controller.signal)) {
      if (event.type !== "CUSTOM" || event.name !== "run") continue;
      const run = event.value as DesktopRun;
      if (
        run.desktopClientId !== clientId ||
        run.status === "done" ||
        run.status === "failed" ||
        (active && (run.status !== "running" || !run.alive))
      )
        return;
      if (run.status === "running" && run.alive) active = true;
      void execute(run).catch((error) => {
        failure = error;
        stop();
      });
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    stop();
    window.removeEventListener("pagehide", stop);
  }
  if (failure) throw failure;
}
