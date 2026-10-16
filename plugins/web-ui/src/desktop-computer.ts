import { fetchServerSentEvents } from "@tanstack/ai-client";
import { errMessage } from "../../chassis/src/errors.ts";

type Result = {
  content: string;
  isError?: boolean;
  images?: Array<{ data: string; mimeType: "image/png" | "image/jpeg" }>;
};
type Desk = {
  call(args: unknown, clientId?: string, deadline?: number): Promise<Result>;
  stop?(clientId: string): Promise<unknown>;
};
type Activity = {
  type: string;
  payload?: { client?: boolean; tool?: string; callId?: string; args?: unknown };
  createdAt?: number;
};
export type DesktopRun = { desktopClientId?: string; status?: string; alive?: boolean; activity?: Activity[] };

function desktop(): Desk | undefined {
  return (globalThis as { window?: { qmDesktop?: { computer?: Desk; platform?: string } } }).window?.qmDesktop
    ?.platform === "darwin"
    ? (globalThis as { window?: { qmDesktop?: { computer?: Desk } } }).window?.qmDesktop?.computer
    : undefined;
}

export function desktopTurnId(): string | undefined {
  return desktop() ? crypto.randomUUID() : undefined;
}

export async function executeComputer(desk: Desk, raw: unknown, deadline?: number): Promise<Result> {
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
    const complete = new Set(
      run.activity?.filter((entry) => entry.type === "tool_result").map((entry) => entry.payload?.callId),
    );
    for (const entry of run.activity ?? []) {
      const payload = entry.payload;
      if (
        entry.type !== "tool_call" ||
        !payload?.client ||
        payload.tool !== "desktop" ||
        !payload.callId ||
        complete.has(payload.callId) ||
        handled.has(payload.callId)
      )
        continue;
      handled.add(payload.callId);
      if (!entry.createdAt || Date.now() - entry.createdAt > 55_000) continue;
      const result = await executeComputer(desk, payload.args, entry.createdAt + 50_000);
      await send(payload.callId, result);
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
