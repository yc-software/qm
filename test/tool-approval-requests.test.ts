import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { startSignalPoll, type RunSignal } from "../src/runs/run-signal-store.ts";
import { approvalCardId, toolCallApprovalKey } from "../src/core/approval-id.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "tool-approval-requests-secret!!".repeat(2);

test("a sandbox command's approval request reaches the live run, and is withdrawn when no run takes it", async () => {
  const built = buildApp(
    testConfig({
      signingSecret: SECRET,
      dataDir: mkdtempSync(join(tmpdir(), "tool-approvals-")),
      backgroundWorkEnabled: false,
    }),
  );
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    sessions: built.sessions,
    runs: built.runs,
    signals: built.signals,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const ack = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t-approvals" },
      text: "update the RSVP labels",
      async: true,
    });
    const runId = ack.runId!;
    const run = (await built.runs.get(runId))!;
    const actorId = run.request.actor.id!;
    const token = (claims: Record<string, unknown>) =>
      mintCapabilityToken(
        {
          actorId,
          scopeId: scopeId("personal", actorId),
          aud: CONTROL_PLANE_AUD,
          exp: Date.now() + CAPABILITY_TTL_MS,
          ...claims,
        },
        SECRET,
      );
    const live = await token({ runId, sessionId: run.sessionId });
    const post = (body: unknown, capability: string) =>
      fetch(`${base}/v1/tool-approvals`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-capability": capability },
        body: JSON.stringify(body),
      });
    const input = { operation: "invoke", tool: "update_meetup_rsvp_labels", arguments: { meetup_id: 7 } };

    const appToken = await token({});
    const noTurn = await post({ tool: "ycli", input }, appToken);
    assert.equal(noTurn.status, 409);
    assert.equal(((await noTurn.json()) as { error: string }).error, "no_live_turn");
    assert.equal((await post({ tool: "ycli" }, live)).status, 400);

    const taken: RunSignal[] = [];
    const stopTaking = startSignalPoll(
      built.signals,
      runId,
      {
        onSteer: async () => {},
        onAbort: async () => {},
        onApprovalRequest: async (request) => (taken.push(request), true),
      },
      { intervalMs: 20 },
    );
    const raised = await post({ tool: "ycli", input }, live);
    await stopTaking();
    assert.equal(raised.status, 200);
    assert.deepEqual(await raised.json(), {
      status: "pending_approval",
      card: approvalCardId(toolCallApprovalKey("ycli", input)),
    });
    assert.deepEqual(
      taken.map(({ tool, input: args }) => ({ tool, input: args })),
      [{ tool: "ycli", input }],
    );

    const stopDeclining = startSignalPoll(
      built.signals,
      runId,
      { onSteer: async () => {}, onAbort: async () => {}, onApprovalRequest: async () => false },
      { intervalMs: 20 },
    );
    const refused = post({ tool: "ycli", input }, live);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const claimed = (await built.runs.claim("w1", 60_000))[0]!;
    await built.runs.complete(runId, claimed.leaseToken!, { status: "ok", reply: "done" });
    const answer = await refused;
    await stopDeclining();
    assert.equal(answer.status, 409);
    assert.equal(((await answer.json()) as { error: string }).error, "not_raised");
    assert.deepEqual(await built.signals.pending(runId), [], "the unanswered request was withdrawn");
    assert.equal((await post({ tool: "ycli", input }, live)).status, 409, "an ended turn refuses up front");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
