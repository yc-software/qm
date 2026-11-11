import { activityItems, type RunActivityEntry } from "./items.ts";

export type ClientToolResult = {
  content: string;
  isError?: boolean;
  images?: Array<{ data: string; mimeType: "image/png" | "image/jpeg" }>;
};

export type ClientToolRun = { status?: string; alive?: boolean; activity?: RunActivityEntry[] };

export function createClientToolExecutor(
  tool: string,
  run: (args: unknown, createdAt: number | undefined) => Promise<ClientToolResult | null>,
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
      const result = await run(item.body.args, item.createdAt ?? undefined);
      if (result) await send(callId, result);
    }
  };
}
