import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-session-authz-"));
  return buildApp(testConfig({ dataDir }));
}

function dm(text: string, thread: string, externalId: string): TurnRequest {
  return { surface: "test", actor: { externalId }, conversation: { kind: "dm", threadRef: thread }, text };
}

test("getSessionForViewer withholds metadata from a non-participant (no session-metadata IDOR)", async () => {
  const { app } = freshApp();

  const outcome = await app.turn(dm("my private question", "web:alice:private", "alice"));
  const sessionId = outcome.sessionId!;
  assert.ok(sessionId);

  const asAlice = await app.getSessionForViewer(sessionId, "alice");
  assert.ok(asAlice, "the owner reads her own session");
  assert.equal(asAlice!.session.id, sessionId);
  assert.equal(asAlice!.session.threadRef, "web:alice:private");

  const asCarol = await app.getSessionForViewer(sessionId, "carol");
  assert.equal(asCarol, null, "a non-participant cannot read the session row");
});
