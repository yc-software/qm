import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { journeyTestOptions, startJourneyApp, waitFor, type JourneyApp } from "./support/journey-app.ts";
import type { ModelReply, ModelRequest } from "./support/fake-gateway.ts";

const ACTOR = "ops@example.com";
const SCOPE = `personal:${ACTOR}` as const;
const STATUS_REPLY = "STATUS-REPLY: still on it";
const STATUS_BUDGET_MS = 10_000;
const QUEUED_STATUS =
  "a web message to a busy thread queues behind the running task; answering it while the task runs needs a concurrent status path";

type Script = (req: ModelRequest, first: string, last: string) => ModelReply | Promise<ModelReply>;

const text = (content: unknown): string => JSON.stringify(content ?? "");
const firstUser = (req: ModelRequest) => text(req.messages.find((m) => m.role === "user")?.content);
const lastUser = (req: ModelRequest) => text(req.messages.findLast((m) => m.role === "user")?.content);
const mentions = (req: ModelRequest, needle: string) => req.messages.some((m) => text(m.content).includes(needle));

async function startHarness(script: Script): Promise<JourneyApp> {
  const app = await startJourneyApp(
    { maxRequestBytes: 10 * 1024 * 1024, contextWindowTokens: 200_000, maxOutputTokens: 16_000 },
    { securityScreen: "off" },
  );
  app.gateway.respond = (req) => {
    if (text(req.system).includes("You govern an agent's long-running goal"))
      return { text: '{"verdict":"complete","reasons":"the evidence shows every batch matched"}' };
    if (!req.tools?.some((t) => t.name === "execute")) return { text: "NONE" };
    if (lastUser(req).includes("Status?")) return { text: STATUS_REPLY };
    return script(req, firstUser(req), lastUser(req));
  };
  const computer = await app.built.sandboxResources.create(ACTOR, SCOPE, "sprites", "default");
  await app.built.sandboxResources.setDefault(ACTOR, SCOPE, computer.id);
  await app.built.featureFlags.setEnabled("persistent_subagents", SCOPE, true, ACTOR);
  return app;
}

async function send(app: JourneyApp, threadRef: string, message: string) {
  const sentAt = Date.now();
  const accepted = await app.built.app.turn({
    surface: "web",
    actor: { externalId: ACTOR },
    conversation: { kind: "dm", threadRef },
    text: message,
    async: true,
  });
  assert.equal(accepted.status, "queued", `the web message was accepted: ${JSON.stringify(accepted)}`);
  return { runId: accepted.runId!, sentAt };
}

function settled(app: JourneyApp, runId: string) {
  return waitFor(
    async () => {
      const run = await app.built.runs.get(runId);
      return run && (run.status === "done" || run.status === "failed")
        ? { status: run.status, reply: run.result?.reply, reason: run.result?.reason, at: Date.now() }
        : undefined;
    },
    `run ${runId} to settle`,
    120_000,
  );
}

async function assistantReplies(app: JourneyApp, threadRef: string): Promise<string[]> {
  const session = await app.built.sessions.getByThread(threadRef);
  if (!session) return [];
  const { entries } = await app.built.sessions.getContextWindow(session.id);
  return entries.filter((e) => e.type === "assistant").map((e) => text((e.payload as { text?: unknown }).text));
}

async function statusMidTask(
  t: TestContext,
  scenario: { script: Script; opening: string; underway: () => boolean; finalMarker: string },
): Promise<void> {
  const app = await startHarness(scenario.script);
  const threadRef = `web:${ACTOR}:status-${Date.now()}`;
  try {
    const long = await send(app, threadRef, scenario.opening);
    await waitFor(async () => scenario.underway(), "the long task to be under way");
    const status = await send(app, threadRef, "Status?");
    const statusRun = await settled(app, status.runId);
    const longRun = await settled(app, long.runId);
    const replies = await assistantReplies(app, threadRef);
    await t.test("the status question is answered and the long work still finishes, each exactly once", () => {
      assert.deepEqual(
        { status: statusRun.status, reply: statusRun.reply },
        { status: "done", reply: STATUS_REPLY },
        `status run: ${statusRun.reason ?? ""}`,
      );
      assert.equal(longRun.status, "done", `the long task's run ended ${longRun.status}: ${longRun.reason ?? ""}`);
      assert.ok(longRun.reply?.includes(scenario.finalMarker), `long task reply: ${longRun.reply}`);
      assert.equal(replies.filter((r) => r.includes(scenario.finalMarker)).length, 1, "one final reply");
      assert.equal(replies.filter((r) => r.includes("STATUS-REPLY")).length, 1, "one status reply");
    });
    await t.test(`the status reply arrives within ${STATUS_BUDGET_MS / 1000}s`, { todo: QUEUED_STATUS }, () => {
      assert.ok(
        statusRun.at - status.sentAt < STATUS_BUDGET_MS,
        `status reply took ${statusRun.at - status.sentAt}ms; the long task finished after ${longRun.at - long.sentAt}ms`,
      );
    });
  } finally {
    await app.stop();
  }
}

test("W5: Status? while a long command runs", journeyTestOptions(180_000), async (t) => {
  let commandStarted = false;
  await statusMidTask(t, {
    opening: "Export the full ledger to CSV",
    underway: () => commandStarted,
    finalMarker: "LEDGER-READY",
    script: (_req, _first, last) => {
      if (last.includes("EXPORT-DONE")) return { text: "Export finished: LEDGER-READY" };
      commandStarted = true;
      return { tool: "execute", input: { command: "sleep 12; echo EXPORT-DONE", purpose: "Export ledger" } };
    },
  });
});

test("W5: Status? while a goal keeps a long task going", journeyTestOptions(180_000), async (t) => {
  const BATCHES = 9;
  let batch = 0;
  await statusMidTask(t, {
    opening: "Keep reconciling the ledger batches until every one is matched",
    underway: () => batch >= 2,
    finalMarker: "GOAL-DONE",
    script: async (req, _first, last) => {
      if (last.includes("the goal is complete")) return { text: "GOAL-DONE: every batch matched" };
      if (last.includes(`batch-${batch}\\n`)) return { tool: "context", input: { action: "compact", mode: "recent" } };
      if (!mentions(req, "Goal registered") && batch === 0)
        return { tool: "goal", input: { action: "create", objective: "Every ledger batch is matched" } };
      if (batch < BATCHES) {
        batch++;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return { tool: "execute", input: { command: `echo batch-${batch}`, purpose: "Reconcile a batch" } };
      }
      return {
        tool: "goal",
        input: { action: "update", status: "complete", note: `batch-1 through batch-${BATCHES} matched` },
      };
    },
  });
});

test("W5: Status? while the parent waits on a subagent", journeyTestOptions(180_000), async (t) => {
  let childStarted = false;
  await statusMidTask(t, {
    opening: "Have a subagent compare the two vendors, then summarize",
    underway: () => childStarted,
    finalMarker: "VENDOR-SUMMARY",
    script: (req, first, last) => {
      if (first.includes("Compare vendor pricing")) {
        if (last.includes("VENDORS-DONE")) return { text: "VENDOR-REPORT: vendor B is cheaper" };
        childStarted = true;
        return { tool: "execute", input: { command: "sleep 12; echo VENDORS-DONE", purpose: "Compare vendors" } };
      }
      if (mentions(req, "VENDOR-REPORT")) return { text: "VENDOR-SUMMARY: go with vendor B" };
      if (mentions(req, "Opened subagent")) return { tool: "subagents", input: { action: "wait", timeoutMs: 60_000 } };
      return {
        tool: "subagents",
        input: { action: "open", task: "Compare vendor pricing for A and B", name: "vendors" },
      };
    },
  });
});
