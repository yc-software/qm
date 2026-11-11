import { activityItems, type RunActivityEntry } from "./items.ts";
import type { ClientToolResult } from "../../chassis/src/client-tools.ts";

export type { ClientToolResult };

export type ClientToolRun = { status?: string; alive?: boolean; activity?: RunActivityEntry[] };

const ANSWER_MARGIN_MS = 5_000;

export function createClientToolExecutor(
  tool: string,
  timeoutMs: number,
  run: (args: unknown, answerBy: number) => Promise<ClientToolResult>,
  send: (callId: string, result: ClientToolResult) => Promise<unknown>,
) {
  const handled = new Set<string>();
  return async (current: ClientToolRun): Promise<void> => {
    if (current.status !== "running" || !current.alive) return;
    const items = activityItems(current.activity ?? []);
    const complete = new Set(items.filter((item) => item.kind === "ToolResult").map((item) => item.callId));
    for (const item of items) {
      const callId = item.callId;
      if (
        item.kind !== "ToolCall" ||
        item.body.client !== true ||
        item.tool !== tool ||
        !callId ||
        complete.has(callId) ||
        handled.has(callId)
      )
        continue;
      handled.add(callId);
      const answerBy = item.createdAt + timeoutMs - ANSWER_MARGIN_MS;
      if (!item.createdAt || Date.now() >= answerBy) continue;
      await send(callId, await run(item.body.args, answerBy));
    }
  };
}

export function postClientResult(
  send: (path: string, init: RequestInit) => Promise<unknown>,
  runId: string,
  extra: Record<string, unknown> = {},
): (callId: string, result: ClientToolResult) => Promise<unknown> {
  return (callId, result) =>
    send(`/api/runs/${encodeURIComponent(runId)}/signal`, {
      method: "POST",
      body: JSON.stringify({ kind: "client_result", ...extra, callId, result }),
    });
}
