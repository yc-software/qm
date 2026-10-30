import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import type { Agent } from "../src/agent/agent.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { turnToolOptions } from "../src/agent/turn-support.ts";
import { createMonitorPoller } from "../src/monitors/monitor-poller.ts";
import { createMonitorStore } from "../src/monitors/monitor-store.ts";
import { createMemoryProcessRegistry } from "../src/processes/process-registry.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import type { ProcessSandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

const actor = { externalId: "U1" };
const threadRef = "web:U1:watch";

function exitedJobSandbox(): ProcessSandbox {
  const handle: SandboxHandle = { id: "vm", rootDir: "/workspace", homeDir: "/root" };
  const output = "Successfully logged in\n";
  return {
    profile: { backend: "fake", writablePersistence: "resident_disk", processSessions: true },
    provision: async () => handle,
    run: async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }),
    readFile: async () => null,
    writeFile: async () => {},
    writeFileBytes: async () => {},
    readFileBytes: async () => null,
    listDir: async () => [],
    removeDir: async () => {},
    startProcess: async () => ({ processId: "p-1" }),
    readProcess: async (_h, _id, opts) => ({
      chunks: output.slice(opts?.sinceCursor ?? 0),
      cursor: output.length,
      status: { state: "exited", code: 0 },
    }),
    writeStdin: async () => {},
    signalProcess: async () => {},
    listProcesses: async () => [],
    teardown: async () => {},
  };
}

test("a watch wake in a delegating conversation keeps the command tools of the turn that armed it", async () => {
  const toolsBySurface = new Map<string, string[]>();
  const agent: Agent = {
    async runTurn(turn) {
      const tools = createAgentTools(
        { current: turn.tools, scopeLabel: turn.scopeLabel, emit: turn.emit, pendingApprovals: [] },
        turnToolOptions({}, turn),
      );
      const surface = /<wake reason="monitor"/.test(turn.input) ? "monitor" : "web";
      toolsBySurface.set(
        surface,
        tools.map((t) => t.name),
      );
      return { reply: "done", modelCalls: 1 };
    },
  };
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "monitor-wake-tools-")) }), { agent });
  built.runtime.start();
  try {
    await built.featureFlags.setEnabled("responsive_spine", scopeId("personal", "U1"), true, "test");
    const conversation = { kind: "dm" as const, threadRef, audience: [actor] };
    const armed = await built.app.turn({ surface: "web", actor, conversation, text: "sign in", liveActor: true });
    assert.equal(armed.status, "ok", armed.reply);

    const monitors = createMonitorStore();
    const processes = createMemoryProcessRegistry();
    await processes.register({
      processId: "p-1",
      scopeId: scopeId("personal", "U1"),
      sandboxId: "sandbox-1",
      kind: "background",
      command: "aws sso login",
      ttlMs: 600_000,
    });
    await monitors.create({
      owner: "U1",
      createdBy: "U1",
      ownerScopeId: scopeId("personal", "U1"),
      destination: { type: "web", target: threadRef, audienceScopeId: scopeId("personal", "U1") },
      processId: "p-1",
      command: "aws sso login",
      threadRef,
      expiresAt: Date.now() + 600_000,
    });
    const poller = createMonitorPoller({
      ...singleProcessDeps(),
      monitors,
      processes,
      sandbox: exitedJobSandbox(),
      deliveries: createDeliveryStore(),
      idempotency: createIdempotencyStore(),
      identity: createIdentityService(),
      run: (req) => built.app.turn(req),
    });
    await poller.tick();

    const armingTools = toolsBySurface.get("web") ?? [];
    const wakeTools = toolsBySurface.get("monitor") ?? [];
    assert.ok(armingTools.includes("execute") && armingTools.includes("background"), armingTools.join(","));
    assert.ok(wakeTools.length > 0, "the watch woke the conversation");
    assert.ok(wakeTools.includes("execute"), `the wake can run commands: ${wakeTools.join(",")}`);
    assert.ok(wakeTools.includes("background"), `the wake can manage the job it watched: ${wakeTools.join(",")}`);
  } finally {
    await built.runtime.stop();
  }
});
