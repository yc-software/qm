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
import { SIGNAL_POLL_MS, startSignalPoll, type RunSignal } from "../src/runs/run-signal-store.ts";
import { scopeId, type ClientToolResult } from "../src/types.ts";

const SECRET = "tool-approval-requests-secret!!".repeat(2);

test("a sandbox command's approval request reaches the live run, and is refused with the run's reason or withdrawn when no run answers", async () => {
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
      text: "archive record 7",
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
    const input = { operation: "invoke", tool: "archive_record", arguments: { id: 7 } };

    const appToken = await token({});
    const noTurn = await post({ tool: "records", input }, appToken);
    assert.equal(noTurn.status, 409);
    assert.equal(((await noTurn.json()) as { error: string }).error, "no_live_turn");
    assert.equal((await post({ tool: "records" }, live)).status, 400);

    const answering = (answer: (request: RunSignal) => ClientToolResult | Promise<ClientToolResult>) =>
      startSignalPoll(
        built.signals,
        runId,
        { onSteer: async () => {}, onAbort: async () => {}, onApprovalRequest: async (request) => answer(request) },
        { intervalMs: 20 },
      );
    const asked: RunSignal[] = [];
    const raising = answering((request) => {
      asked.push(request);
      return { content: "approval card abc123 raised", structured: { card: "abc123" } };
    });
    const raised = await post({ tool: "records", input }, live);
    await raising();
    assert.equal(raised.status, 200);
    assert.deepEqual(await raised.json(), { status: "pending_approval", card: "abc123" });
    assert.deepEqual(
      asked.map(({ tool, input: args }) => ({ tool, input: args })),
      [{ tool: "records", input }],
    );

    const slow = answering(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2 * SIGNAL_POLL_MS + 500));
      return { content: "approval card slow01 raised", structured: { card: "slow01" } };
    });
    const late = await post({ tool: "records", input }, live);
    await slow();
    assert.equal(late.status, 200, "a request the run already claimed is waited out, not withdrawn");
    assert.deepEqual(await late.json(), { status: "pending_approval", card: "slow01" });

    const declining = answering(() => ({ content: "this call doesn't need approval", isError: true }));
    const declined = await post({ tool: "records", input }, live);
    await declining();
    assert.equal(declined.status, 409);
    assert.deepEqual(await declined.json(), {
      error: "not_raised",
      message: "QM could not show an approval card for this call: this call doesn't need approval",
    });

    const unanswered = await post({ tool: "records", input }, live);
    assert.equal(unanswered.status, 409);
    assert.equal(
      ((await unanswered.json()) as { message: string }).message,
      "QM could not show an approval card for this call: no live turn answered",
    );
    assert.deepEqual(await built.signals.pending(runId), [], "the unanswered request was withdrawn");

    const claimed = (await built.runs.claim("w1", 60_000))[0]!;
    await built.runs.complete(runId, claimed.leaseToken!, { status: "ok", reply: "done" });
    const ended = await post({ tool: "records", input }, live);
    assert.equal(ended.status, 409);
    assert.equal(((await ended.json()) as { error: string }).error, "no_live_turn", "an ended turn refuses up front");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
