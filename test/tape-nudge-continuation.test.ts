import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { defineHarness } from "../src/harness/harness.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };
const conversation: Conversation = {
  kind: "channel",
  threadRef: "ch:C1:tape-nudge",
  channelRef: "C1",
  audience: [actor],
};
const scope = scopeId("channel", "C1");

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("the tape nudge test must not provision a sandbox");
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

async function runScenario(
  options: {
    failDirectDelivery?: boolean;
    failPrimaryTapeMessage?: boolean;
    nudgeCrash?: boolean;
    nudgeStopped?: boolean;
    omitPrimaryCheckpoint?: boolean;
    staleNudgeRead?: boolean;
    stoppedPartial?: boolean;
  } = {},
) {
  const modes: Array<"shadow" | "serve" | undefined> = [];
  const folds: unknown[][] = [];
  const harness = defineHarness(
    {
      id: "pi",
      controlTransport: "in-process",
      toolTransport: "in-process",
      transcriptFormat: "pi",
      capabilities: new Set(),
    },
    {
      async runTurn(turn) {
        modes.push(turn.tapeMode);
        folds.push(turn.tapeFold ?? []);
        if (options.nudgeCrash && turn.input.startsWith("[system] You were addressed")) {
          throw new Error("fetch failed");
        }
        const text = [turn.input, turn.environment].filter(Boolean).join("\n\n");
        const userEntry = await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        await turn.tape?.({
          kind: "message",
          harness: "pi",
          payload: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
          scopeLabel: turn.scopeLabel,
          entrySeq: userEntry.seq,
          meta: { bareText: turn.input },
        });
        if (turn.input.startsWith("[system] You were addressed")) {
          if (options.nudgeStopped) {
            const reply = "Interrupted nudge partial";
            await turn.emit({
              type: "assistant",
              payload: { text: reply },
              scopeLabel: turn.scopeLabel,
            });
            return { reply, stopped: true, modelCalls: 1 };
          }
          await turn.tape?.({
            kind: "message",
            harness: "pi",
            payload: {
              role: "assistant",
              content: [{ type: "toolCall", id: "post-1", name: "slack", arguments: { action: "post" } }],
            },
            scopeLabel: turn.scopeLabel,
          });
          await turn.emit({
            type: "tool_call",
            payload: { tool: "slack", action: "post" },
            scopeLabel: turn.scopeLabel,
          });
          const posted = await turn.tools.post("nudged from tape");
          await turn.tape?.({
            kind: "message",
            harness: "pi",
            payload: {
              role: "toolResult",
              toolCallId: "post-1",
              toolName: "slack",
              content: [{ type: "text", text: posted.ok ? "ok" : "failed" }],
            },
            scopeLabel: turn.scopeLabel,
          });
          await turn.emit({
            type: "tool_result",
            payload: { tool: "slack", ok: posted.ok },
            scopeLabel: turn.scopeLabel,
          });
          await turn.tape?.({
            kind: "message",
            harness: "pi",
            payload: { role: "assistant", content: [{ type: "text", text: "posted" }] },
            scopeLabel: turn.scopeLabel,
          });
          const finalEntry = await turn.emit({
            type: "assistant",
            payload: { text: "posted" },
            scopeLabel: turn.scopeLabel,
          });
          await turn.tape?.({
            kind: "annotation",
            payload: { subturnEnd: true },
            scopeLabel: turn.scopeLabel,
            entrySeq: finalEntry.seq,
          });
          return { reply: "posted", modelCalls: 2 };
        }
        const stopAgain = options.stoppedPartial && turn.input.startsWith("keep stopping");
        let reply = "primed";
        if (turn.input === "needs nudge") reply = "worklog without a post";
        else if (stopAgain) reply = `partial: ${turn.input}`;
        if ((options.stoppedPartial && turn.input === "needs nudge") || stopAgain) {
          if (!options.failPrimaryTapeMessage) {
            await turn.tape?.({
              kind: "message",
              harness: "pi",
              payload: {
                role: "assistant",
                content: [{ type: "text", text: reply }],
                stopReason: "aborted",
              },
              scopeLabel: turn.scopeLabel,
            });
          }
          await turn.emit({
            type: "assistant",
            payload: { text: reply },
            scopeLabel: turn.scopeLabel,
          });
          return { reply, stopped: true, modelCalls: 1 };
        }
        if (options.failPrimaryTapeMessage && turn.input === "needs nudge") {
          throw new Error("tape append failed: primary message");
        }
        await turn.tape?.({
          kind: "message",
          harness: "pi",
          payload: { role: "assistant", content: [{ type: "text", text: reply }] },
          scopeLabel: turn.scopeLabel,
        });
        const finalEntry = await turn.emit({
          type: "assistant",
          payload: { text: reply },
          scopeLabel: turn.scopeLabel,
        });
        if (!(options.omitPrimaryCheckpoint && turn.input === "needs nudge")) {
          await turn.tape?.({
            kind: "annotation",
            payload: { subturnEnd: true },
            scopeLabel: turn.scopeLabel,
            entrySeq: finalEntry.seq,
          });
        }
        return {
          reply: turn.input === "needs nudge" ? "" : reply,
          modelCalls: 1,
        };
      },
      async screenSecurity() {
        return { decision: "auto" as const };
      },
    },
  );
  const sessions = createMemorySessionStore();
  if (options.staleNudgeRead) {
    const readTape = sessions.getTape.bind(sessions);
    let prePrimaryRows: Awaited<ReturnType<typeof readTape>> | undefined;
    sessions.getTape = async (sessionId) => {
      if (modes.length === 1) {
        prePrimaryRows = await readTape(sessionId);
        return prePrimaryRows;
      }
      if (modes.length === 2 && prePrimaryRows) return prePrimaryRows;
      return readTape(sessionId);
    };
  }
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "tape-nudge-")));
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "tape-nudge-deploy"),
    auditLog,
    acl,
  });
  const deliveries = createDeliveryStore();
  if (options.failDirectDelivery) {
    const enqueue = deliveries.enqueue.bind(deliveries);
    deliveries.enqueue = async (delivery) => {
      if (delivery.text === "worklog without a post") throw new Error("surface rejected the direct reply");
      return enqueue(delivery);
    };
  }
  const orchestrator = createOrchestrator({
    identity: createIdentityService(),
    resolution: createResolutionService(ORG, createMemoryConfigStore(ORG), acl),
    sessionTapeMode: "serve",
    sessions,
    workspace,
    files: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createRateLimiter({ maxPerWindow: 100, windowMs: 60_000 }),
    harness,
    memory: createMemoryService(workspace),
    deploy,
    acl,
    deliveries,
  });
  const input = (text: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
    surface: "slack",
    actor,
    conversation,
    origin: { kind: "direct" },
    text,
    ...extra,
  });

  await orchestrator.handleTurn(input("prime"));
  const second = orchestrator.handleTurn(
    input("needs nudge", {
      addressed: true,
      surfaceTools: true,
      deliveryTarget: "slack:C1:tape-nudge",
    }),
  );
  if (options.nudgeCrash) {
    await assert.rejects(second, /fetch failed/);
  } else if (options.failPrimaryTapeMessage && !options.stoppedPartial) {
    await assert.rejects(second, /tape append failed/);
  } else {
    assert.equal((await second).status, "silent");
  }
  const session = await sessions.getByThread(conversation.threadRef);
  const entries = await sessions.getEntries(session!.id);
  assert.equal(scope, session!.scopeId);
  return { modes, folds, deliveries, sessions, session: session!, entries, orchestrator, input };
}

test("an exact first sub-turn continues its reply-or-decline nudge from the refreshed tape", async () => {
  const { modes, folds, deliveries } = await runScenario();
  assert.deepEqual(modes, ["shadow", "serve", "serve"]);
  assert.ok(folds[2]!.some((message) => JSON.stringify(message).includes("worklog without a post")));
  assert.equal(
    (await deliveries.pending("slack")).some((delivery) => delivery.text === "nudged from tape"),
    true,
  );
});

test("a missing primary checkpoint forces the nudge back to reconstruction", async () => {
  const { modes } = await runScenario({ omitPrimaryCheckpoint: true });
  assert.deepEqual(modes, ["shadow", "serve", "shadow"]);
});

test("a stale nudge tape reread forces the nudge back to reconstruction", async () => {
  const { modes } = await runScenario({ staleNudgeRead: true });
  assert.deepEqual(modes, ["shadow", "serve", "shadow"]);
});

test("a user-stopped turn skips direct delivery and the reply nudge", async () => {
  const { modes, deliveries, sessions, session, entries } = await runScenario({
    stoppedPartial: true,
    failDirectDelivery: true,
  });
  assert.deepEqual(modes, ["shadow", "serve"]);
  assert.deepEqual(await deliveries.pending("slack"), []);
  assert.ok(
    entries.some(
      (entry) => entry.type === "assistant" && (entry.payload as { text?: string }).text === "worklog without a post",
    ),
  );
  assert.ok((await sessions.getTape(session.id)).some((row) => row.kind === "stop"));
});

test("overheard messages are mirrored and served on the same turn", async () => {
  const { modes, folds, sessions, session, orchestrator, input } = await runScenario();
  await orchestrator.handleTurn(
    input("what did I miss?", {
      overheard: [
        { role: "user", ts: "1712345678.100", name: "Bob", text: "intervening channel chatter" },
        { role: "user", ts: "1712345678.200", name: "Eve", text: "more chatter" },
      ],
    }),
  );
  assert.equal(modes.at(-1), "serve");
  assert.ok(JSON.stringify(folds.at(-1)).includes("intervening channel chatter"));
  assert.equal(
    (await sessions.getTape(session.id)).some(
      (row) => row.kind === "context_event" && (row.payload as { event?: string }).event === "legacy_import",
    ),
    false,
  );
});

test("a failed overheard mirror fails the turn loudly", async () => {
  const { sessions, orchestrator, input } = await runScenario();
  const appendTape = sessions.appendTape.bind(sessions);
  sessions.appendTape = async (lease, rec) => {
    if (rec.kind === "message" && rec.meta?.overheard) throw new Error("mirror down");
    return appendTape(lease, rec);
  };
  await assert.rejects(
    orchestrator.handleTurn(
      input("what did I miss?", {
        overheard: [{ role: "user", ts: "1712345678.300", name: "Bob", text: "unmirrored chatter" }],
      }),
    ),
    /mirror down/,
  );
});

test("a tainted session cannot serve native tape history", async () => {
  const { modes, sessions, session, orchestrator, input } = await runScenario();
  const { lease } = await sessions.acquireLease(session.id);
  assert.ok(lease);
  await sessions.append(lease, {
    type: "user",
    payload: { text: "quarantined content", securityTainted: true },
    scopeLabel: scope,
  });
  await sessions.releaseLease(lease);
  await orchestrator.handleTurn(input("after the quarantine"));
  assert.equal(modes.at(-1), undefined);
});

test("a failed primary message append fails the turn before any nudge or checkpoint", async () => {
  const { modes, sessions, session, entries } = await runScenario({ failPrimaryTapeMessage: true });
  assert.deepEqual(modes, ["shadow", "serve"]);
  const turnUserSeq = entries.find(
    (entry) => (entry.payload as { text?: unknown } | null)?.text === "needs nudge",
  )!.seq;
  assert.equal(
    (await sessions.getTape(session.id)).some(
      (row) =>
        row.kind === "annotation" &&
        (row.entrySeq ?? -1) >= turnUserSeq &&
        (row.payload as { subturnEnd?: unknown } | null)?.subturnEnd === true,
    ),
    false,
  );
});

test("a nudge crash preserves the completed primary sub-turn on tape", async () => {
  const { modes, folds, orchestrator, input } = await runScenario({ nudgeCrash: true });
  await orchestrator.handleTurn(input("after the crash"));
  assert.equal(modes.at(-1), "serve");
  assert.ok(JSON.stringify(folds.at(-1)).includes("worklog without a post"));
});

test("a cancel-stopped turn delivers nothing anywhere and returns silent", async () => {
  const { deliveries, orchestrator, input } = await runScenario({ stoppedPartial: true });
  const posted: string[] = [];
  const enqueue = deliveries.enqueue.bind(deliveries);
  deliveries.enqueue = async (delivery) => {
    posted.push(delivery.text);
    return enqueue(delivery);
  };
  const controller = new AbortController();
  controller.abort("user");
  const result = await orchestrator.handleTurn(
    input("keep stopping this run", {
      addressed: true,
      surfaceTools: true,
      deliveryTarget: "slack:C1:tape-nudge",
      cancel: controller.signal,
    }),
  );
  assert.equal(result.status, "silent", "the losing side of a cancellation never completes as deliverable");
  assert.deepEqual(posted, [], "no direct reply, no nudge, no fallback delivery from the cancelled turn");
});

test("Stop during the reply nudge suppresses its fallback delivery", async () => {
  const { modes, deliveries, sessions, session } = await runScenario({ nudgeStopped: true });
  assert.deepEqual(modes, ["shadow", "serve", "serve"]);
  assert.deepEqual(await deliveries.pending("slack"), []);
  assert.ok((await sessions.getTape(session.id)).some((row) => row.kind === "stop"));
});
