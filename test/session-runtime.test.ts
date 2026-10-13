import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const actor: Principal = { id: "U1", type: "internal" };
const threadRef = "web:U1:runtime";
function webTurn(text: string, runtime: Partial<OrchestratorInput> = {}): OrchestratorInput {
  return {
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef, audience: [actor] },
    text,
    origin: { kind: "human" },
    ...runtime,
  };
}

async function sessionWithTurns(...turns: Array<Partial<OrchestratorInput>>) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-session-runtime-")) }));
  const sid = (
    await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef },
      text: "hello",
    })
  ).sessionId!;
  for (const [i, runtime] of turns.entries())
    await built.runs.enqueue({ sessionId: threadRef, request: webTurn(`turn ${i}`, runtime) });
  return { ...built, sid };
}

test("a reopened session reports the whole runtime its latest turn was sent with", async () => {
  const { app, sid } = await sessionWithTurns(
    { harness: "pi", model: "claude-opus-5", thinkingLevel: "high" },
    { harness: "claude", model: "claude-fable-5", thinkingLevel: "low", fastMode: false },
  );
  const runtime = { harnessId: "claude", modelId: "claude-fable-5", effortLevel: "low", fastMode: false };
  assert.deepEqual((await app.getSessionForViewer(sid, "U1"))?.runtime, runtime);
  assert.deepEqual((await app.getSessionForViewer(sid, "U1", { tailTurns: 1 }))?.runtime, runtime);
});

test("automation, other surfaces and private messages do not change the runtime a reopened session shows", async () => {
  const { app, sid } = await sessionWithTurns(
    { harness: "pi", model: "claude-opus-5", thinkingLevel: "max" },
    { harness: "codex", model: "gpt-5.5", privateSessionMessage: true },
    { harness: "codex", model: "gpt-5.5", thinkingLevel: "high", origin: { kind: "automation" } },
    { harness: "claude", model: "claude-fable-5", surface: "slack" },
  );
  assert.deepEqual((await app.getSessionForViewer(sid, "U1"))?.runtime, {
    harnessId: "pi",
    modelId: "claude-opus-5",
    effortLevel: "max",
  });
});

test("a session whose turns never named a runtime reports none", async () => {
  const { app, sid } = await sessionWithTurns();
  assert.equal((await app.getSessionForViewer(sid, "U1"))?.runtime, undefined);
});

test("the web client's session read carries the runtime over HTTP", async () => {
  const secret = "s".repeat(32);
  const built = await sessionWithTurns({
    harness: "pi",
    model: "claude-sonnet-5",
    thinkingLevel: "medium",
    fastMode: true,
  });
  const server = createServer(built.app, { signingSecret: secret, sessions: built.sessions, config: built.config });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const path = `/v1/sessions/${built.sid}?viewer=U1&tailTurns=2`;
    const res = await fetch(`http://localhost:${(server.address() as AddressInfo).port}${path}`, {
      headers: signedRequestHeaders(secret, "GET", path, ""),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { runtime?: unknown }).runtime, {
      harnessId: "pi",
      modelId: "claude-sonnet-5",
      effortLevel: "medium",
      fastMode: true,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
