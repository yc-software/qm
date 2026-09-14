import "./support/auto-fake-sprites.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import { mintPortalIdentity } from "../plugins/chassis/src/portal-identity.ts";
const secret = "local-test-send-timing-secret-identity-only";
const config = testConfig({ signingSecret: secret, openaiApiKey: "dummy", anthropicApiKey: "dummy" });
const built = buildApp(config);
const core = createServer(built.app, serverDeps(config, built));
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = secret;
const { handler } = await import("../plugins/web-ui/server/index.ts");
const web = httpServer(handler);
await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
const headers = {
  "content-type": "application/json",
  "x-portal-identity": mintPortalIdentity({ p: "timing-user", exp: Date.now() + 60000 }, secret),
};
after(async () => {
  web.closeAllConnections();
  core.closeAllConnections();
  await Promise.all([new Promise<void>((r) => web.close(() => r())), new Promise<void>((r) => core.close(() => r()))]);
  await built.runtime.stop();
});

test("one trace follows a successful send through validation, delayed enqueue and web acknowledgement", async () => {
  const lines: string[] = [];
  const original = console.info;
  const enqueue = built.runs.enqueue.bind(built.runs);
  built.runs.enqueue = async (input) => {
    await new Promise((r) => setTimeout(r, 30));
    return enqueue(input);
  };
  console.info = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  const traceId = "bf42d301-3af5-4fa1-889b-eac3780f982c";
  try {
    const res = await fetch(base + "/api/turn", {
      method: "POST",
      headers,
      body: JSON.stringify({
        traceId,
        threadRef: "web:timing-user:trace",
        text: "never-log-this-message",
        idempotencyKey: "never-log-this-key",
      }),
    });
    assert.equal(res.status, 202);
    const reply = (await res.json()) as { runId: string };
    assert.ok(await built.runs.get(reply.runId));
    const events = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    assert.ok(events.length >= 10);
    assert.ok(events.every((e) => e.traceId === traceId));
    for (const stage of [
      "models_ready",
      "identity_ready",
      "validation_complete",
      "approvals_checked",
      "enqueue_start",
      "enqueued",
      "response_sent",
    ])
      assert.ok(
        events.some((e) => e.stage === stage),
        stage,
      );
    assert.ok(
      events.find((e) => e.stage === "enqueued").elapsedMs -
        events.find((e) => e.stage === "enqueue_start").elapsedMs >=
        25,
    );
    const all = lines.join("\n");
    for (const sensitive of ["never-log-this-message", "never-log-this-key", "timing-user", secret])
      assert.ok(!all.includes(sensitive));
  } finally {
    console.info = original;
    built.runs.enqueue = enqueue;
  }
});

test("client reports are authenticated, bounded, and cannot masquerade as server events", async () => {
  const event = {
    traceId: "cf42d301-3af5-4fa1-889b-eac3780f982c",
    layer: "browser",
    stage: "queue_rendered",
    elapsedMs: 40,
    at: Date.now(),
    text: "strip-this",
  };
  const original = console.info;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    assert.equal(
      (await fetch(base + "/api/send-timing", { method: "POST", headers, body: JSON.stringify(event) })).status,
      204,
    );
    assert.ok(lines.some((l) => l.includes("queue_rendered")));
    assert.ok(!lines.join("").includes("strip-this"));
    assert.equal(
      (
        await fetch(base + "/api/send-timing", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...event, layer: "core" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/api/send-timing", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...event, text: "x".repeat(1000) }),
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await fetch(base + "/api/send-timing", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
        })
      ).status,
      401,
    );
  } finally {
    console.info = original;
  }
});
