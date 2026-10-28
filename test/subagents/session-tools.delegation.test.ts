import { jsonbStringify } from "../../src/util/text.ts";
import { createSessionMailbox, type SessionMessage } from "../../src/sessions/session-mailbox.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createSessionSyscalls } from "../../src/subagents/session-tools.ts";
import { deliverSubagentMail, MAIL_WAKE_TEXT } from "../../src/subagents/mail.ts";
import { requiresDelegation, delegatedAuthorizationOrigin } from "../../src/subagents/delegation.ts";
import { scopeId, type Conversation, type Principal } from "../../src/types.ts";
import type { RunStore } from "../../src/runs/run-store.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { claimTurn, completeTurn, finishTurn } from "../support/turns.ts";
import {
  actor,
  scope,
  conversation,
  rig,
  freshSession,
  delegatedHumanRig,
  closeRigStores,
} from "../support/subagent-rig.ts";

after(closeRigStores);

test("private session replies stay read-only, queue behind running work, and do not return to a parent", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const initial = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.equal(initial.request.origin.kind, "automation");
  await claimTurn(r.ledger, initial.id);
  const factory = createSessionSyscalls({
    ...r,
    maxAttempts: 3,
  });
  const privateCaller = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: { actor, conversation, readOnly: true, privateSessionMessage: true, sessionMessageDepth: 1 },
  });
  assert.equal((await privateCaller.open({ task: "escape" })).ok, false);
  assert.equal((await privateCaller.write({ target: child.id, interrupt: true })).ok, false);
  const sent = await privateCaller.write({ target: child.id, text: "Here is the answer" });
  assert.ok(sent.ok);
  assert.equal(sent.delivered, "queued_message");
  assert.equal((await r.signals.takePending(initial.id)).length, 0);
  assert.equal((await r.runs.inFlightForThread(child.threadRef)).length, 1);
  assert.equal((await r.mailbox.pending(child.id)).length, 1);
  assert.equal((await privateCaller.write({ target: child.id, text: "wake", followup: true })).ok, false);
  const exhausted = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: { actor, conversation, readOnly: true, privateSessionMessage: true, sessionMessageDepth: 8 },
  });
  assert.equal((await exhausted.write({ target: child.id, text: "loop" })).ok, false);
});

test("retrying open after an uncertain enqueue recovers one child and rejects a changed request", async (t) => {
  const r = await rig();
  const enqueue = r.runs.enqueue.bind(r.runs);
  let loseReceipt = true;
  t.mock.method(r.runs, "enqueue", async (input: Parameters<RunStore["enqueue"]>[0]) => {
    const result = await enqueue(input);
    if (loseReceipt) {
      loseReceipt = false;
      throw new Error("lost receipt");
    }
    return result;
  });
  const input = { task: "one delegation", requestId: "stable-call" };
  assert.equal((await r.syscallsFor(r.room).open(input)).ok, false);
  const retry = await r.syscallsFor(r.room).open(input);
  assert.ok(retry.ok);
  const children = await r.sessions.childrenOf(r.room.id);
  assert.equal(children.length, 1);
  assert.equal(retry.sessionId, children[0]!.id);
  assert.equal((await r.runs.inFlightForThread(children[0]!.threadRef)).length, 1);
  assert.equal((await r.syscallsFor(r.room).open({ ...input, task: "different work" })).ok, false);
});

test("opens and writes queue on their own session tree's admission lock", async (t) => {
  const r = await rig();
  const keys: string[] = [];
  const withLock = r.advisoryLock.withLock.bind(r.advisoryLock);
  t.mock.method(r.advisoryLock, "withLock", (key: string, fn: () => Promise<unknown>) => {
    keys.push(key);
    return withLock(key, fn);
  });
  const opened = await r.syscallsFor(r.room).open({ task: "one" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  assert.ok((await r.syscallsFor(child).open({ task: "grandchild" })).ok);
  assert.ok((await r.syscallsFor(r.room).write({ target: child.id, text: "hi" })).ok);
  const other = await r.sessions.getOrCreateByThread("slack:dm:D2", "dm", scope, undefined, "slack");
  await r.sessions.addParticipant(other.id, actor.id);
  assert.ok((await r.syscallsFor(other).open({ task: "elsewhere" })).ok);
  const tree = `session-tree-admission:${r.room.id}`;
  assert.deepEqual(keys, [tree, tree, tree, `session-tree-admission:${other.id}`]);
});

test("retrying an unqueued child preserves detachment and uses its current tree capacity", async (t) => {
  const r = await rig({ treeRunCap: 1 });
  const enqueue = r.runs.enqueue.bind(r.runs);
  let fail = true;
  t.mock.method(r.runs, "enqueue", async (input: Parameters<RunStore["enqueue"]>[0]) => {
    if (fail) {
      fail = false;
      throw new Error("queue unavailable");
    }
    return enqueue(input);
  });
  const input = { requestId: "recover-detached", task: "work" };
  assert.equal((await r.syscallsFor(r.room).open(input)).ok, false);
  const [child] = await r.sessions.childrenOf(r.room.id);
  assert.ok(child);
  await r.sessions.setParentSession(child.id, null);
  await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, text: "busy", origin: { kind: "direct" } },
  });
  const retry = await r.syscallsFor(r.room).open(input);
  assert.ok(retry.ok);
  assert.equal(retry.sessionId, child.id);
  assert.equal(retry.liveRunsRemaining, 0);
  assert.equal((await r.sessions.get(child.id))?.parentSessionId ?? null, null);
});

test("siblings and children send durable deduplicated messages; only an idle recipient wakes", async () => {
  const r = await rig();
  const parent = r.syscallsFor(r.room);
  const one = await parent.open({ task: "one", name: "one" });
  const two = await parent.open({ task: "two", name: "two" });
  assert.ok(one.ok && two.ok);
  const child = await freshSession(r.sessions, one.sessionId);
  const peer = await freshSession(r.sessions, two.sessionId);
  const sender = r.syscallsFor(child);
  const request = { target: "two", text: "shared finding", requestId: "message-one" };
  assert.equal((await sender.write(request)).ok, true);
  assert.equal((await sender.write(request)).ok, true);
  assert.equal((await r.runs.inFlightForThread(peer.threadRef)).length, 1);
  const receiver = r.syscallsFor(peer);
  const messages = await receiver.receive!();
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.text, /shared finding/);
  await receiver.acknowledge!([messages[0]!.id]);
  assert.deepEqual(await receiver.receive!(), []);
  const { run } = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, origin: { kind: "direct" }, text: "parent task" },
  });
  await completeTurn(r.ledger, run.id, { status: "ok", reply: "ready" });
  assert.equal((await sender.write({ target: "parent", text: "progress" })).ok, true);
  assert.equal((await sender.write({ target: "parent", text: "more progress" })).ok, true);
  assert.equal((await parent.receive!()).length, 2);
  const wakes = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(wakes.length, 1, "one wake for an idle recipient; later mail rides it");
  assert.equal(wakes[0]!.request.text, MAIL_WAKE_TEXT);
});

test("send_message wakes an idle recipient with the human authority of the work in either direction", async () => {
  const r = await delegatedHumanRig({ desktopClientId: "desktop-1" });
  await completeTurn(r.ledger, r.run.id, { status: "ok", reply: "child idle" });
  assert.equal((await r.api.write({ target: r.child.id, text: "one more thing" })).ok, true);
  const [down] = await r.runs.inFlightForThread(r.child.threadRef);
  assert.equal(down!.request.text, MAIL_WAKE_TEXT);
  assert.equal((await delegatedAuthorizationOrigin(down!.request, r))?.kind, "human");
  await completeTurn(r.ledger, r.parent.id, { status: "ok", reply: "parent idle" });
  const childApi = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.child,
    scopeId: scope,
    request: { ...down!.request, runId: down!.id },
  });
  await completeTurn(r.ledger, down!.id, { status: "ok" });
  assert.equal(await deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(down!.id))!), true);
  assert.equal((await r.mailbox.pending(r.room.id)).length, 0, "a wake that found nothing sends its parent nothing");
  assert.equal((await childApi.write({ target: "parent", text: "found it" })).ok, true);
  const [up] = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(up!.request.wakeCause, "child_done");
  assert.equal(up!.request.desktopClientId, undefined);
  assert.equal((await delegatedAuthorizationOrigin(up!.request, r))?.kind, "human");
});

test("a message to an idle session outside the parent-child edge wakes it privately and read-only", async () => {
  const r = await rig();
  const peer = await r.sessions.getOrCreateByThread("web:U1:peer", "dm", scope);
  await r.sessions.addParticipant(peer.id, actor.id);
  const { run } = await r.runs.enqueue({
    sessionId: peer.threadRef,
    request: {
      actor,
      conversation: { ...conversation, threadRef: peer.threadRef },
      origin: { kind: "human" },
      text: "hi",
    },
  });
  await completeTurn(r.ledger, run.id, { status: "ok", reply: "hello" });
  assert.equal((await r.syscallsFor(r.room).write({ target: peer.id, text: "fyi" })).ok, true);
  const [wake] = await r.runs.inFlightForThread(peer.threadRef);
  assert.equal(wake!.request.privateSessionMessage, true);
  assert.equal(wake!.request.readOnly, true);
  assert.equal(wake!.request.sessionMessageDepth, 1);
  assert.equal(await delegatedAuthorizationOrigin(wake!.request, r), undefined);
});

test("a finished grandchild wakes its subagent parent with the human authority that started the work", async () => {
  const r = await delegatedHumanRig();
  const coord = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.child,
    scopeId: scope,
    request: { ...r.run.request, runId: r.run.id },
  });
  const opened = await coord.open({ task: "dig deeper" });
  assert.ok(opened.ok);
  await completeTurn(r.ledger, r.run.id, { status: "ok", reply: "worker is in flight" });
  const worker = await freshSession(r.sessions, opened.sessionId);
  const job = (await r.runs.inFlightForThread(worker.threadRef))[0]!;
  await completeTurn(r.ledger, job.id, { status: "ok", reply: "worker finished" });
  assert.equal(await deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(job.id))!), false);
  const [wake] = await r.runs.inFlightForThread(r.child.threadRef);
  assert.equal(wake!.dedupKey, `subagent-return:${job.id}`);
  assert.equal((await delegatedAuthorizationOrigin(wake!.request, r))?.kind, "human");
  await completeTurn(r.ledger, wake!.id, { status: "ok", reply: "coord final: worker finished" });
  assert.equal(await deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(wake!.id))!), false);
  const rootWake = (await r.runs.inFlightForThread(r.room.threadRef)).find((run) => run.request.wakeCause);
  assert.equal(rootWake!.dedupKey, `subagent-return:${wake!.id}`);
  assert.equal((await delegatedAuthorizationOrigin(rootWake!.request, r))?.kind, "human");
});

test("follow-up retries recover the accepted run before checking full capacity", async (t) => {
  const r = await rig({ treeRunCap: 2 });
  const api = r.syscallsFor(r.room);
  const opened = await api.open({ task: "work" });
  assert.ok(opened.ok);
  const enqueue = r.runs.enqueue.bind(r.runs);
  let first = true;
  t.mock.method(r.runs, "enqueue", async (input: Parameters<RunStore["enqueue"]>[0]) => {
    const receipt = await enqueue({ ...input, request: JSON.parse(jsonbStringify(input.request)) });
    if (first) {
      first = false;
      throw new Error("lost receipt");
    }
    return receipt;
  });
  const request = { target: opened.sessionId, text: "more\u0000 work\ud800", followup: true, requestId: "stable" };
  assert.equal((await api.write(request)).ok, false);
  assert.equal((await api.write(request)).ok, true);
  assert.equal((await api.write({ ...request, text: "changed" })).ok, false);
  const child = await freshSession(r.sessions, opened.sessionId);
  assert.equal((await r.runs.inFlightForThread(child.threadRef)).length, 2);
});

test("mailbox survives recreation and rejects acknowledgements for another recipient", async () => {
  const url = testDatabaseUrl();
  const mail = createSessionMailbox(url);
  const message: SessionMessage = {
    id: "one",
    senderId: "sender",
    recipientId: "recipient",
    actor,
    audience: [actor],
    text: "data",
    createdAt: 1,
  };
  await mail.send(message);
  await mail.send({ ...message, text: "replacement" });
  const restarted = createSessionMailbox(url);
  await restarted.acknowledge("wrong", [message.id]);
  assert.equal((await restarted.pending("recipient"))[0]!.text, "data");
  await restarted.acknowledge("recipient", [message.id]);
  assert.deepEqual(await mail.pending("recipient"), []);
});

test("wait is cancelled and disabled actors cannot open or send", async () => {
  const r = await rig();
  let enabled = true;
  const factory = createSessionSyscalls({ ...r, maxAttempts: 3, enabled: async () => enabled });
  const abort = new AbortController();
  const api = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: { actor, conversation, cancel: abort.signal },
  });
  const waiting = api.receive!(60_000);
  abort.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  enabled = false;
  assert.equal((await api.open({ task: "forbidden" })).ok, false);
  assert.equal((await api.write({ target: "any", text: "forbidden" })).ok, false);
});

test("queued results recheck source-entry visibility after participant tenure changes", async () => {
  const r = await rig();
  const other: Principal = { id: "U2", type: "internal" };
  const sharedScope = scopeId("group", "G1");
  const shared = await r.sessions.getOrCreateByThread("group:G1:mail-tenure", "group", sharedScope);
  for (const id of [actor.id, other.id]) await r.sessions.addParticipant(shared.id, id);
  const sharedConversation: Conversation = { kind: "group", threadRef: shared.threadRef, audience: [actor, other] };
  const factory = createSessionSyscalls({ ...r, maxAttempts: 3 });
  const api = factory.forTurn({
    session: shared,
    scopeId: sharedScope,
    request: { actor, conversation: sharedConversation },
  });
  const opened = await api.open({ task: "shared result" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const { lease } = await r.sessions.acquireLease(child.id);
  const entry = await r.sessions.append(lease!, { kind: "AgentMessage", text: "OLD_PRIVATE_RESULT" });
  await r.sessions.releaseLease(lease!);
  const [run] = await r.runs.inFlightForThread(child.threadRef);
  await completeTurn(r.ledger, run!.id, {
    status: "ok",
    reply: "OLD_PRIVATE_RESULT",
    sourceAssistantEntrySeq: entry.seq,
  });
  await deliverSubagentMail(
    { sessions: r.sessions, runs: r.runs, mailbox: r.mailbox, maxAttempts: 3 },
    (await r.runs.get(run!.id))!,
  );
  assert.equal((await api.receive!()).length, 1);
  await r.sessions.removeParticipant(child.id, other.id);
  await r.sessions.addParticipant(child.id, other.id);
  assert.equal((await r.sessions.visibleItems(child.id, other.id)).length, 0);
  assert.deepEqual(await api.receive!(), []);
  assert.equal((await r.mailbox.pending(shared.id)).length, 1);
});

test("enabled coordinators and their children can delegate", async () => {
  const r = await rig();
  const factory = createSessionSyscalls({ ...r, maxAttempts: 3, enabled: async () => true });
  const api = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: { actor, conversation, surface: "slack" },
  });
  const opened = await api.open({ task: "Inspect the logs" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const childApi = factory.forTurn({
    session: child,
    scopeId: scope,
    request: { actor, conversation: { ...conversation, threadRef: child.threadRef }, surface: "slack" },
  });
  assert.ok((await childApi.open({ task: "Inspect an independent log" })).ok);
});

test("completion wakes preserve a spine trigger's delivery destination", async () => {
  const r = await rig();
  const destination = { type: "slack", target: "slack:C-trigger:100.1" };
  const parent = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    dedupKey: "trigger-parent",
    maxAttempts: 3,
    request: {
      actor,
      conversation,
      surface: "slack",
      surfaceTools: true,
      origin: { kind: "automation", destination },
      text: "inspect logs",
    },
  });
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { ...parent.run.request, runId: parent.run.id },
  });
  const opened = await api.open({ task: "inspect logs" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  await completeTurn(r.ledger, queued.id, { status: "ok", reply: "done" });
  for (const pending of await r.runs.inFlightForThread(r.room.threadRef)) {
    await completeTurn(r.ledger, pending.id, { status: "silent" });
  }
  await deliverSubagentMail(
    { ...r, maxAttempts: 3, delegationEnabled: async () => true },
    (await r.runs.get(queued.id))!,
  );
  const wake = (await r.runs.inFlightForThread(r.room.threadRef)).find((run) => run.id !== parent.run.id)!;
  assert.ok(wake);
  assert.equal(wake.request.surfaceTools, true);
  assert.equal(wake.request.deliveryTarget, undefined);
  assert.ok(wake.request.origin.kind === "automation");
  assert.deepEqual(wake.request.origin.destination, destination);
});

test("delegated automation retains explicit unattended grants and owner-keychain authority", async () => {
  const r = await rig();
  const factory = createSessionSyscalls({ ...r, maxAttempts: 3 });
  const api = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: {
      actor,
      conversation,
      surface: "slack",
      origin: { kind: "automation", useOwnerKeychain: true },
      unattendedGrants: ["admin.sessions.read"],
    },
  });
  const opened = await api.open({ task: "prepare the scheduled report" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.deepEqual(queued.request.unattendedGrants, ["admin.sessions.read"]);
  assert.ok(queued.request.origin.kind === "automation");
  assert.equal(queued.request.origin.useOwnerKeychain, true);
  await completeTurn(r.ledger, queued.id, { status: "ok", reply: "done" });
  assert.ok((await api.write({ target: child.id, text: "finish the report", followup: true })).ok);
  const followup = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.deepEqual(followup.request.unattendedGrants, ["admin.sessions.read"]);
  assert.ok(followup.request.origin.kind === "automation");
  assert.equal(followup.request.origin.useOwnerKeychain, true);
});

test("follow-up tasks cannot inherit a prior caller's automation authority", async () => {
  const r = await rig();
  const factory = createSessionSyscalls({ ...r, maxAttempts: 3 });
  const privileged = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: {
      actor,
      conversation,
      surface: "slack",
      origin: { kind: "automation", useOwnerKeychain: true },
      unattendedGrants: ["admin.sessions.read"],
    },
  });
  const opened = await privileged.open({ task: "scheduled report" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  await completeTurn(r.ledger, queued.id, { status: "ok", reply: "done" });
  assert.ok(
    (await r.syscallsFor(r.room).write({ target: child.id, text: "unprivileged follow-up", followup: true })).ok,
  );
  const next = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.equal(next.request.unattendedGrants, undefined);
  assert.ok(next.request.origin.kind === "automation");
  assert.equal(next.request.origin.useOwnerKeychain, undefined);
});

test("coordinator delegation requires an explicit actor rollout", () => {
  const request = { surface: "slack", conversation };
  assert.equal(requiresDelegation(request, false), false);
  assert.equal(requiresDelegation(request, true), true);
  assert.equal(requiresDelegation({ ...request, surface: "web" }, true), false);
  assert.equal(requiresDelegation({ ...request, surface: "web", surfaceTools: true }, true), true);
  assert.equal(
    requiresDelegation({ ...request, conversation: { ...conversation, threadRef: "agent:main:subagent:test" } }, true),
    false,
  );
});

async function webChildRig() {
  const r = await rig();
  const webConversation: Conversation = { kind: "dm", threadRef: "web:alex:1", audience: [actor] };
  const room = await r.sessions.getOrCreateByThread(webConversation.threadRef, "dm", scope, undefined, "web");
  await r.sessions.addParticipant(room.id, actor.id);
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: room,
    scopeId: scope,
    request: { surface: "web", conversation: webConversation, actor },
  });
  const opened = await api.open({ task: "inspect logs" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  await completeTurn(r.ledger, queued.id, { status: "ok", reply: "done" });
  const deliver = async () =>
    deliverSubagentMail({ ...r, maxAttempts: 3, delegationEnabled: async () => false }, (await r.runs.get(queued.id))!);
  return { ...r, room, api, deliver, wakeKey: `subagent-return:${queued.id}` };
}

test("a finished child wakes an idle web parent once without the responsive rollout", async () => {
  const r = await webChildRig();
  assert.equal(await r.deliver(), false);
  assert.equal(await r.deliver(), false);
  const wakes = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.dedupKey, r.wakeKey);
  assert.equal(wakes[0]!.request.surfaceTools, undefined);
  assert.equal(wakes[0]!.request.actor.id, actor.id);
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1);
});

test("a busy parent gets one queued wake, withdrawn once it collects the mail at its next tool boundary", async () => {
  const r = await webChildRig();
  const busy = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    dedupKey: "busy-parent",
    request: {
      actor,
      conversation: { kind: "dm", threadRef: r.room.threadRef, audience: [actor] },
      origin: { kind: "human" },
      text: "hi",
    },
  });
  assert.equal(await r.deliver(), false);
  assert.equal((await r.runs.getByDedupKey(r.wakeKey))?.status, "queued", "the wake waits behind the busy turn");
  const claimed = await claimTurn(r.ledger, busy.run.id);
  const mail = await r.api.receive!(0);
  await r.api.acknowledge!(mail.map((message) => message.id));
  await finishTurn(claimed!, { status: "ok", reply: "hello" });
  assert.equal(await r.deliver(), true);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), [], "the unneeded wake is withdrawn");
});

test("no wake once the parent already consumed the completion", async () => {
  const r = await webChildRig();
  assert.equal(await r.deliver(), false);
  await r.api.acknowledge!((await r.mailbox.pending(r.room.id)).map((message) => message.id));
  assert.equal(await r.deliver(), true);
  assert.equal((await r.runs.inFlightForThread(r.room.threadRef)).length, 0);
});

test("delegated human origin retains live authority boundaries", async () => {
  const r = await delegatedHumanRig();
  assert.equal(r.run.request.origin.kind, "human");
  assert.equal((await delegatedAuthorizationOrigin(r.run.request, r))?.kind, "human");
  for (const patch of [
    { actor: { ...actor, id: "other" } },
    { delegatingRunId: "missing" },
    { sessionSenderId: r.child.id },
    { privateSessionMessage: true as const },
    { readOnly: true },
    {
      conversation: { ...r.run.request.conversation, audience: [...conversation.audience, { ...actor, id: "other" }] },
    },
    { conversation: { ...r.run.request.conversation, kind: "channel" as const, channelRef: "other" } },
  ])
    assert.equal(await delegatedAuthorizationOrigin({ ...r.run.request, ...patch }, r), undefined);
  await r.sessions.setParentSession(r.child.id, null);
  assert.equal(await delegatedAuthorizationOrigin(r.run.request, r), undefined);
});

test("unrelated automated follow-ups cannot borrow earlier human authority", async () => {
  const r = await delegatedHumanRig();
  await completeTurn(r.ledger, r.run.id, { status: "ok", reply: "done" });
  const parent = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, surface: "slack", origin: { kind: "automation" }, text: "scheduled work" },
  });
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { ...parent.run.request, runId: parent.run.id },
  });
  assert.ok((await api.write({ target: r.child.id, text: "new scheduled task", followup: true })).ok);
  const next = (await r.runs.inFlightForThread(r.child.threadRef))[0]!;
  assert.equal(next.request.delegatingRunId, parent.run.id);
  assert.equal(await delegatedAuthorizationOrigin(next.request, r), undefined);
});

test("a later participant cannot change a completion's actor, rollout, destination, or grants", async () => {
  const r = await rig();
  const bob: Principal = { id: "U2", type: "internal" };
  const sharedScope = scopeId("channel", "C1");
  const room = await r.sessions.getOrCreateByThread("ch:C1:task", "channel", sharedScope, undefined, "slack");
  const sharedConversation: Conversation = {
    kind: "channel",
    channelRef: "C1",
    threadRef: room.threadRef,
    audience: [actor, bob],
    publishMembers: [actor, bob],
  };
  for (const person of [actor, bob]) await r.sessions.addParticipant(room.id, person.id);
  const parent = await r.runs.enqueue({
    sessionId: room.threadRef,
    request: {
      actor,
      conversation: sharedConversation,
      surface: "slack",
      surfaceTools: true,
      origin: { kind: "human" },
      deliveryTarget: "slack:C1:task",
      text: "inspect",
    },
  });
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: room,
    scopeId: sharedScope,
    request: { ...parent.run.request, runId: parent.run.id },
  });
  const opened = await api.open({ task: "inspect" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  await r.runs.enqueue({
    sessionId: room.threadRef,
    request: {
      actor: bob,
      conversation: sharedConversation,
      surface: "slack",
      surfaceTools: true,
      origin: { kind: "automation", useOwnerKeychain: true, destination: { type: "slack", target: "unrelated" } },
      unattendedGrants: ["admin.sessions.read"],
      text: "unrelated",
    },
  });
  await completeTurn(r.ledger, queued.id, { status: "ok", reply: "done" });
  for (const pending of await r.runs.inFlightForThread(room.threadRef)) {
    await completeTurn(r.ledger, pending.id, { status: "silent" });
  }
  await deliverSubagentMail(
    { ...r, maxAttempts: 3, delegationEnabled: async (id) => id === actor.id },
    (await r.runs.get(queued.id))!,
  );
  const wake = await r.runs.getByDedupKey(`subagent-return:${queued.id}`);
  assert.ok(wake);
  assert.equal(wake.request.actor.id, actor.id);
  assert.equal(wake.request.deliveryTarget, "slack:C1:task");
  assert.equal(wake.request.unattendedGrants, undefined);
  assert.deepEqual(wake.request.origin, { kind: "human" });
});

for (const surface of ["slack", "web"] as const) {
  test(`${surface} completion wakes preserve live authorization for subsequent delegated steps`, async () => {
    const r = await delegatedHumanRig({ surface });
    await completeTurn(r.ledger, r.run.id, { status: "ok", reply: "step one" });
    for (const pending of await r.runs.inFlightForThread(r.room.threadRef)) {
      await completeTurn(r.ledger, pending.id, { status: "silent" });
    }
    await deliverSubagentMail(
      { ...r, maxAttempts: 3, delegationEnabled: async () => true },
      (await r.runs.get(r.run.id))!,
    );
    const wake = (await r.runs.getByDedupKey(`subagent-return:${r.run.id}`))!;
    assert.ok(wake);
    assert.equal(wake.request.origin.kind, "human");
    assert.equal(wake.request.addressed, true);
    assert.equal((await delegatedAuthorizationOrigin(wake.request, r))?.kind, "human");
    const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
      session: r.room,
      scopeId: scope,
      request: { ...wake.request, runId: wake.id },
    });
    assert.ok((await api.write({ target: r.child.id, text: "step two", followup: true })).ok);
    const next = (await r.runs.inFlightForThread(r.child.threadRef))[0]!;
    assert.equal((await delegatedAuthorizationOrigin(next.request, r))?.kind, "human");
    await r.sessions.setParentSession(r.child.id, null);
    assert.equal(await delegatedAuthorizationOrigin(wake.request, r), undefined);
    assert.equal(await delegatedAuthorizationOrigin(next.request, r), undefined);
  });
}

test("a job-exit wake runs with the authority of the turn that started the job", async () => {
  const r = await delegatedHumanRig();
  const exitWake = (delegatingRunId: string, threadConversation: Conversation) => ({
    actor,
    conversation: threadConversation,
    surface: "monitor",
    origin: { kind: "automation" as const, screenData: "job output" },
    text: "job exited",
    delegatingRunId,
  });
  const childConversation = r.run.request.conversation;
  assert.equal((await delegatedAuthorizationOrigin(exitWake(r.parent.id, conversation), r))?.kind, "human");
  assert.equal((await delegatedAuthorizationOrigin(exitWake(r.run.id, childConversation), r))?.kind, "human");
  assert.equal(await delegatedAuthorizationOrigin(exitWake(r.parent.id, childConversation), r), undefined);
  const cron = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, surface: "cron", origin: { kind: "automation" }, text: "nightly" },
  });
  assert.equal(await delegatedAuthorizationOrigin(exitWake(cron.run.id, conversation), r), undefined);
});
