import "../support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/wiring.ts";
import type { Config } from "../../src/config.ts";
import type { TurnRequest } from "../../src/types.ts";
import { testConfig } from "../support/test-config.ts";

const NO_KEY = !process.env.ANTHROPIC_API_KEY;
const opts = { skip: NO_KEY ? "set ANTHROPIC_API_KEY to run live e2e" : false, timeout: 120_000 };

function freshApp() {
  const config: Config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "pi-e2e-")),
    harness: "pi",
    ...(process.env.PI_MODEL ? { modelId: process.env.PI_MODEL } : {}),
    ...(process.env.ANTHROPIC_API_KEY ? { anthropicApiKey: process.env.ANTHROPIC_API_KEY } : {}),
  });
  return buildApp(config);
}

const actor = { externalId: "U1" };
function dm(text: string, thread = "t1"): TurnRequest {
  return { surface: "e2e", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

test("the agent loop generates and delivers an output", opts, async () => {
  const { app } = freshApp();
  const r = await app.turn(dm("Reply with exactly the single word: PONG"));
  assert.equal(r.status, "ok");
  assert.match(r.reply ?? "", /PONG/i);
});

test("the agent calls the execute primitive and reports real sandbox output", opts, async () => {
  const { app } = freshApp();
  const r = await app.turn(
    dm("Use your execute tool to run `echo hello-from-sandbox`, then tell me exactly what it printed."),
  );
  assert.equal(r.status, "ok");
  assert.match(r.reply ?? "", /hello-from-sandbox/);
});

test("the agent writes then reads a file through the workspace primitives", opts, async () => {
  const { app } = freshApp();
  const r = await app.turn(
    dm(
      "Use the write tool to create fact.txt containing exactly: the sky is blue. " +
        "Then use the read tool to read it back and tell me the contents.",
    ),
  );
  assert.equal(r.status, "ok");
  assert.match(r.reply ?? "", /the sky is blue/i);
});

test("multi-turn memory persists within a session (set then recall)", opts, async () => {
  const { app } = freshApp();
  const set = await app.turn(dm("My favorite number is 7. Please remember it.", "mem"));
  assert.equal(set.status, "ok");
  const recall = await app.turn(dm("What is my favorite number? Reply with just the number.", "mem"));
  assert.equal(recall.status, "ok");
  assert.match(recall.reply ?? "", /\b7\b/);
});

test("the turn is recorded in the session log (user + assistant entries)", opts, async () => {
  const { app } = freshApp();
  const r = await app.turn(dm("Say hi in one word."));
  assert.equal(r.status, "ok");
  const found = await app.getSession(r.sessionId!);
  const types = found!.entries.map((e) => e.type);
  assert.ok(types.includes("user"));
  assert.ok(types.includes("assistant"));
});

test("internal-only still refuses a guest even with the real harness", opts, async () => {
  const { app } = freshApp();
  const r = await app.turn({
    surface: "e2e",
    actor: { externalId: "G1", isExternalGuest: true },
    conversation: { kind: "dm", threadRef: "g1" },
    text: "hello",
  });
  assert.equal(r.status, "refused");
});
