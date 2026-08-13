import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import { createTurnStream } from "../src/runs/turn-stream.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("the stopped replay test must not provision a sandbox");
  };
  return {
    profile: { backend: "fake", writablePersistence: "snapshot_to_workspace", processSessions: false },
    provision: unreached as never,
    run: unreached as never,
    readFile: unreached as never,
    writeFile: unreached as never,
    writeFileBytes: unreached as never,
    readFileBytes: unreached as never,
    listDir: unreached as never,
    removeDir: unreached as never,
    teardown: unreached as never,
  };
}

test("a stopped partial survives coverage, restart, and continue replay", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let releasePartial!: () => void;
  const partialObserved = new Promise<void>((resolve) => {
    releasePartial = resolve;
  });
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (content: string, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: "cmpl-stop-replay",
          object: "chat.completion.chunk",
          model: "stop-replay-model",
          choices: [{ index: 0, delta: content ? { role: "assistant", content } : {}, finish_reason: finishReason }],
        })}\n\n`;
      if (requests.length === 1) {
        res.write(chunk("First, collect diagnostics.", null));
        return;
      }
      res.write(chunk("Continued safely.", null));
      res.write(chunk("", "stop"));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  setCustomProviders([
    {
      id: "stop-replay",
      name: "Stop Replay",
      protocol: "openai",
      baseUrl,
      models: [{ id: "stop-replay-model" }],
    },
  ]);

  const sessions = createMemorySessionStore();
  const actor: Principal = { id: "U1", type: "internal" };
  const scope = scopeId("personal", "U1");
  const conversation: Conversation = { kind: "dm", threadRef: "dm:stop-replay", audience: [actor] };
  const titledSession = await sessions.getOrCreateByThread(conversation.threadRef, conversation.kind, scope);
  await sessions.updateTitle(titledSession.id, "Stopped replay regression");
  const signals = createMemoryRunSignalStore();
  const turnStream = createTurnStream();
  const publish = turnStream.publish.bind(turnStream);
  turnStream.publish = (runId, delta) => {
    publish(runId, delta);
    if (delta.includes("First, collect diagnostics.")) releasePartial();
  };
  const harnessOptions = {
    modelId: "stop-replay-model",
    resolveProviderKeys: async () => ({ "stop-replay": "sk-test" }),
    signals,
    captureRequests: false,
    tempDirPrefix: `pi-stop-replay-${process.pid}`,
  };
  const tapeModes: Array<"shadow" | "serve" | undefined> = [];
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "pi-stop-replay-workspace-")));
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: createDockerDeployProvider(),
    deployDir: mkdtempSync(join(tmpdir(), "pi-stop-replay-deploy-")),
    auditLog,
    acl,
  });
  const makeOrchestrator = () => {
    const harness = createPiHarness(harnessOptions);
    const runTurn = harness.turns.runTurn.bind(harness.turns);
    harness.turns.runTurn = (turn) => {
      tapeModes.push(turn.tapeMode);
      return runTurn(turn);
    };
    return createOrchestrator({
      identity: createIdentityService(),
      resolution: createResolutionService("default-org", createMemoryConfigStore("default-org"), acl),
      sessionTapeMode: "serve",
      sessions,
      workspace,
      files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
      sandbox: fakeSandbox(),
      modelGateway: createModelGateway(),
      auditLog,
      rateLimiter: createRateLimiter({ maxPerWindow: 100, windowMs: 60_000 }),
      maxContextTokens: 120_000,
      harness,
      memory: createMemoryService(workspace),
      memoryPolicy: { recall: "off", capture: "off" },
      deploy,
      acl,
      deliveries: createDeliveryStore(),
      turnStream,
    });
  };
  const input = (text: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
    surface: "slack",
    actor,
    conversation,
    origin: { kind: "direct" },
    text,
    ...extra,
  });

  try {
    const stoppedTurn = makeOrchestrator().handleTurn(input("Collect diagnostics", { runId: "run-stop-replay" }));
    await partialObserved;
    await signals.send("run-stop-replay", { kind: "abort" });
    const stopped = await stoppedTurn;
    assert.equal(stopped.status, "ok");
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.reply, "First, collect diagnostics.");

    const session = await sessions.getByThread(conversation.threadRef);
    assert.ok(session);
    const entries = await sessions.getEntries(session.id);
    const partialEntry = entries.at(-1)!;
    assert.equal((partialEntry.payload as { text?: unknown }).text, "First, collect diagnostics.");
    assert.equal(await sessions.tapeCoverage(session.id), partialEntry.seq);

    const coveredRows = await sessions.getTape(session.id);
    const replayedPartial = coveredRows.find(
      (row) =>
        row.kind === "message" &&
        (row.payload as { role?: unknown; content?: unknown }).role === "assistant" &&
        JSON.stringify(row.payload).includes("First, collect diagnostics."),
    );
    assert.ok(replayedPartial);
    assert.equal((replayedPartial.payload as { stopReason?: unknown }).stopReason, "stop");

    const continued = await makeOrchestrator().handleTurn(input("continue"));
    assert.equal(continued.status, "ok");
    assert.equal(continued.reply, "Continued safely.");
    assert.equal(tapeModes.at(-1), "serve");
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]), /First, collect diagnostics\./);
  } finally {
    setCustomProviders([]);
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});
