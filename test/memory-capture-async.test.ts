import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { replayableRequest } from "../src/core/orchestrator/turn-helpers.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import type { MemoryStrategy } from "../src/memory/strategy.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import type { Harness } from "../src/harness/harness.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import type { Conversation, Principal } from "../src/types.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };
const dm = (thread: string, text: string): OrchestratorInput => ({
  surface: "test",
  actor,
  conversation: { kind: "dm", threadRef: thread, audience: [actor] } as Conversation,
  origin: { kind: "direct" },
  text,
});

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("fakeSandbox: a conversational memory turn must not touch the sandbox");
  };
  return {
    profile: {
      backend: "fake",
      writablePersistence: "snapshot_to_workspace",
      processSessions: false,
    },
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

function gatedHarness() {
  const base = createMockHarness();
  let started = 0;
  let finished = 0;
  const gates: Array<() => void> = [];
  const harness: Harness = {
    ...base,
    models: {
      ...base.models,
      async oneShot(system: string, prompt: string): Promise<string | undefined> {
        started++;
        await new Promise<void>((res) => gates.push(res));
        const output = await base.models.oneShot!(system, prompt);
        finished++;
        return output;
      },
    },
  };
  return {
    harness,
    release: () => gates.shift()?.(),
    get started() {
      return started;
    },
    get finished() {
      return finished;
    },
  };
}

function buildOrchestrator(harness: Harness, memory?: MemoryService, memoryStrategy?: MemoryStrategy) {
  const config = createMemoryConfigStore(ORG);
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "mca-")));
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "mca-deploy"),
    auditLog,
    acl,
  });
  return createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService(ORG, config, acl),
    sessions: createMemorySessionStore(),
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 1000, windowMs: 60_000 }),
    harness,
    memory: memory ?? createMemoryService(workspace),
    ...(memoryStrategy ? { memoryStrategy } : {}),
    deploy,
    acl,
  });
}

test("skipMemory turns neither recall nor capture", async () => {
  let recalls = 0;
  let captures = 0;
  const memory: MemoryService = {
    recall: async () => (recalls++, "remembered deployment state"),
    capture: async () => 0,
    query: async () => [],
    read: async () => "",
    replace: async () => {},
  };
  const orch = buildOrchestrator(createMockHarness(), memory, {
    onTurnEnd: async () => {
      captures++;
    },
  });

  const result = await orch.handleTurn({ ...dm("dm:U1:canary", "deployment canary"), skipMemory: true });

  assert.equal(result.status, "ok");
  assert.equal(recalls, 0);
  assert.equal(captures, 0);
});

test("approval replay preserves the memory opt-out", () => {
  assert.equal(replayableRequest({ ...dm("dm:U1:approval", "deployment canary"), skipMemory: true }).skipMemory, true);
});

test("capture does NOT block the turn: the reply returns while extraction is still in flight", async () => {
  const g = gatedHarness();
  const orch = buildOrchestrator(g.harness);

  const res = await orch.handleTurn(dm("dm:U1:tA", "remember my secret is ZULU77"));

  assert.equal(res.status, "ok");
  assert.equal(g.started, 1, "capture extraction was kicked off");
  assert.equal(g.finished, 0, "...but the turn returned WITHOUT awaiting it (still gated) — async");
  g.release();
});

test("recall does NOT block on an in-flight capture; continuity is eventually-consistent", async () => {
  const g = gatedHarness();
  const orch = buildOrchestrator(g.harness);

  await orch.handleTurn(dm("dm:U1:tA", "remember my secret is ZULU77"));
  assert.equal(g.finished, 0, "capture is still in flight after the first turn returns");

  const recall = orch.handleTurn(dm("dm:U1:tB", "!sysprompt"));
  const completedBeforeCapture = await Promise.race([
    recall.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  if (!completedBeforeCapture) g.release();
  assert.equal(
    completedBeforeCapture,
    true,
    "recall is NOT blocked on the in-flight capture (never block on extraction)",
  );
  assert.equal((await recall).status, "ok");

  g.release();
  let reply = "";
  for (let i = 0; i < 200 && !/ZULU77/.test(reply); i++) {
    await new Promise((r) => setTimeout(r, 10));
    reply = (await orch.handleTurn(dm(`dm:U1:tC${i}`, "!sysprompt"))).reply ?? "";
  }
  assert.match(reply, /ZULU77/, "the recalled fact appears once the detached capture has settled");
});
