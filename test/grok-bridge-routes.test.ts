import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { orgScope } from "../src/config.ts";
import type { JobEnvelope } from "../src/grok-bridge/types.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

async function startBridge() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "grok-bridge-")) }));
  const server = createInsecureTestServer(built.app, {
    grokBridge: built.grokBridge,
    featureFlags: built.featureFlags,
    publicUrl: "http://127.0.0.1",
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    built,
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

async function startGrokStub(): Promise<{
  url: string;
  posted: () => JobEnvelope | undefined;
  close: () => Promise<void>;
}> {
  let posted: JobEnvelope | undefined;
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      posted = JSON.parse(Buffer.concat(chunks).toString()) as JobEnvelope;
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
    posted: () => posted,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("grok-bridge routes 404 while the flag is off", async () => {
  const srv = await startBridge();
  try {
    const res = await fetch(`${srv.base}/v1/grok-bridge/pairings`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        agentName: "sara",
        ownerPrincipalId: "divyansh",
        actorId: "maya",
        originScopeId: "group:pipeline-review",
      }),
    });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test("pair, dispatch, and ingest labeled events from a Grok webhook stub", async () => {
  const grok = await startGrokStub();
  const srv = await startBridge();
  try {
    await srv.built.featureFlags.setEnabled("grok_bridge", orgScope(), true, "test");
    const session = await srv.built.sessions.getOrCreateByThread(
      "pipeline-review",
      "group",
      "group:pipeline-review",
      "pipeline-review",
    );
    await srv.built.sessions.addParticipant(session.id, "maya");
    await srv.built.sessions.addParticipant(session.id, "divyansh");

    const created = await fetch(`${srv.base}/v1/grok-bridge/pairings`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        agentName: "sara",
        ownerPrincipalId: "divyansh",
        actorId: "maya",
        originScopeId: "group:pipeline-review",
      }),
    });
    assert.equal(created.status, 200);
    const createdBody = (await created.json()) as { pairing: { id: string; status: string }; skill: string };
    assert.equal(createdBody.pairing.status, "pending_consent");
    assert.match(createdBody.skill, /qm-grok-bridge\/v1/);

    const decided = await fetch(`${srv.base}/v1/grok-bridge/pairings/${createdBody.pairing.id}/decide`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ actorId: "divyansh", decision: "accept" }),
    });
    assert.equal(decided.status, 200);

    const inbound = await fetch(`${srv.base}/v1/grok-bridge/pairings/${createdBody.pairing.id}/inbound`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        actorId: "divyansh",
        webhookUrl: grok.url,
        webhookKey: "hook-secret",
        grokBotId: "bot-sara",
      }),
    });
    assert.equal(inbound.status, 200);
    assert.equal(((await inbound.json()) as { pairing: { status: string } }).pairing.status, "paired");

    const dispatched = await fetch(`${srv.base}/v1/grok-bridge/jobs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        agentName: "sara",
        ownerPrincipalId: "divyansh",
        originSessionId: session.id,
        actorId: "maya",
        instruction: "Pull the Attio pipeline list",
      }),
    });
    assert.equal(dispatched.status, 200);
    const job = ((await dispatched.json()) as { job: { id: string; status: string } }).job;
    assert.equal(job.status, "dispatched");
    const envelope = grok.posted();
    assert.equal(envelope?.protocol, "qm-grok-bridge/v1");
    assert.equal(envelope?.qm_agent, "sara");
    assert.ok(envelope?.callback_token);
    assert.match(envelope?.callback_url ?? "", new RegExp(`/v1/grok-bridge/jobs/${job.id}/events$`));

    const eventsUrl = `${srv.base}/v1/grok-bridge/jobs/${job.id}/events`;
    const accepted = await fetch(eventsUrl, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${envelope!.callback_token}` },
      body: JSON.stringify({
        protocol: "qm-grok-bridge/v1",
        job_id: job.id,
        seq: 1,
        status: "accepted",
        summary: "picked up",
        artifacts: [],
      }),
    });
    assert.equal(accepted.status, 202);

    const succeeded = await fetch(eventsUrl, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${envelope!.callback_token}` },
      body: JSON.stringify({
        protocol: "qm-grok-bridge/v1",
        job_id: job.id,
        seq: 2,
        status: "succeeded",
        summary: "12 open deals",
        artifacts: [],
      }),
    });
    assert.equal(succeeded.status, 202);

    const viewed = await fetch(`${srv.base}/v1/grok-bridge/jobs/${job.id}?viewer=maya`);
    assert.equal(viewed.status, 200);
    const viewedJob = ((await viewed.json()) as { job: { status: string; summary: string } }).job;
    assert.equal(viewedJob.status, "succeeded");
    assert.equal(viewedJob.summary, "12 open deals");

    const entries = await srv.built.sessions.getEntries(session.id);
    const projected = entries.find((entry) => {
      const payload = entry.payload as { text?: string } | null;
      return typeof payload?.text === "string" && payload.text.includes("via divyansh's Grok Bot");
    });
    assert.ok(projected);
  } finally {
    await grok.close();
    await srv.close();
  }
});
