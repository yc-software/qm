import type { IncomingMessage, ServerResponse } from "node:http";

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

export interface SseFrame {
  event?: string;
  id?: string;
  data: string;
}

export function sseFrame(data: unknown, fields: { event?: string; id?: string } = {}): string {
  const id = fields.id === undefined ? "" : `id: ${fields.id}\n`;
  const event = fields.event === undefined ? "" : `event: ${fields.event}\n`;
  return `${id}${event}data: ${JSON.stringify(data)}\n\n`;
}

export function openSseStream(
  req: IncomingMessage,
  res: ServerResponse,
  heartbeatMs: number,
  start: () => () => void,
): void {
  res.writeHead(200, SSE_HEADERS);
  res.write(": open\n\n");
  const stop = start();
  const beat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
  beat.unref?.();
  req.on("close", () => {
    clearInterval(beat);
    stop();
  });
}

export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  const frames: SseFrame[] = [];
  for (const block of blocks) {
    const frame: SseFrame = { data: "" };
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
      else if (field === "event" || field === "id") frame[field] = value;
    }
    frame.data = data.join("\n");
    frames.push(frame);
  }
  return { frames, rest };
}
