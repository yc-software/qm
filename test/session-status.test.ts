import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSessionStatus } from "../src/sessions/session-status.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import type { SessionStateEvent } from "../src/runs/session-state-bus.ts";

test("status accepts compound emoji and rejects multiple emoji, shortcodes, and empty text", () => {
  for (const emoji of ["✅", "🚀", "👩🏽‍💻", "🇺🇸", "1️⃣"]) assert.ok(isSessionStatus({ emoji, text: "Ready" }));
  for (const emoji of ["", "a", ":rocket:", "🚀✅"]) assert.equal(isSessionStatus({ emoji, text: "Ready" }), false);
  for (const text of ["Ready\ud800", "Ready\udc00"]) assert.equal(isSessionStatus({ emoji: "✅", text }), false);
  assert.equal(isSessionStatus(undefined), false);
  assert.ok(isSessionStatus(null));
});

test("status changes notify viewers without changing run state; former participants cannot write", async () => {
  const built = buildApp(testConfig({}));
  const turn = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "status-notify" },
    text: "hello",
  });
  const id = turn.sessionId!;
  await built.sessions.addParticipant(id, "U2");
  const events: SessionStateEvent[] = [];
  const unsub = built.app.subscribeSessionStates((e) => events.push(e));
  const status = { emoji: "✅", text: "PR merged" };
  assert.deepEqual((await built.app.updateSession(id, "U1", { status }))?.status, status);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.state, "metadata");
  assert.ok(events[0]?.participants?.includes("U2"));
  await built.sessions.removeParticipant(id, "U2");
  assert.equal(await built.app.updateSession(id, "U2", { status: null }), null);
  assert.deepEqual((await built.sessions.get(id))?.status, status);
  unsub();
});
