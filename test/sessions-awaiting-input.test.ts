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
  const dataDir = mkdtempSync(join(tmpdir(), "ap-awaiting-"));
  return buildApp(testConfig({ dataDir }));
}

const actor = { externalId: "U1" };
function dm(text: string, thread: string): TurnRequest {
  return { surface: "test", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

const BLOCKED_CMD = ["git", "push", `--${"force"}`, "origin", "main"].join(" ");

test("the awaitingInput flag clears once the pending approval is resolved", async () => {
  const { app } = freshApp();
  const paused = await app.turn(dm(`!run ${BLOCKED_CMD}`, "dm:U1:resolve"));
  assert.equal(paused.status, "pending_approval");
  const sid = paused.sessionId!;
  const requestId = paused.pendingApprovals?.[0]?.requestId;
  assert.ok(requestId);

  assert.equal((await app.listSessions("U1")).find((s) => s.id === sid)?.awaitingInput, true);

  await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:resolve" },
    text: "",
    approval: { requestId: requestId!, approved: false },
  });

  assert.ok(
    !(await app.listSessions("U1")).find((s) => s.id === sid)?.awaitingInput,
    "the flag clears after the approval is denied",
  );
});
