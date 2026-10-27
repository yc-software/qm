import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_BUDGET_TEXT } from "../../src/core/turn-error.ts";
import { scopeId } from "../../src/types.ts";
import { testConfig } from "../support/test-config.ts";

import { SESSION_BUSY_USER_TEXT } from "../../src/core/failure-copy.ts";
import { contextSummary } from "../../src/sessions/session-store.ts";
import { isOverheard, isUserMessage, messageTs, type Item } from "../../src/sessions/items.ts";
import type { SecurityScreener } from "../../src/security/security-screener.ts";
import { eventually, settle } from "../support/settle.ts";
import {
  noDefaultSandbox,
  buildTestApp,
  freshApp,
  failedTurn,
  spyProvisioning,
  internalActor,
  dm,
  activityItems,
} from "../support/orchestrator-app.ts";
import { selectDefaultSandbox } from "../support/default-sandbox.ts";

async function busyDiagnostic(app: ReturnType<typeof freshApp>, sessionId: string) {
  const busy = (await app.errors.list({ sessionId })).filter((e) => e.code === "session_busy");
  assert.equal(busy.length, 1, "exactly one durable row per refusal");
  assert.equal(busy[0]!.category, "sessions");
  return JSON.parse(busy[0]!.message) as {
    site: string;
    heldBy: string | null;
    heldForMs: number;
    expiresInMs: number;
    runId: string | null;
    surface: string | null;
  };
}

const turnFailure = (e: Item): { message: string } | null =>
  e.kind === "Error" && e.errorCode === "turn_failure" ? { message: e.text ?? "" } : null;

function fixtureScreen(): SecurityScreener {
  return {
    provider: "fixture-screen",
    async classify(input) {
      return {
        score: 1,
        threshold: 0.5,
        verdict: input.payload.includes("SCREENING_FIXTURE_BLOCK")
          ? { decision: "strict", reason: "fixture verdict" }
          : { decision: "auto" },
      };
    },
  };
}

async function screenEvent(built: ReturnType<typeof freshApp>, status: string) {
  for (let i = 0; i < 50; i++) {
    const event = (await built.auditLog.events()).find(
      (entry) => entry.action === "security_screen.classify" && entry.status === status,
    );
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`no ${status} screen verdict`);
}

test("a lease held briefly (compaction's write hold) delays the turn instead of refusing it", async () => {
  const built = freshApp({ turnLeaseWaitMs: 5_000 });
  const { app, sessions } = built;
  const first = await app.turn(dm("hello there"));
  assert.equal(first.status, "ok");

  const { lease } = await sessions.acquireLease(first.sessionId!, "compaction");
  assert.ok(lease, "hold the lease the way a compaction write does");
  setTimeout(() => void sessions.releaseLease(lease!), 300);

  const res = await app.turn(dm("are you there?"));
  assert.equal(res.status, "ok", res.reason);
  const busyRows = (await built.errors.list({ sessionId: first.sessionId! })).filter((e) => e.code === "session_busy");
  assert.equal(busyRows.length, 0, "a wait that succeeds is not an incident");
});

test("a 'session busy' refusal is recorded durably with the holder's remaining lock", async () => {
  const built = freshApp();
  const { app, sessions } = built;
  const first = await app.turn(dm("hello there"));
  assert.equal(first.status, "ok");

  const { lease } = await sessions.acquireLease(first.sessionId!, "compaction");
  assert.ok(lease, "hold the lease so the next turn lands on a busy session");
  const busy = await app.turn(dm("are you there?"));
  assert.equal(busy.status, "refused");
  assert.equal(busy.refusalKind, "session_busy");
  assert.equal(busy.reason, SESSION_BUSY_USER_TEXT, "the user-facing reason is the friendly note, not the raw status");
  assert.doesNotMatch(busy.reason ?? "", /session busy/);

  const d = await busyDiagnostic(built, first.sessionId!);
  assert.equal(d.site, "turn");
  assert.equal(d.surface, "test");
  assert.equal(d.heldBy, "compaction", "the row names the work that outranked the person");
  assert.ok(d.heldForMs >= 0, "the record dates the lock the refusal lost to");
  assert.ok(d.expiresInMs > 0, "…and says how much of its TTL is left, which separates a leak from a lapse");
  assert.ok(d.runId, "the refused turn names its own run, so the row joins to the runs table");
  await sessions.releaseLease(lease!);
});

test("a busy-refusal row stays jsonb-castable however the surface names itself", async () => {
  const built = freshApp();
  const { app, sessions } = built;
  const hostileSurface = `sla\u0000ck`;
  const first = await app.turn(dm("hello there", { surface: hostileSurface }));
  assert.equal(first.status, "ok");

  const { lease } = await sessions.acquireLease(first.sessionId!, "compaction");
  assert.ok(lease);
  assert.equal((await app.turn(dm("again", { surface: hostileSurface }))).status, "refused");

  const d = await busyDiagnostic(built, first.sessionId!);
  assert.equal(d.surface, "slack", "the null byte is stripped, not stored");
  assert.doesNotMatch(
    (await built.errors.list({ sessionId: first.sessionId! })).find((e) => e.code === "session_busy")!.message,
    /\u0000/,
    "no raw null byte survives into the durable message",
  );
  await sessions.releaseLease(lease!);
});

test("a HiLO approval carries a plain-English summary, persisted durably alongside the static reason", async () => {
  const { app } = freshApp();
  const first = await app.turn(dm("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;
  assert.match(pending.summary ?? "", /In plain English: git push --force origin main \(force push\)\./);
  assert.match(pending.reason, /force push/);

  const recovered = await app.getApproval(pending.requestId);
  assert.equal(recovered?.summary, pending.summary);
  const listed = await app.listSessionApprovals(first.sessionId!, internalActor.externalId);
  assert.equal(listed.find((a) => a.requestId === pending.requestId)?.summary, pending.summary);
});

test("a HiLO approval falls back to the static reason when the summarizer throws — never blocks the approval", async () => {
  const { app } = freshApp();
  const first = await app.turn(dm("!run rm -rf build !summary-boom"));
  assert.equal(first.status, "pending_approval", "the approval still surfaces despite the summary fault");
  const pending = first.pendingApprovals![0]!;
  assert.equal(pending.summary, undefined, "no summary on error");
  assert.match(pending.reason, /recursive delete/, "the static policy reason is the durable fallback");

  const recovered = await app.getApproval(pending.requestId);
  assert.equal(recovered?.summary, undefined);
  assert.match(recovered!.reason ?? "", /recursive delete/);
});

test("a HiLO approval summarizer that hangs past the deadline falls back without delaying the approval", async () => {
  const { app } = freshApp({ approvalSummaryTimeoutMs: 50 });
  assert.equal((await app.turn(dm("hello", { conversation: { kind: "dm", threadRef: "dm:U1:warm" } }))).status, "ok");
  const started = Date.now();
  const first = await app.turn(dm("!run rm -rf build !summary-hang"));
  assert.equal(first.status, "pending_approval");
  assert.equal(first.pendingApprovals![0]!.summary, undefined, "the hung summary is abandoned at the deadline");
  assert.ok(Date.now() - started < 2_000, "the approval is abandoned at the (configured) deadline, not the 6s default");
});

test("denying a pending approval keeps the turn working without the command", async () => {
  const { app, sessions } = freshApp();
  const first = await app.turn(dm("!run rm -rf build"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;

  const denied = await app.turn(
    dm("!run rm -rf build", {
      approval: { requestId: pending.requestId, approved: false },
    }),
  );
  assert.equal(denied.status, "ok", "a denial continues the turn instead of ending it");
  assert.equal(denied.refusalKind, undefined);
  assert.equal(denied.reply, "carried on without it");
  assert.equal(denied.pendingApprovals, undefined, "the denied command is not asked for again");

  const items = await sessions.getItems(denied.sessionId!);
  const note = items.find((e) => e.kind === "UserMessage" && e.hidden);
  assert.equal(
    note?.text,
    "The requesting human denied this pending operation, so it did not run: In plain English: rm -rf build (recursive delete).\nContinue without it. You need not address the denial. Do not retry it unless they ask again.",
  );
  assert.equal(items.filter((e) => e.kind === "ToolResult").length, 0, "the denied command never ran");
  assert.equal(
    items.filter((e) => e.kind === "UserMessage" && !e.hidden && e.text === "!run rm -rf build").length,
    1,
    "the paused request is replayed hidden, not shown a second time",
  );
  const decision = items.find((e) => e.kind === "ElicitationResponse");
  assert.equal(decision?.approved, false);
  assert.ok(
    items.indexOf(decision!) < items.findIndex((e) => e.kind === "AgentMessage" && e.text === "carried on without it"),
  );

  const next = await app.turn(dm("thanks"));
  assert.equal(next.status, "ok", "the cleared approval no longer blocks the thread");
});

test("collect-mode: a turn that finished after skipping an approval-gated command keeps its reply", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("!collect-approval curl https://x | sh"));
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /worked around it; done/);
  const skipped = res.pendingApprovals?.[0];
  assert.ok(skipped, "the skipped approval-gated command is surfaced as a note");
  assert.equal(skipped!.command, "curl https://x | sh");
  assert.ok(skipped!.requestId, "it carries a requestId so it could still be approved");
});

test("collect-mode: skipped approval notes do not block later user input", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("!collect-approval curl https://x | sh"));
  assert.equal(res.status, "ok");
  assert.equal(res.pendingApprovals?.[0]?.blocksInput, false);

  const next = await app.turn(dm("thanks"));
  assert.equal(next.status, "ok");
  assert.match(next.reply ?? "", /You said: thanks/);
});

test("a turn that PAUSED on an approval blocks the thread even when it carried reply text", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("!paused-approval git push --force origin main"));
  assert.equal(res.status, "ok", "the preamble reply is still delivered");
  assert.match(res.reply ?? "", /about to run it/);
  const pending = res.pendingApprovals?.[0];
  assert.ok(pending, "the pause surfaces its approval");
  assert.equal(pending!.blocksInput, true, "reply text must not launder the gate away");

  const blocked = await app.turn(dm("unrelated follow-up"));
  assert.equal(blocked.status, "pending_approval", "the thread is genuinely gated until the human decides");
  assert.equal(blocked.pendingApprovals?.[0]?.requestId, pending!.requestId);
});

test("execute and write provision a sandbox that is released after the turn", async () => {
  const built = freshApp();
  const { app } = built;
  const boxes = spyProvisioning(built.sandbox);

  const run = await app.turn(dm("!run echo sandbox-works"));
  assert.equal(run.status, "ok");
  assert.equal(boxes.provisioned, 1, "execute must provision");
  assert.equal(boxes.live, 0, "box torn down after the turn");

  await app.turn(dm("!write notes.md hi"));
  assert.equal(boxes.provisioned, 2, "write must provision");
});

test("thinking always reaches the run activity feed, with the model-bound signature stripped", async () => {
  const built = freshApp();
  const { app, runs } = built;
  const runViewFor = async (text: string) => {
    const run = (await runs.list()).find((r) => r.request.text === text);
    assert.ok(run, `a run was enqueued for ${text}`);
    return app.getRun(run!.id);
  };

  const on = await app.turn(dm("!think open plan"));
  assert.equal(on.status, "ok");
  const entries = (await app.getSession(on.sessionId!))!.items.filter((e) => e.kind === "Reasoning");
  assert.equal(entries.length, 1, "thinking is recorded durably");
  const onView = await runViewFor("!think open plan");
  const published = activityItems(onView?.activity).filter((a) => a.kind === "Reasoning");
  assert.equal(published.length, 1, "thinking is in the live feed");
  assert.equal(published[0]!.text, "open plan");
  assert.equal(published[0]!.step, entries[0]!.step, "the step identifies the live block it replaces");
  assert.equal(published[0]!.body.thinkingSignature, undefined, "signature stripped");
  assert.equal(onView?.reasoning, undefined, "the streamed block is settled once its entry is published");
});

test("channel session for an all-internal audience runs and is channel-scoped", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    origin: { kind: "direct" },
    surface: "test",
    actor: internalActor,
    conversation: { kind: "channel", threadRef: "C1:t1", channelRef: "C1", audience: [internalActor] },
    text: "hi channel",
  });
  assert.equal(res.status, "ok");
  const found = await app.getSession(res.sessionId!);
  assert.equal(found!.session.scopeId, "channel:C1");
  assert.equal(found!.session.type, "channel");
});

test("environments: an unattached scope provisions through its own scope (today's machine), an attached scope redirects", async () => {
  const config = testConfig({});
  const built = buildTestApp(config);
  const { app, sandbox } = built;
  const realProvision = sandbox.provision.bind(sandbox);
  let rwScope: string | undefined;
  sandbox.provision = (layers, opts) => {
    rwScope = layers.find((l) => l.mode === "rw")?.scopeId;
    return realProvision(layers, opts);
  };

  const before = await app.turn(dm("!run echo go"));
  assert.equal(before.status, "ok");
  assert.equal(rwScope, scopeId("personal", "U1"), "no attachment ⇒ provision through the scope itself");

  await selectDefaultSandbox(built, "U-shared", scopeId("personal", "U-shared"));
  const env = await app.createEnvironment({ scopeId: scopeId("personal", "U-shared"), name: "prod", actorId: "U1" });
  await app.attachScope({ scopeId: scopeId("personal", "U1"), environmentId: env.id, actorId: "U1" });

  rwScope = undefined;
  const after = await app.turn(dm("!run echo go2", { conversation: { kind: "dm", threadRef: "dm:U1:t2" } }));
  assert.equal(after.status, "ok");
  assert.equal(rwScope, env.id, "the attachment redirects the rw layer (machine/volume/backup) to the environment id");
});

test("eager provisioning warms the box on a tool-using session's next turn and still reclaims it", async () => {
  const built = freshApp();
  const boxes = spyProvisioning(built.sandbox);
  const warm = await built.app.turn(dm("!run echo warm"));
  assert.equal(warm.status, "ok");
  assert.equal(boxes.provisioned, 1, "the first turn provisions lazily at the tool call, as before");
  const res = await built.app.turn(dm("hello there"));
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /You said: hello there/);
  assert.equal(boxes.provisioned, 2, "the box is provisioned eagerly even though no tool ran this turn");
  await settle(() => boxes.live === 0);
});

test("eager provisioning never grows a computer for a chat-only session", async () => {
  const built = freshApp();
  const boxes = spyProvisioning(built.sandbox);
  const res = await built.app.turn(dm("hello there"));
  assert.equal(res.status, "ok");
  assert.equal(boxes.provisioned, 0, "a session with no tool history must stay lazy");
});

test("eager provisioning single-flights with the first tool call — one provision per turn, not two", async () => {
  const built = freshApp();
  const boxes = spyProvisioning(built.sandbox);
  const warm = await built.app.turn(dm("!run echo warm"));
  assert.equal(warm.status, "ok");
  const res = await built.app.turn(dm("!run echo hi"));
  assert.equal(res.status, "ok");
  assert.equal(boxes.provisioned, 2, "the eager kick and the tool call must share one in-flight provision");
});

test("a failed eager provision clears the slot — the tool call retries instead of inheriting the error", async () => {
  const built = freshApp();
  const boxes = spyProvisioning(built.sandbox);
  const warm = await built.app.turn(dm("!run echo warm"));
  assert.equal(warm.status, "ok");
  const realProvision = built.sandbox.provision.bind(built.sandbox);
  let failNext = true;
  let attempts = 0;
  built.sandbox.provision = async (layers, opts) => {
    attempts++;
    if (failNext) {
      failNext = false;
      throw new Error("transient provision fault");
    }
    return realProvision(layers, opts);
  };
  const res = await built.app.turn(dm("!run echo hi"));
  assert.equal(res.status, "ok", res.reason);
  assert.match(res.reply ?? "", /hi/);
  assert.equal(attempts, 2, "the eager failure must not poison the slot: the tool call re-provisions");
  assert.equal(boxes.live, 0);
});

test("a preamble failure after the machine boots still reclaims it", async () => {
  const built = freshApp();
  const boxes = spyProvisioning(built.sandbox);
  const realRemove = built.sandbox.removeDir.bind(built.sandbox);
  let failNext = true;
  built.sandbox.removeDir = async (handle, dir) => {
    if (failNext) {
      failNext = false;
      throw new Error("dir cleanup fault");
    }
    return realRemove(handle, dir);
  };
  await built.app.turn(dm("!run echo hi"));
  await settle(() => boxes.live === 0);
});

test("Door 2: an envelopeWrapped request on its own skips the overheard seed (replay preserves topic-scope)", async () => {
  const { app } = freshApp();
  const overheardEntries = (entries: Item[]) => entries.filter((e) => isOverheard(e));

  const wrapped = await app.turn(
    dm("did that work?", {
      conversation: { kind: "dm", threadRef: "dm:U1:door2-wrapped" },
      envelopeWrapped: true,
      overheard: [{ ts: "900.000", role: "user", name: "Avery", text: "unrelated chatter" }],
    }),
  );
  assert.equal(wrapped.status, "ok");
  const sw = await app.getSession(wrapped.sessionId!);
  assert.deepEqual(
    overheardEntries(sw!.items).map((e) => messageTs(e)),
    [],
    "envelopeWrapped ⇒ no overheard seed",
  );

  const plain = await app.turn(
    dm("did that work?", {
      conversation: { kind: "dm", threadRef: "dm:U1:door2-plain" },
      overheard: [{ ts: "901.000", role: "user", name: "Avery", text: "unrelated chatter" }],
    }),
  );
  assert.equal(plain.status, "ok");
  const sp = await app.getSession(plain.sessionId!);
  assert.deepEqual(
    overheardEntries(sp!.items).map((e) => messageTs(e)),
    ["901.000"],
    "no flag ⇒ overheard seeded",
  );
});

test("a terminal turn failure is recorded durably and never replays to the model", async () => {
  const built = freshApp({ maxAttempts: 1 });
  const { app, errors } = built;
  const t1 = await app.turn(dm("please summarize the attendee chats"));
  assert.equal(t1.status, "ok");

  await failedTurn(built, dm("!refuse"), /reduce refusals/);

  const recorded = (await errors.list()).find((e) => e.category === "turn" && e.code === "error");
  assert.ok(recorded, "the failure is recorded in the error log");
  assert.match(recorded!.message, /reduce refusals/, "the provider's own detail is kept for triage");

  const found = await app.getSession(t1.sessionId!);
  const failure = found!.items.find((e) => turnFailure(e));
  assert.ok(failure, "the failure is recorded in the durable transcript (it must survive a reload)");
  assert.match(turnFailure(failure!)!.message, /reduce refusals/);

  const after = await app.turn(dm("!histcount"));
  assert.equal(after.status, "ok");
  assert.equal(
    after.reply,
    "history:3",
    "model context is intact — both user turns and the reply; the failure record itself is excluded (forModelContext), so its text can never reach a model, the compaction summarizer included",
  );
});

test("a failure before the harness records the user message back-fills it — no orphan error in the transcript", async () => {
  const built = freshApp({ maxAttempts: 1 });
  const { app } = built;
  const t1 = await app.turn(dm("hello"));
  assert.equal(t1.status, "ok");

  await failedTurn(
    built,
    dm("use the fancy model", { model: "not-a-real-model", origin: { kind: "human" } }),
    /not approved/,
  );

  const found = await app.getSession(t1.sessionId!);
  const failureIdx = found!.items.findIndex((e) => turnFailure(e));
  assert.ok(failureIdx > 0, "the failure is recorded durably");
  const prior = found!.items[failureIdx - 1]!;
  assert.equal(prior.kind, "UserMessage", "the message that failed sits right above its error — not an orphan bubble");
  assert.equal(prior.text, "use the fancy model");
  assert.equal(prior.body.speakerId, "U1");

  const after = await app.turn(dm("!histcount"));
  assert.equal(after.status, "ok");
  assert.equal(
    after.reply,
    "history:3",
    "the back-filled message replays like any other user entry (hello + reply + the failed message; the failure record stays out)",
  );
});

test("repeated terminal failures keep failing loudly — history is never rewritten", async () => {
  const built = freshApp({ maxAttempts: 1 });
  const { app } = built;
  const t1 = await app.turn(dm("please summarize the attendee chats"));
  assert.equal(t1.status, "ok");

  await failedTurn(built, dm("!refuse"), /reduce refusals/);
  await failedTurn(built, dm("!refuse"), /reduce refusals/);

  const found = await app.getSession(t1.sessionId!);
  assert.equal(found!.items.filter((e) => turnFailure(e)).length, 2, "each failure leaves its own durable trace");
  assert.ok(
    !found!.items.some((e) => contextSummary(e)),
    "no summary boundary appears: recovering a wedged session (a fold) is an explicit decision, not a streak heuristic — a transient outage retried twice must not cost the user their history",
  );

  const after = await app.turn(dm("!histcount"));
  assert.equal(after.status, "ok");
  assert.equal(
    after.reply,
    "history:4",
    "the full conversation replays: two user turns + reply + each failed turn's own user entry; the failure records stay out of model context",
  );
});

test("an exhausted model budget refuses the turn with a plain explanation instead of failing or retrying", async () => {
  const { app, runs, errors } = freshApp();
  const t1 = await app.turn(dm("hello"));
  assert.equal(t1.status, "ok");

  const refused = await app.turn(dm("!over-budget", { idempotencyKey: "over-budget-1" }));
  assert.equal(refused.status, "refused");
  assert.equal(refused.refusalKind, "model_budget");
  assert.equal(refused.reason, MODEL_BUDGET_TEXT);
  assert.equal(await runs.activeForThread("dm:U1:t1"), null, "nothing is requeued to hit the same limit again");

  const found = await app.getSession(t1.sessionId!);
  const failures = found!.items.filter((e) => turnFailure(e));
  assert.equal(failures.length, 1, "the explanation survives a reload");
  assert.equal(turnFailure(failures[0]!)!.message, MODEL_BUDGET_TEXT);
  const logged = (await errors.list()).find((e) => e.category === "turn" && e.code === "model_budget");
  assert.match(logged!.message, /ExceededBudget: Team=team-a over 1d budget/, "operators keep the gateway's detail");
});

test("a RETRYABLE error that exhausts its budget leaves one durable turn_failure record — no dead air", async () => {
  const { app, runs, errors } = freshApp({ maxAttempts: 2 });
  const t1 = await app.turn(dm("hello"));
  assert.equal(t1.status, "ok");

  const req = dm("!boom-always", { idempotencyKey: "exhaust-1" });
  const exhausted = app.turn(req);
  const midway = await eventually(() => runs.activeForThread("dm:U1:t1"), {
    until: (run) => run?.status === "pending",
    label: "the run really is mid-cycle — requeued, not parked",
  });
  let found = await app.getSession(t1.sessionId!);
  assert.equal(
    found!.items.filter((e) => turnFailure(e)).length,
    0,
    "attempts with retry budget left write no failure record",
  );

  assert.equal((await exhausted).status, "failed");
  assert.equal(await runs.activeForThread("dm:U1:t1"), null, "the run parked: no attempt is left to record it");
  assert.equal((await runs.get(midway!.id))?.status, "failed");
  found = await app.getSession(t1.sessionId!);
  const failures = found!.items.filter((e) => turnFailure(e));
  assert.equal(failures.length, 1, "written exactly once across the whole retry-to-park cycle, never per attempt");
  assert.doesNotMatch(
    turnFailure(failures[0]!)!.message,
    /boom: simulated turn fault/,
    "an uncurated throw is internal — a database host, a stack-shaped TypeError, a cloud SDK error — so its text must not be published into the transcript",
  );
  assert.match(turnFailure(failures[0]!)!.message, /couldn't be completed/);
  const logged = (await errors.list()).find((e) => e.category === "turn" && e.code === "error");
  assert.match(logged!.message, /boom: simulated turn fault/, "operators still get the raw detail on the error rail");
  const visibleBoom = found!.items.filter(
    (e) => isUserMessage(e) && String(e.text ?? "") === "!boom-always" && e.hidden !== true,
  );
  assert.equal(visibleBoom.length, 1, "the failed message renders once above its error, never per attempt");
});

test("a turn carries its surface name to the harness, DM or not", async () => {
  const built = freshApp();
  assert.equal((await built.app.turn(dm("!surfacename", { surface: "web" }))).reply, "surface:web");
  assert.equal((await built.app.turn(dm("!surfacename", { surface: "slack" }))).reply, "surface:slack");
});

test("activated resource defaults preserve an existing computer and stop eager provisioning after unset", async () => {
  const built = freshApp();
  noDefaultSandbox.add(built);
  await selectDefaultSandbox(built, "U1", scopeId("personal", "U1"));
  await built.sessions.getOrCreateByThread("dm:U1:t1", "dm", "personal:U1");
  const boxes = spyProvisioning(built.sandbox);
  const warm = await built.app.turn(dm("!run echo warm"));
  assert.equal(warm.status, "ok", warm.reason);
  assert.equal(boxes.provisioned, 1);
  await built.sandboxResources.setDefault("U1", "personal:U1", null);
  const next = await built.app.turn(dm("hello after unset"));
  assert.equal(next.status, "ok", next.reason);
  assert.equal(boxes.provisioned, 1);
  assert.equal(boxes.live, 0);
  const newSession = await built.app.turn(
    dm("hello", { actor: { externalId: "new-user" }, conversation: { kind: "dm", threadRef: "dm:new:t1" } }),
  );
  assert.equal(newSession.status, "ok", newSession.reason);
  assert.equal(await built.sandboxResources.resolve("personal:new-user"), null);
  assert.equal(boxes.provisioned, 1);
});

for (const combined of [true, false]) {
  test(`turn cleanup retains recent and malformed paths and removes stale files (combined=${combined})`, async () => {
    const built = freshApp();
    if (!combined) built.sandbox.removeDirAndList = undefined;
    await selectDefaultSandbox(built, "U1", scopeId("personal", "U1"));
    const handle = await built.sandbox.provision([{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }]);
    const old = `.agent-turn/owner/${(Date.now() - 48 * 3600_000).toString(36)}-nonce/file`;
    const recent = `.agent-turn/owner/${Date.now().toString(36)}-nonce/file`;
    const malformed = ".agent-turn/owner/!invalid/file";
    for (const path of [old, recent, malformed]) await built.sandbox.writeFile(handle, path, "retained");
    const result = await built.app.turn(dm("!run true"));
    assert.equal(result.status, "ok", result.reason);
    assert.equal(await built.sandbox.readFile(handle, old), null);
    assert.equal(await built.sandbox.readFile(handle, recent), "retained");
    assert.equal(await built.sandbox.readFile(handle, malformed), "retained");
  });
}

test("narration reaches the live activity feed before its tool call", async () => {
  const { app, runs } = freshApp();
  const text = "!preamble I'll check the first item.";
  const result = await app.turn(dm(text));
  assert.equal(result.status, "ok");
  const run = (await runs.list()).find((entry) => entry.request.text === text);
  assert.ok(run);
  const view = await app.getRun(run.id);
  assert.deepEqual(
    view?.activity?.map((entry) => ("item" in entry ? entry.item.kind : entry.marker)),
    ["AgentMessage", "ToolCall", "ToolResult", "text_start"],
  );
  const narration = activityItems(view?.activity)[0]!;
  assert.deepEqual(
    { variant: narration.variant, text: narration.text, turnId: narration.turnId },
    { variant: "narration", text: "I'll check the first item.", turnId: run.id },
  );
  const marker = view?.activity?.at(-1);
  assert.ok(marker && "marker" in marker && marker.marker === "text_start");
  assert.equal(marker.streamOffset, "I'll check the first item.\n\n".length);
});

test("public text phases reach run activity with exact stream offsets but are not stored in session history", async () => {
  const { app, runs } = freshApp();
  const result = await app.turn(dm("!phased-reply"));
  assert.equal(result.status, "ok");
  assert.equal(result.reply, "All clear.");
  const run = (await runs.list()).find((entry) => entry.request.text === "!phased-reply");
  assert.ok(run);
  const view = await app.getRun(run.id);
  const history = await app.getSession(result.sessionId!);
  const expected = [
    { phase: "commentary", streamOffset: 0 },
    { phase: "final_answer", streamOffset: "Checking.\n\n".length },
  ];
  assert.deepEqual(
    view?.activity?.flatMap((entry) =>
      "marker" in entry && entry.marker === "text_start"
        ? [{ phase: entry.phase, streamOffset: entry.streamOffset }]
        : [],
    ),
    expected,
  );
  assert.ok(history);
  assert.equal(view?.partial, "Checking.\n\nAll clear.");
});

test("observe screening never waits on a hung classifier", async () => {
  const built = freshApp({}, { provider: "fixture-screen", classify: () => new Promise(() => {}) });
  const started = Date.now();
  const inbound = await built.app.turn(
    dm("summarize the event", {
      surface: "webhook",
      origin: { kind: "automation", screenData: "ordinary fixture data" },
    }),
  );
  const tool = await built.app.turn(dm("!screened-run printf observe-ok"));
  assert.equal(inbound.status, "ok");
  assert.equal(tool.reply, "observe-ok");
  assert.ok(Date.now() - started < 5_000);
});

test("screening observes: would-block verdicts are recorded without quarantine", async () => {
  const built = freshApp({}, fixtureScreen());
  const inbound = await built.app.turn(
    dm("summarize the event", {
      surface: "webhook",
      origin: { kind: "automation", screenData: "SCREENING_FIXTURE_BLOCK" },
    }),
  );
  assert.equal(inbound.status, "ok");
  const detail = JSON.parse((await screenEvent(built, "would_block")).detail!) as Record<string, unknown>;
  assert.equal(detail.hook, "user_input");
  assert.equal(detail.surface, "webhook");
  assert.deepEqual(detail.sources, ["webhook"]);
  assert.equal(typeof detail.thread, "string");
  assert.doesNotMatch(JSON.stringify(detail), /SCREENING_FIXTURE_BLOCK/);
  const tool = await built.app.turn(dm("!screened-run printf SCREENING_FIXTURE_BLOCK"));
  assert.match(tool.reply ?? "", /SCREENING_FIXTURE_BLOCK/);
  assert.equal(tool.pendingApprovals?.length ?? 0, 0);
  const events = await built.auditLog.events();
  assert.ok(!events.some((event) => event.status === "block" || event.action.startsWith("security_posture.")));
  const prompts = JSON.stringify(await built.sessions.listLlmRequests(inbound.sessionId!));
  assert.doesNotMatch(prompts, /NOT security-screened/);
});

test("environment inventories are incremental across real turns with a durable full-snapshot anchor", async () => {
  const { app, sessions } = freshApp();
  const first = await app.turn(dm("first", { timezone: "America/Los_Angeles" }));
  assert.equal(first.status, "ok");
  assert.match(first.reply ?? "", /## Sandbox provider/);
  const second = await app.turn(dm("second", { timezone: "America/Los_Angeles" }));
  assert.equal(second.status, "ok");
  assert.doesNotMatch(second.reply ?? "", /## Sandboxes|## Sandbox provider/);
  assert.match(second.reply ?? "", /## The user's local time/);
  const entries = await sessions.getItems(first.sessionId!);
  const users = entries.filter((entry) => isUserMessage(entry));
  const firstSnapshot = (users[0]!.body as { environmentSnapshot: { hashes: Record<string, string> } })
    .environmentSnapshot;
  assert.ok(Object.keys(firstSnapshot.hashes).some((key) => key.startsWith("Sandbox provider")));
  const secondSnapshot = (users[1]!.body as { environmentSnapshot: { anchorSeq: number } }).environmentSnapshot;
  assert.equal(secondSnapshot.anchorSeq, users[0]!.seq);
});
