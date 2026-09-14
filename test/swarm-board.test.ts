import type { SwarmBoardPage } from "../src/swarms/swarm-board-view.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { App } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

const human = (f: Awaited<ReturnType<typeof swarmFixture>>) => ({
  kind: "human" as const,
  actorId: f.caller.claims.actorId,
  sessionId: f.root.id,
});

test("live board HTTP lists only selected private messages and exposes actual queued/running/completed state on inspection", async () => {
  const f = await swarmFixture();
  const [member] = await f.service.spawn(f.caller, { requestId: "board-worker", text: "Private assignment" });
  await f.service.sweep();
  const message = (await f.service.read(human(f), {}))[0]!;
  const secret = "board-local-fixture-signing-secret";
  const server = createServer(
    {
      swarms: f.service,
      getSessionForViewer: async (_id: string, actor: string) => (actor === "alice" ? {} : null),
    } as unknown as App,
    { signingSecret: secret, portalIdentitySecret: secret },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const path = `/v1/sessions/${f.root.id}/swarm?board=1&visibility=private&id=${message.id}&_sourceAuthNonce=board-test`;
    const portal = await mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, secret);
    const read = async () => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
        headers: signedRequestHeaders(secret, "GET", path, "", { "x-portal-identity": portal }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<SwarmBoardPage>;
    };
    const board = await read();
    assert.equal(board.messages[0]!.text, "Private assignment");
    assert.equal(board.deliveries![0]!.execution, "queued");
    assert.equal(board.members.find((m: { id: string }) => m.id === member!.id)!.parentId, f.root.id);
    const queued = (await f.runs.inFlightForThread(member!.threadRef))[0]!;
    const claim = (await f.runs.claimById(queued.id, "board", 60_000))!;
    assert.equal((await read()).deliveries![0]!.execution, "running");
    await f.runs.complete(claim.id, claim.leaseToken!, { status: "ok", reply: "Done" });
    assert.equal((await read()).deliveries![0]!.execution, "completed");
    assert.equal((await read()).deliveries![0]!.answered, false, "completion alone is not an answer");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test("public board preserves frozen versions and explicit reply evidence without exposing foreign runs, scopes or sessions", async () => {
  const alice = await swarmFixture();
  const bob = await swarmFixture({ actorId: "bob", store: alice.store, sessions: alice.sessions, runs: alice.runs });
  const sender = await alice.service.character(alice.caller, {
    version: 0,
    name: "Research",
    character: { task: "compiler" },
  });
  const recipient = await bob.service.character(bob.caller, {
    version: 0,
    name: "Review",
    character: { task: "compiler" },
  });
  const message = await alice.service.publish(alice.caller, {
    requestId: "public",
    text: "Public assignment",
    audience: [recipient.id],
  });
  await alice.service.sweep();
  const queued = (await alice.runs.getByDedupKey(`swarm:${message.id}:${recipient.id}`))!;
  await bob.service.character(bob.caller, {
    version: 1,
    name: "New review",
    character: { privateLooking: "explicit-public-only" },
  });
  const own = await bob.service.board(human(bob), { visibility: "org", id: message.id });
  assert.equal(own.deliveries![0]!.runId, queued.id);
  assert.equal(own.deliveries![0]!.execution, "queued");
  assert.equal(own.messages[0]!.audience[0]!.name, recipient.name);
  const foreign = await alice.service.board(human(alice), { visibility: "org", id: message.id });
  assert.equal(foreign.deliveries![0]!.execution, undefined);
  assert.equal(foreign.deliveries![0]!.sessionId, undefined);
  for (const secret of [bob.root.id, bob.root.threadRef, bob.root.scopeId, queued.id])
    assert.ok(!JSON.stringify(foreign).includes(secret));
  await bob.service.publish(bob.caller, {
    requestId: "reply",
    text: "Explicit answer",
    audience: [sender.id],
    replyTo: message.id,
    notify: false,
  });
  const replied = await alice.service.board(human(alice), { visibility: "org", id: message.id });
  assert.equal(replied.deliveries![0]!.answered, true);
  assert.equal(replied.replies![0]!.text, "Explicit answer");
  assert.equal(replied.messages[0]!.audience[0]!.version, 1);
  assert.equal(replied.replies![0]!.sender.version, 2);
  assert.equal((await alice.runs.get(queued.id))!.attempts, 0, "inspection never starts work");
});

test("board filters before visible paging and hides private messages from public permalink/search", async () => {
  const f = await swarmFixture();
  const other = await swarmFixture({ actorId: "bob", store: f.store, sessions: f.sessions, runs: f.runs });
  const peer = await other.service.character(other.caller, { version: 0, name: "Target", character: {} });
  const self = await f.service.character(f.caller, { version: 0, name: "Author", character: {} });
  const secret = await f.service.send(f.caller, { requestId: "secret", text: "Private-only-marker", audience: [] });
  for (let i = 0; i < 4; i++)
    await f.service.publish(f.caller, {
      requestId: `message-${i}`,
      text: `Public marker ${i}`,
      audience: [peer.id],
      notify: false,
    });
  const page = await f.service.board(human(f), {
    visibility: "org",
    sender: self.id,
    recipient: peer.id,
    search: "marker",
    limit: 2,
  });
  assert.equal(page.messages.length, 2);
  assert.ok(page.nextAfter);
  const next = await f.service.board(human(f), { visibility: "org", after: page.nextAfter, limit: 2 });
  assert.equal(next.messages.length, 2);
  assert.equal(next.nextAfter, undefined);
  assert.ok(next.messages.every((m) => !page.messages.some((other) => other.id === m.id)));
  assert.equal((await f.service.board(human(f), { visibility: "org", id: secret.id })).messages.length, 0);
  assert.equal(
    (await f.service.board(human(f), { visibility: "org", search: "Private-only-marker" })).messages.length,
    0,
  );
  await assert.rejects(f.service.board(f.caller, { visibility: "private" }), /human session/);
  await assert.rejects(
    f.service.board({ ...human(f), sessionId: other.root.id }, { visibility: "private" }),
    /access denied/,
  );
  for (const bad of [{ visibility: "all" }, { limit: 0 }, { limit: 33 }, { after: "bad" }, { sender: "" }])
    await assert.rejects(f.service.board(human(f), { visibility: "private", ...bad } as never), /invalid board/);
});

test("private board stays readable after stop, exposes controls only to managers, and omits deleted member links", async () => {
  const f = await swarmFixture();
  const [member] = await f.service.spawn(f.caller, { requestId: "member", text: "Work" });
  await f.service.sweep();
  await f.sessions.deleteSession(
    member!.sessionId ?? (await f.service.inspect(human(f))).peers.find((m) => m.id === member!.id)!.sessionId!,
  );
  await f.service.control(human(f), { memberId: f.root.id, command: "stop", subtree: true });
  const board = await f.service.board(human(f), { visibility: "private" });
  assert.equal(board.writable, false);
  assert.ok(board.messages.length);
  assert.equal(board.canManage, true);
  assert.equal(board.members.find((m) => m.id === member!.id)!.sessionId, undefined);
  assert.equal(board.members[0]!.descendants, 1);
  f.state.manageable = false;
  assert.equal((await f.service.board(human(f), { visibility: "private" })).canManage, false);
});

test("public board detail applies its requested limit to reply evidence", async () => {
  const f = await swarmFixture();
  await f.service.character(f.caller, { version: 0, name: "Author", character: {} });
  const parent = await f.service.publish(f.caller, {
    requestId: "bounded-parent",
    text: "Parent",
    audience: [],
    notify: false,
  });
  for (let i = 0; i < 3; i++)
    await f.service.publish(f.caller, {
      requestId: `bounded-reply-${i}`,
      text: `Reply ${i}`,
      audience: [],
      replyTo: parent.id,
      notify: false,
    });
  const page = await f.service.board(human(f), { visibility: "org", id: parent.id, limit: 1 });
  assert.equal(page.replies!.length, 1);
  assert.ok(page.repliesNextAfter);
  const next = await f.service.board(human(f), {
    visibility: "org",
    replyTo: parent.id,
    limit: 1,
    after: page.repliesNextAfter,
  });
  assert.equal(next.messages.length, 1);
  assert.notEqual(next.messages[0]!.id, page.replies![0]!.id);
});
