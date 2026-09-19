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

test("core request timings carry registered route templates, never raw paths, and runs report queue wait", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "timing-")) }));
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    await fetch(`${base}/healthz`);
    await fetch(`${base}/v1/sessions/private-session-id?token=private-token`);
    await fetch(`${base}/v1/no-such-route/private-segment-9f3a/deep`, { method: "POST" });
    await fetch(`${base}/v1/blobs/private-blob-id`);
    const settle = async (expected: number) => {
      for (let i = 0; i < 40 && captured.length < expected; i++) {
        await flushErrorReporting();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    await settle(3);
    const requests = captured.filter((event) => event.contexts?.trace?.op === "http.server");
    assert.equal(requests.length, 3);
    assert.doesNotMatch(JSON.stringify(requests), /private/);
    assert.deepEqual(
      requests.map((event) => [event.transaction, event.contexts?.trace?.status, event.tags?.http_status]),
      [
        ["GET /v1/sessions/:id", "invalid_argument", "400"],
        ["POST /*", "not_found", "404"],
        ["GET /v1/blobs/:id", "internal_error", "501"],
      ],
    );
    for (const event of requests) {
      assert.equal(event.type, "transaction");
      assert.equal(event.tags?.service, "core");
      assert.ok(event.timestamp! >= event.start_timestamp!);
      assert.match(event.contexts!.trace!.trace_id!, /^[a-f0-9]{32}$/);
      assert.equal(event.server_name, undefined);
      assert.equal(event.contexts.otel, undefined);
      assert.equal(event.contexts.trace.data, undefined);
      assert.deepEqual(event.spans, []);
    }
    const { run } = await built.runs.enqueue({
      sessionId: "private-thread",
      request: {
        actor: { id: "private-person", type: "internal" },
        conversation: { kind: "dm", threadRef: "private-thread", audience: [] },
        origin: { kind: "human" },
        surface: "web",
        text: "private prompt",
      },
    });
    const claimed = await built.runs.claim("worker", 10_000);
    assert.equal(claimed?.id, run.id);
    await built.runs.complete(run.id, claimed!.leaseToken!, { status: "ok" });
    await settle(4);
    const runs = captured.filter((event) => event.contexts?.trace?.op === "queue.task");
    assert.equal(runs.length, 1);
    assert.doesNotMatch(JSON.stringify(runs), /private/);
    assert.equal(runs[0]!.transaction, "run");
    assert.deepEqual(runs[0]!.tags, { service: "core", surface: "web", origin: "human" });
    assert.equal(runs[0]!.contexts?.trace?.status, "ok");
    assert.equal(runs[0]!.measurements?.queue_wait?.unit, "millisecond");
    assert.ok(runs[0]!.measurements!.queue_wait!.value >= 0);
    const stopped = await built.runs.enqueue({ sessionId: "private-thread-2", request: run.request });
    const stoppedClaim = await built.runs.claim("worker", 10_000);
    assert.equal(stoppedClaim?.id, stopped.run.id);
    await built.runs.complete(stopped.run.id, stoppedClaim!.leaseToken!, { status: "silent", stopped: true });
    await settle(5);
    const cancelled = captured.filter((event) => event.contexts?.trace?.op === "queue.task").at(-1)!;
    assert.equal(cancelled.contexts.trace.status, "cancelled");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
