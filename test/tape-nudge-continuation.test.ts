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
        const failTapeMessage = options.failPrimaryTapeMessage && turn.input === "needs nudge";
        if (!failTapeMessage) {
          await turn.tape?.({
            kind: "message",
            harness: "pi",
            payload: { role: "assistant", content: [{ type: "text", text: reply }] },
            scopeLabel: turn.scopeLabel,
          });
        }
        const finalEntry = await turn.emit({
          type: "assistant",
          payload: { text: reply },
          scopeLabel: turn.scopeLabel,
        });
        if (!failTapeMessage && !(options.omitPrimaryCheckpoint && turn.input === "needs nudge")) {
          await turn.tape?.({
            kind: "annotation",
            payload: { subturnEnd: true },
            scopeLabel: turn.scopeLabel,
            entrySeq: finalEntry.seq,
          });
        }
        // A "needs nudge" turn ends with NO final reply text (like a real turn ending on
        // tool calls) — a text-bearing ending is now delivered directly, without a nudge.
        return {
          reply: turn.input === "needs nudge" ? "" : reply,
          modelCalls: 1,
          ...(failTapeMessage ? { tapeWriteFailed: true } : {}),
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
  const result = await orchestrator.handleTurn(
    input("needs nudge", {
      addressed: true,
      surfaceTools: true,
      deliveryTarget: "slack:C1:tape-nudge",
    }),
  );
  assert.equal(result.status, "silent");
  const session = await sessions.getByThread(conversation.threadRef);
  const entries = await sessions.getEntries(session!.id);
  assert.equal(scope, session!.scopeId);
  return { modes, folds, deliveries, sessions, session: session!, entries, orchestrator, input };
}

test("an exact first sub-turn continues its reply-or-decline nudge from the refreshed tape", async () => {
  const { modes, folds, deliveries, sessions, session, entries } = await runScenario();
  assert.deepEqual(modes, ["shadow", "serve", "serve"]);
  assert.ok(folds[2]!.some((message) => JSON.stringify(message).includes("worklog without a post")));
  assert.equal(
    (await deliveries.pending("slack")).some((delivery) => delivery.text === "nudged from tape"),
    true,
  );
  assert.equal(await sessions.tapeCoverage(session.id), entries.at(-1)!.seq);
});

test("a missing primary checkpoint forces the nudge back to reconstruction; complete writes still watermark", async () => {
  const { modes, sessions, session, entries } = await runScenario({ omitPrimaryCheckpoint: true });
  assert.deepEqual(modes, ["shadow", "serve", "shadow"]);
  assert.equal(await sessions.tapeCoverage(session.id), entries.at(-1)!.seq);
});

test("a stale nudge tape reread cannot certify the primary sub-turn; complete writes still watermark", async () => {
  const { modes, sessions, session, entries } = await runScenario({ staleNudgeRead: true });
  assert.deepEqual(modes, ["shadow", "serve", "shadow"]);
  assert.equal(await sessions.tapeCoverage(session.id), entries.at(-1)!.seq);
});

test("a pre-scopes legacy_import is superseded by the read-time heal and serves again", async () => {
  const { modes, folds, sessions, session, orchestrator, input } = await runScenario();
  const { lease: unscoped } = await sessions.acquireLease(session.id);
  assert.ok(unscoped);
  await sessions.appendTape(unscoped, {
    kind: "context_event",
    payload: {
      event: "legacy_import",
      messages: [{ role: "user", content: [{ type: "text", text: "pre-scopes import" }], timestamp: 1 }],
    },
    scopeLabel: scope,
  });
  await sessions.releaseLease(unscoped);
  await orchestrator.handleTurn(input("after unscoped import"));
  const rows = await sessions.getTape(session.id);
  const imports = rows.filter(
    (r) => r.kind === "context_event" && (r.payload as { event?: unknown }).event === "legacy_import",
  );
  assert.equal(imports.length, 2, "the heal re-imported over the scopeless import");
  assert.ok(Array.isArray((imports.at(-1)!.payload as { scopes?: unknown }).scopes), "the fresh import records scopes");
  assert.equal(modes.at(-1), "serve", "the session serves the same turn — no manual backfill run needed");
  assert.ok(
    !JSON.stringify(folds.at(-1)).includes("pre-scopes import"),
    "the healed fold supersedes the old import's content",
  );
  const entries = await sessions.getEntries(session.id);
  assert.equal(await sessions.tapeCoverage(session.id), entries.at(-1)!.seq);

  await orchestrator.handleTurn(input("next turn"));
  const importsAfter = (await sessions.getTape(session.id)).filter(
    (r) => r.kind === "context_event" && (r.payload as { event?: unknown }).event === "legacy_import",
  );
  assert.equal(importsAfter.length, 2, "the heal converges — no re-import once scopes are recorded");
});

test("a coverage gap self-heals at the next read: one legacy_import, served the same turn, watermark advances", async () => {
  const { modes, folds, sessions, session, orchestrator, input } = await runScenario();
  const { lease: breaker } = await sessions.acquireLease(session.id);
  assert.ok(breaker);
  const orphan = await sessions.append(breaker, {
    type: "user",
    payload: { text: "orphaned mid-deploy message" },
    scopeLabel: scope,
  });
  await sessions.releaseLease(breaker);
  assert.ok((await sessions.tapeCoverage(session.id)) < orphan.seq, "the orphan entry breaks coverage");

  await orchestrator.handleTurn(input("after the gap"));
  const rows = await sessions.getTape(session.id);
  const imports = rows.filter(
    (r) => r.kind === "context_event" && (r.payload as { event?: unknown }).event === "legacy_import",
  );
  assert.equal(imports.length, 1, "the read-time heal wrote exactly one import");
  assert.equal(imports[0]!.coversEntrySeq, orphan.seq, "the import covers through the orphan entry");
  assert.ok(Array.isArray((imports[0]!.payload as { scopes?: unknown }).scopes), "the heal records source scopes");
  assert.equal(modes.at(-1), "serve", "the healed tape serves the SAME turn");
  assert.ok(
    JSON.stringify(folds.at(-1)).includes("orphaned mid-deploy message"),
    "the served fold contains the orphaned entry",
  );
  const entries = await sessions.getEntries(session.id);
  assert.equal(
    await sessions.tapeCoverage(session.id),
    entries.at(-1)!.seq,
    "the watermark advances again — the latch is gone",
  );
});

test("a stopped partial withholds coverage until its saved text is imported for replay", async () => {
  const { modes, folds, sessions, session, entries, orchestrator, input } = await runScenario({ stoppedPartial: true });
  const partial = entries.find(
    (entry) =>
      entry.type === "assistant" && (entry.payload as { text?: unknown } | null)?.text === "worklog without a post",
  );
  assert.ok(partial);
  assert.ok((await sessions.tapeCoverage(session.id)) < partial.seq);

  await orchestrator.handleTurn(input("continue after stop"));
  assert.equal(modes.at(-1), "serve");
  assert.ok(JSON.stringify(folds.at(-1)).includes("worklog without a post"));
  const imports = (await sessions.getTape(session.id)).filter(
    (row) => row.kind === "context_event" && (row.payload as { event?: unknown }).event === "legacy_import",
  );
  assert.equal(imports.length, 1);
});

test("consecutive stopped turns heal one import each and converge once a turn completes", async () => {
  const { modes, folds, sessions, session, orchestrator, input } = await runScenario({ stoppedPartial: true });
  await orchestrator.handleTurn(input("keep stopping one"));
  await orchestrator.handleTurn(input("keep stopping two"));
  await orchestrator.handleTurn(input("continue after stops"));
  const countImports = async () =>
    (await sessions.getTape(session.id)).filter(
      (row) => row.kind === "context_event" && (row.payload as { event?: unknown }).event === "legacy_import",
    ).length;
  assert.equal(await countImports(), 3, "one heal per stopped predecessor — no compounding within a turn");
  assert.equal(modes.at(-1), "serve");
  const foldText = JSON.stringify(folds.at(-1));
  assert.ok(foldText.includes("worklog without a post"));
  assert.ok(foldText.includes("partial: keep stopping two"), "every stopped partial reaches the final fold");
  const entries = await sessions.getEntries(session.id);
  assert.equal(await sessions.tapeCoverage(session.id), entries.at(-1)!.seq, "the completed turn re-arms coverage");

  await orchestrator.handleTurn(input("one more"));
  assert.equal(await countImports(), 3, "no further imports once coverage is restored");
});

test("a stopped partial keeps withholding coverage when the direct delivery fails and the nudge replaces the result", async () => {
  const { sessions, session, entries, orchestrator, input } = await runScenario({
    stoppedPartial: true,
    failDirectDelivery: true,
  });
  const partial = entries.find(
    (entry) =>
      entry.type === "assistant" && (entry.payload as { text?: unknown } | null)?.text === "worklog without a post",
  );
  assert.ok(partial);
  assert.ok(
    (await sessions.tapeCoverage(session.id)) < partial.seq,
    "the nudge result must not launder the stopped primary into an advanced watermark",
  );

  await orchestrator.handleTurn(input("continue after stop"));
  const imports = (await sessions.getTape(session.id)).filter(
    (row) => row.kind === "context_event" && (row.payload as { event?: unknown }).event === "legacy_import",
  );
  assert.equal(imports.length, 1, "the stopped partial still reaches the replay via the heal");
});

test("a stopped partial whose tape message write ALSO failed still reaches the replay via the heal", async () => {
  const { modes, folds, orchestrator, input } = await runScenario({
    stoppedPartial: true,
    failPrimaryTapeMessage: true,
  });
  await orchestrator.handleTurn(input("continue after stop"));
  assert.equal(modes.at(-1), "serve");
  assert.ok(
    JSON.stringify(folds.at(-1)).includes("worklog without a post"),
    "the saved session entry supplies the partial even though its tape mirror never landed",
  );
});

test("overheard imports are this turn's own witnessed appends: served, watermarked, no heal import", async () => {
  const { modes, folds, sessions, session, orchestrator, input } = await runScenario();
  await orchestrator.handleTurn(
    input("what did I miss?", {
      overheard: [
        { role: "user", ts: "1712345678.100", name: "Bob", text: "intervening channel chatter" },
        { role: "user", ts: "1712345678.200", name: "Eve", text: "more chatter" },
      ],
    }),
  );
  const rows = await sessions.getTape(session.id);
  assert.equal(
    rows.some((r) => r.kind === "context_event" && (r.payload as { event?: unknown }).event === "legacy_import"),
    false,
    "no heal import — the pre-appends were mirrored, not a gap",
  );
  assert.equal(modes.at(-1), "serve", "the turn serves despite entries appended before the coverage read");
  assert.ok(
    JSON.stringify(folds.at(-1)).includes("intervening channel chatter"),
    "the fold includes the just-mirrored overheard rows",
  );
  const entries = await sessions.getEntries(session.id);
  assert.equal(
    await sessions.tapeCoverage(session.id),
    entries.at(-1)!.seq,
    "the watermark covers the overheard entries",
  );
});

test("a failed overheard mirror is a gap the same turn's read heals: import written, still served", async () => {
  const { modes, folds, sessions, session, orchestrator, input } = await runScenario();
  const realAppendTape = sessions.appendTape.bind(sessions);
  sessions.appendTape = async (lease, rec) => {
    if (rec.kind === "message" && rec.meta?.overheard) throw new Error("mirror down");
    return realAppendTape(lease, rec);
  };
  await orchestrator.handleTurn(
    input("what did I miss?", {
      overheard: [{ role: "user", ts: "1712345678.300", name: "Bob", text: "unmirrored chatter" }],
    }),
  );
  sessions.appendTape = realAppendTape;
  const rows = await sessions.getTape(session.id);
  const imports = rows.filter(
    (r) => r.kind === "context_event" && (r.payload as { event?: unknown }).event === "legacy_import",
  );
  assert.equal(imports.length, 1, "the failed mirror is treated as a gap and re-imported");
  assert.equal(modes.at(-1), "serve", "the healed tape still serves this turn");
  assert.ok(
    JSON.stringify(folds.at(-1)).includes("unmirrored chatter"),
    "the import preserved the unmirrored overheard content",
  );
  const entries = await sessions.getEntries(session.id);
  assert.equal(await sessions.tapeCoverage(session.id), entries.at(-1)!.seq);
});

test("a tainted session gets no tape read, no heal import, and no watermark", async () => {
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
  assert.equal(modes.at(-1), undefined, "taint disables the tape path entirely — not even shadow");
  const rows = await sessions.getTape(session.id);
  assert.equal(
    rows.some((r) => r.kind === "context_event" && (r.payload as { event?: unknown }).event === "legacy_import"),
    false,
    "the heal never writes an import for a tainted session",
  );
  const entries = await sessions.getEntries(session.id);
  assert.ok((await sessions.tapeCoverage(session.id)) < entries.at(-1)!.seq, "the watermark stays withheld");
});

test("a failed primary message append writes no completeness checkpoint", async () => {
  const { modes, sessions, session, entries } = await runScenario({ failPrimaryTapeMessage: true });
  assert.deepEqual(modes, ["shadow", "serve", "shadow"]);
  const primaryEndSeq = entries.find(
    (entry) =>
      entry.type === "assistant" && (entry.payload as { text?: unknown } | null)?.text === "worklog without a post",
  )!.seq;
  assert.equal(
    (await sessions.getTape(session.id)).some(
      (row) =>
        row.kind === "annotation" &&
        row.entrySeq === primaryEndSeq &&
        (row.payload as { subturnEnd?: unknown } | null)?.subturnEnd === true,
    ),
    false,
  );
  assert.ok((await sessions.tapeCoverage(session.id)) < entries.at(-1)!.seq);
});
