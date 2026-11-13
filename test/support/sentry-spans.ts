import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { flushErrorReporting } from "../../plugins/chassis/src/error-reporting.ts";

export interface SentSpan {
  name: string;
  op: string | undefined;
  span_id: string;
  parent_span_id?: string;
  trace_id: string;
  start_timestamp: number;
  end_timestamp: number;
  status: string;
  is_segment: boolean;
  attributes: Record<string, any>;
}

export interface SentSegment extends SentSpan {
  spans: SentSpan[];
}

export function readEnvelope(body: Buffer, gzip = false) {
  const lines = (gzip ? gunzipSync(body) : body).toString().split("\n");
  const header: Record<string, any> | undefined = lines[0] ? JSON.parse(lines[0]) : undefined;
  const events: Record<string, any>[] = [];
  const spans: SentSpan[] = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    const type = JSON.parse(lines[i]!).type;
    const payload = JSON.parse(lines[i + 1]!);
    if (type === "event") events.push(payload);
    if (type !== "span") continue;
    for (const item of payload.items) {
      const attributes = Object.fromEntries(
        Object.entries<{ value: unknown }>(item.attributes).map(([key, { value }]) => [key, value]),
      );
      spans.push({ ...item, op: attributes["sentry.op"], attributes });
    }
  }
  return { header, events, spans };
}

export function segments(spans: SentSpan[]): SentSegment[] {
  return spans
    .filter((span) => span.is_segment)
    .map((root) => ({
      ...root,
      spans: spans.filter((span) => !span.is_segment && span.attributes["sentry.segment.id"] === root.span_id),
    }));
}

export async function collectSpans() {
  const spans: SentSpan[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    spans.push(...readEnvelope(Buffer.concat(chunks), req.headers["content-encoding"] === "gzip").spans);
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    dsn: `http://public@127.0.0.1:${(server.address() as AddressInfo).port}/1`,
    spans,
    async segment(matches: (segment: SentSegment) => boolean): Promise<SentSegment> {
      for (let i = 0; i < 60 && !segments(spans).some(matches); i++) {
        await flushErrorReporting();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await flushErrorReporting();
      const found = segments(spans).find(matches);
      assert.ok(found, "the segment arrived");
      return found;
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
