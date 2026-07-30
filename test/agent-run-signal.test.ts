import "./support/auto-fake-sprites.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal } from "../src/types.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "agent-run-signal-secret".repeat(2);

const built = buildApp(
  testConfig({ dataDir: mkdtempSync(join(tmpdir(), "agent-run-signal-")), signingSecret: SECRET }),
);
const core = createServer(built.app, { signingSecret: SECRET });
core.listen(0);
const base = `http://localhost:${(core.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => core.close(() => r()));
  await built.runtime.stop();
});

const owner: Principal = { id: "internal:U1", type: "internal" };
function request(text: string, threadRef: string): OrchestratorInput {
  return { actor: owner, conversation: { kind: "dm", threadRef, audience: [owner] }, origin: { kind: "direct" }, text };
}

const capFor = (actorId: string) =>
  mintCapabilityToken(
    { actorId, scopeId: scopeId("personal", actorId), aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS },
    SECRET,
  );

async function signal(
  runId: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}/v1/run-signals/${encodeURIComponent(runId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-agent-capability": token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

test("agent route: the owner's capability token can abort and steer their own pending run", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "a-accept", request: request("hi", "t-agent-accept") });
  const token = await capFor(owner.id);
  for (const body of [{ kind: "steer", text: "go left" }, { kind: "abort" }]) {
    const r = await signal(run.id, body, token);
    assert.equal(r.status, 200);
    assert.equal(r.json.accepted, true);
  }
});

test("agent route: another principal's token is told the run does not exist", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "a-scope", request: request("hi", "t-agent-scope") });
  const r = await signal(run.id, { kind: "abort" }, await capFor("internal:U2"));
  assert.equal(r.status, 404);
});

test("agent route: no token at all is refused", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "a-noauth", request: request("hi", "t-agent-noauth") });
  const r = await signal(run.id, { kind: "abort" });
  assert.equal(r.status, 401);
});

test("agent route: bad kind 400, steer without text 400, unknown run 404", async () => {
  const { run } = await built.runs.enqueue({ sessionId: "a-bad", request: request("hi", "t-agent-bad") });
  const token = await capFor(owner.id);
  assert.equal((await signal(run.id, { kind: "explode" }, token)).status, 400);
  assert.equal((await signal(run.id, { kind: "steer" }, token)).status, 400);
  assert.equal((await signal("no-such-run", { kind: "abort" }, token)).status, 404);
});

test("agent route: active-run discovery is viewer-bound", async () => {
  const threadRef = "t-agent-discover";
  const { run } = await built.runs.enqueue({ sessionId: threadRef, request: request("hi", threadRef) });
  const mine = await fetch(`${base}/v1/run-signals/active?threadRef=${encodeURIComponent(threadRef)}`, {
    headers: { "x-agent-capability": await capFor(owner.id) },
  });
  assert.equal(mine.status, 200);
  assert.equal(((await mine.json()) as { runId?: string | null }).runId, run.id);

  const theirs = await fetch(`${base}/v1/run-signals/active?threadRef=${encodeURIComponent(threadRef)}`, {
    headers: { "x-agent-capability": await capFor("internal:U2") },
  });
  assert.equal(theirs.status, 200);
  assert.equal(((await theirs.json()) as { runId?: string | null }).runId, null);
});
