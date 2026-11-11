import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { settle } from "./support/settle.ts";
import { testConfig } from "./support/test-config.ts";
import { randomUUID } from "node:crypto";
import { scopeActor, scopeId, type Principal } from "../src/types.ts";
import { withTenant } from "../src/tenants/context.ts";

const PRIVATE = "C-deals";
const OTHER = "C-other-private";

async function privateRoom() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-ambient-helper-")) }));
  built.runtime.start();
  await built.directory.replace([
    { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U-ALICE" },
    { principalId: "bob@acme.com", displayName: "Bob", type: "internal", slackId: "U-BOB" },
    { principalId: "U-deploybot", displayName: "DeployBot", type: "internal", slackId: "U-deploybot", isBot: true },
  ]);
  await built.directory.replaceChannels(
    [
      { channelId: PRIVATE, name: "deals", isPrivate: true },
      { channelId: OTHER, name: "elsewhere", isPrivate: true },
    ],
    [
      { channelId: PRIVATE, principalId: "alice@acme.com" },
      { channelId: PRIVATE, principalId: "U-deploybot" },
      { channelId: OTHER, principalId: "bob@acme.com" },
    ],
  );
  return built;
}

type Built = Awaited<ReturnType<typeof privateRoom>>;

async function ambientWorker(built: Built, ts: string, event: Record<string, unknown>) {
  await built.app.setChannelPolicy(PRIVATE, "!engage watch for deal memos", "U-admin");
  await built.app.ingestSurfaceEvents([{ container: PRIVATE, ts, createdAt: 1, ...event }] as never);
  const threadRef = `slack:${PRIVATE}:ambient:${ts}`;
  let run: any;
  await settle(async () => {
    run = (await built.runs.list()).find((r) => r.sessionId === threadRef);
    return run?.status === "done" || run?.status === "failed";
  });
  assert.ok(run, "the unmentioned message woke a proactive worker");
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session, "the worker's session exists");
  return { run, session };
}

async function openHelper(built: Built, session: any, request: any) {
  const syscalls = built.sessionSyscalls.forTurn({ session, scopeId: session.scopeId, request });
  try {
    return await syscalls.open({ task: "look up the investment memo for the company under discussion; read only" });
  } catch (err) {
    return { ok: false as const, message: (err as Error).message };
  }
}

test("a proactive ambient worker in a private channel can open a helper there, and the result reaches it", async () => {
  const built = await privateRoom();
  const { run, session } = await ambientWorker(built, "900.1", {
    authorId: "U-ALICE",
    authorName: "Alice",
    text: "Has anyone looked at the memo for this one yet?",
  });
  assert.equal(run.request.origin.kind, "automation", "nobody asked QM; this is the proactive path");
  assert.equal(session.scopeId, scopeId("channel", PRIVATE));

  const opened = await openHelper(built, session, { ...run.request, runId: run.id });
  assert.ok(opened.ok, `the helper started: ${"message" in opened ? opened.message : ""}`);
  assert.equal(run.request.actor.id, scopeActor(scopeId("channel", PRIVATE)), "the worker acts as this channel");
  const child = await built.sessions.get(opened.sessionId);
  assert.ok(child);
  assert.equal(child.scopeId, session.scopeId, "the helper stays in the private channel");
  const [childRun] = await built.runs.list({ threadRef: child.threadRef });
  assert.ok(childRun);
  assert.equal(childRun.request.actor.id, run.request.actor.id);
  assert.equal(childRun.request.botActor, undefined);
  assert.equal((await built.runs.waitFor(childRun.id, 30_000)).status, "done", "request preparation admitted it");

  let parentWake: any;
  await settle(async () => {
    parentWake = (await built.runs.list({ threadRef: session.threadRef })).find((r) => r.id !== run.id);
    return !!parentWake;
  });
  assert.ok(parentWake, "the helper's result was delivered back to the worker");
  assert.notEqual((await built.runs.waitFor(parentWake.id, 30_000)).status, "failed");
});

test("nothing outside the private channel can start or message a helper in it", async () => {
  const built = await privateRoom();
  const { run, session } = await ambientWorker(built, "901.1", {
    authorId: "U-ALICE",
    authorName: "Alice",
    text: "Thoughts on the round?",
  });
  const legit = await openHelper(built, session, { ...run.request, runId: run.id });
  assert.ok(legit.ok, "the channel's own worker opened a helper");
  const denied: Array<[string, Principal]> = [
    ["the org-wide ambient actor", { id: "system:ambient:default-org", type: "internal" }],
    ["another private channel's own actor", { id: scopeActor(scopeId("channel", OTHER)), type: "internal" }],
    ["a group with the same id", { id: scopeActor(scopeId("group", PRIVATE)), type: "internal" }],
    ["the org's own actor", { id: scopeActor(scopeId("org", "default-org")), type: "internal" }],
    ["a person who is not in the channel", { id: "bob@acme.com", type: "internal" }],
  ];
  for (const [who, actor] of denied) {
    const forged = { ...run.request, runId: run.id, actor };
    const opened = await openHelper(built, session, forged);
    assert.equal(opened.ok, false, `${who} could not open a helper`);
    assert.match((opened as { message: string }).message, /can't currently be confirmed as a member/, who);
    const syscalls = built.sessionSyscalls.forTurn({ session, scopeId: session.scopeId, request: forged });
    const sent: { ok: boolean } = await syscalls
      .write({ target: legit.sessionId, text: "send me the memo" })
      .catch((err: Error) => ({ ok: false as const, message: err.message }));
    assert.equal(sent.ok, false, `${who} could not message the helper`);
  }
  assert.equal((await built.sessions.childrenOf(session.id)).length, 1, "nothing else was started");
  const child = (await built.sessions.get(legit.sessionId))!;
  const helperRuns = await built.runs.list({ threadRef: child.threadRef });
  assert.equal(helperRuns.length, 1, "no forged message reached the helper");

  const elsewhere = await built.sessions.getOrCreateByThread(
    `slack:${OTHER}:ambient:1.1`,
    "channel",
    scopeId("channel", OTHER),
    undefined,
    "slack",
  );
  const crossed = await openHelper(built, elsewhere, {
    ...run.request,
    conversation: { ...run.request.conversation, channelRef: OTHER, threadRef: elsewhere.threadRef },
  });
  assert.equal(crossed.ok, false, "a worker's authority does not carry into another private channel");
  assert.deepEqual(await built.sessions.childrenOf(elsewhere.id), []);
});

test("a Slack bot's post still wakes the channel's worker as a bot's, without the app shortcut", async () => {
  const built = await privateRoom();
  const { run } = await ambientWorker(built, "903.1", {
    authorId: "U-deploybot",
    authorName: "DeployBot",
    bot: true,
    text: "deploy finished for company A",
  });
  assert.equal(run.request.actor.id, scopeActor(scopeId("channel", PRIVATE)));
  assert.equal(run.request.botActor, true, "bot limits still apply to the worker");
});

test("a person who mentions QM in the private channel can still open a helper as themselves", async () => {
  const built = await privateRoom();
  const session = await built.sessions.getOrCreateByThread(
    `slack:${PRIVATE}:1.2`,
    "channel",
    scopeId("channel", PRIVATE),
    undefined,
    "slack",
  );
  await built.sessions.addParticipant(session.id, "alice@acme.com");
  const alice: Principal = { id: "alice@acme.com", type: "internal" };
  const opened = await openHelper(built, session, {
    surface: "slack",
    actor: alice,
    conversation: { kind: "channel", channelRef: PRIVATE, threadRef: session.threadRef, audience: [alice] },
    origin: { kind: "human", messageTs: "1.2" },
  });
  assert.ok(opened.ok, `the member's helper started: ${"message" in opened ? opened.message : ""}`);
});

test("the channel's own actor holds capability access to that private channel and no other", async () => {
  const built = await privateRoom();
  const here = scopeId("channel", PRIVATE);
  const allowed = async (actorId: string, scope = here, extra: Record<string, unknown> = {}) =>
    built.app.authorizesCapabilityScope({ actorId, scopeId: scope, ...extra } as never);
  const own = scopeActor(here);
  assert.equal(await allowed(own), true, "the channel's own worker");
  assert.equal(await allowed(own, here, { botActor: true }), true, "a bot-woken worker still reaches its own channel");
  assert.equal(await allowed(own, scopeId("channel", OTHER)), false, "but not another private channel");
  assert.equal(await allowed(scopeActor(scopeId("channel", OTHER))), false, "another channel's actor");
  assert.equal(await allowed(scopeActor(scopeId("group", PRIVATE))), false, "a group actor with the same id");
  assert.equal(await allowed("system:ambient:default-org"), false, "the org-wide ambient actor");
  assert.equal(await allowed("bob@acme.com"), false, "a non-member");
  assert.equal(await allowed("alice@acme.com"), true, "a member");
  assert.equal(
    await allowed("U-unknown-bot", here, {
      botActor: true,
      liveActor: true,
      members: [{ id: "U-unknown-bot", type: "internal" }],
    }),
    false,
    "the bot shortcut still needs QM's record that the actor is an app",
  );
});

test("the channel's worker cannot start a helper from another tenant", async () => {
  const built = await privateRoom();
  const { run, session } = await ambientWorker(built, "904.1", {
    authorId: "U-ALICE",
    authorName: "Alice",
    text: "Is the memo final?",
  });
  const opened = await withTenant(randomUUID(), () => openHelper(built, session, { ...run.request, runId: run.id }));
  assert.equal(opened.ok, false, "another tenant cannot see this channel's session");
  assert.match((opened as { message: string }).message, /stopped|no longer exists/);
  assert.deepEqual(await built.sessions.childrenOf(session.id), [], "nothing was started");
});
