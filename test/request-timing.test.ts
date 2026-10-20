import "./support/auto-fake-sprites.ts";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { once } from "node:events";
import * as Sentry from "@sentry/node";
import { flushErrorReporting, initializeErrorReporting } from "../plugins/chassis/src/error-reporting.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { withTraceCarrier } from "../src/runs/run-store.ts";

const captured: Record<string, any>[] = [];
const collector = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const lines = Buffer.concat(chunks).toString().split("\n");
  for (let i = 1; i + 1 < lines.length; i += 2) {
    if (JSON.parse(lines[i]!).type === "transaction") captured.push(JSON.parse(lines[i + 1]!));
  }
  res.end("{}");
});
collector.listen(0, "127.0.0.1");
await once(collector, "listening");
initializeErrorReporting(Sentry, "core", {
  SENTRY_DSN: `http://public@127.0.0.1:${(collector.address() as AddressInfo).port}/1`,
  SENTRY_TRACES_SAMPLE_RATE: "1",
});
after(async () => {
  collector.closeAllConnections();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
});

async function settle(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 60 && !predicate(); i++) {
    await flushErrorReporting();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("core requests are named by route template and carry no URL, query or header values", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "timing-")) }));
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    await fetch(`${base}/healthz`);
    await fetch(`${base}/v1/sessions/private-session-id?token=private-token`, {
      headers: { "x-qm-signature": "private-signature", cookie: "private-cookie" },
    });
    await fetch(`${base}/v1/no-such-route/private-segment-9f3a/deep`, { method: "POST" });
    const coreRequests = () =>
      captured.filter(
        (event) => event.contexts?.trace?.op === "http.server" && event.contexts.trace.data["http.route"] !== undefined,
      );
    await settle(() => coreRequests().length >= 2);
    const requests = coreRequests();
    assert.deepEqual(
      requests.map((event) => event.transaction),
      ["GET /v1/sessions/:id"],
      "health checks and 404s are not traced",
    );
    assert.doesNotMatch(JSON.stringify(requests), /private/);
    for (const event of requests) {
      assert.equal(event.tags?.service, "core");
      assert.equal(event.request, undefined);
      assert.match(event.contexts.trace.trace_id, /^[a-f0-9]{32}$/);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a run stores the request's trace context, and never a swarm's", async () => {
  const request = {
    actor: { id: "U1", type: "internal" as const },
    conversation: { kind: "dm" as const, threadRef: "dm:U1:carrier", audience: [] },
    origin: { kind: "human" as const },
    surface: "test",
    text: "hello",
    trace: { sentryTrace: "0123456789abcdef0123456789abcdef-0123456789abcdef-1" },
  };
  assert.equal(withTraceCarrier(request).trace, undefined, "a copied trace is dropped outside a request");
  await Sentry.startSpan({ name: "producer", op: "test" }, (span) => {
    assert.equal(withTraceCarrier(request).trace?.sentryTrace.split("-")[0], span.spanContext().traceId);
    assert.equal(withTraceCarrier({ ...request, swarm: { id: "s" } } as never).trace, undefined);
  });
});
