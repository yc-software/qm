import { principalOf } from "./support/principal.ts";
import { handle } from "../src/identity/principals.ts";
import "./support/auto-fake-sprites.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId, type TurnRequest, type SessionStatus } from "../src/types.ts";
import { startSession } from "../src/api/start-session.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "agent-conversations-secret".repeat(2);

function dm(externalId: string, text: string, thread: string): TurnRequest {
  return { surface: "test", actor: { externalId }, conversation: { kind: "dm", threadRef: thread }, text };
}

describe("agent conversations self-API", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;
  let mineId: string;
  let theirsId: string;

  const P = { U1: "", U2: "", U3: "", U4: "" };
  const capFor = async (handle: string, scope?: string, live = true) => {
    const actorId = await principalOf(built, handle);
    return mintCapabilityToken(
      {
        actorId,
        scopeId: scope ?? scopeId("personal", actorId),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
        liveActor: live,
      },
      SECRET,
    );
  };

  const get = async (path: string, token?: string) =>
    fetch(`${base}${path}`, { headers: token ? { "x-agent-capability": token } : {} });
  const post = async (path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-agent-capability": token } : {}) },
      body: JSON.stringify(body),
    });

  before(async () => {
    built = buildApp(testConfig({ signingSecret: SECRET }));
    server = createServer(built.app, {
      signingSecret: SECRET,
      portalUrl: "https://portal.example/",
      sessions: built.sessions,
      memory: built.memory,
      config: built.config,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    for (const h of ["U1", "U2", "U3", "U4"] as const) P[h] = await built.principals.act(handle("slack", h));
    mineId = (await built.app.turn(dm("U1", "plan the launch", "web:U1:c1"))).sessionId!;
    theirsId = (await built.app.turn(dm("U2", "someone else's chat", "web:U2:c1"))).sessionId!;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sets, replaces, lists and clears a shared session status", async () => {
    const token = await capFor("U1");
    await built.sessions.addParticipant(mineId, P.U3);
    for (const status of [{ emoji: "✅", text: "PR merged" }, { emoji: "🚀", text: "Live in production" }, null]) {
      const res = await post(`/v1/conversations/${mineId}`, { status }, token);
      assert.equal(res.status, 200);
      assert.deepEqual(
        ((await res.json()) as { conversation: { status: SessionStatus | null } }).conversation.status,
        status,
      );
      assert.deepEqual((await built.app.getSessionForViewer(mineId, P.U3))?.session.status ?? null, status);
      const list = await get("/v1/conversations", token);
      assert.deepEqual(
        (
          (await list.json()) as { conversations: Array<{ id: string; status: SessionStatus | null }> }
        ).conversations.find((s) => s.id === mineId)?.status ?? null,
        status,
      );
    }
  });

  it("rejects malformed status and unauthorized status updates", async () => {
    const token = await capFor("U1");
    for (const status of [
      {},
      { emoji: "abc", text: "Merged" },
      { emoji: "✅🚀", text: "Merged" },
      { emoji: "✅", text: " " },
      { emoji: "✅", text: "x".repeat(201) },
      { emoji: "✅", text: "a\u0000b" },
      "merged",
    ]) {
      assert.equal((await post(`/v1/conversations/${mineId}`, { status }, token)).status, 400);
    }
    assert.equal(
      (await post(`/v1/conversations/${theirsId}`, { status: { emoji: "✅", text: "Merged" } }, token)).status,
      404,
    );
    assert.equal((await post(`/v1/conversations/${mineId}`, { status: null })).status, 401);
  });

  it("refuses conversation status from Slack turns while other updates still apply", async () => {
    const slack = await mintCapabilityToken(
      {
        actorId: P.U1,
        scopeId: scopeId("personal", P.U1),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
        liveActor: true,
        surface: "slack",
      },
      SECRET,
    );
    const before = (await built.app.getSessionForViewer(mineId, P.U1))?.session.status ?? null;
    const refused = await post(`/v1/conversations/${mineId}`, { status: { emoji: "👍", text: "Cleared" } }, slack);
    assert.equal(refused.status, 403);
    assert.deepEqual((await built.app.getSessionForViewer(mineId, P.U1))?.session.status ?? null, before);
    const renamed = await post(`/v1/conversations/${mineId}`, { title: "Launch plan" }, slack);
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { conversation: { title: string } }).conversation.title, "Launch plan");
  });

  it("new sessions start clean with only the seed text", async () => {
    const out = await startSession(built.app, built.sessions, P.U1, {
      scopeId: scopeId("personal", P.U1),
      text: "investigate the flaky test",
      title: "Flaky test hunt",
    });
    assert.ok("session" in out);
    assert.notEqual(out.session.id, mineId);
    assert.equal(out.session.title, "Flaky test hunt");
    const [run] = await built.runs.inFlightForThread(out.session.threadRef);
    assert.equal(run?.request.text, "investigate the flaky test");
    assert.equal(run?.request.surface, "web");
    const entries = await built.sessions.getEntries(out.session.id);
    assert.ok(!entries.some((e) => JSON.stringify(e.payload).includes("plan the launch")));
    const listed = await built.app.listSessions(P.U1);
    assert.ok(listed.some((s) => s.id === out.session.id));
  });

  it("new sessions in a channel seed their turn on that channel", async () => {
    await built.app.upsertDirectory([{ principalId: P.U1, displayName: "User One", type: "internal" }]);
    await built.app.upsertChannels(
      [{ channelId: "C1", name: "engineering", isPrivate: true }],
      [{ channelId: "C1", principalId: P.U1 }],
    );
    const out = await startSession(built.app, built.sessions, P.U1, {
      scopeId: scopeId("channel", "C1"),
      text: "investigate the channel deployment",
    });
    assert.ok("session" in out);
    assert.equal(out.session.scopeId, scopeId("channel", "C1"));
    const [run] = await built.runs.inFlightForThread(out.session.threadRef);
    assert.equal(run?.request.conversation.channelRef, "C1");
  });

  it("a refused seed discards a new session but reports a fork it left", async () => {
    const raced: typeof built.app = {
      ...built.app,
      turn: async (req) =>
        (req as { spawned?: boolean }).spawned
          ? { status: "refused", reason: "project membership changed" }
          : built.app.turn(req),
    };
    const ids = async () => (await built.app.listSessions(P.U1)).map((s) => s.id).sort();
    const before = await ids();
    assert.deepEqual(
      await startSession(raced, built.sessions, P.U1, { scopeId: scopeId("personal", P.U1), text: "refused" }),
      { error: "project membership changed" },
    );
    assert.deepEqual(await ids(), before);
    const forked = await startSession(raced, built.sessions, P.U1, {
      scopeId: scopeId("personal", P.U1),
      forkOf: mineId,
      text: "refused",
    });
    assert.ok("session" in forked);
    assert.equal(forked.refused, "project membership changed");
  });

  it("refuses a scope or fork source the actor can't use", async () => {
    assert.ok(
      "error" in
        (await startSession(built.app, built.sessions, P.U1, { scopeId: scopeId("personal", P.U2), text: "peek" })),
    );
    assert.ok(
      "error" in
        (await startSession(built.app, built.sessions, P.U1, { scopeId: scopeId("personal", P.U1), forkOf: theirsId })),
    );
  });

  it("requires a capability token", async () => {
    assert.equal((await get("/v1/conversations")).status, 401);
    assert.equal((await get(`/v1/conversations/${mineId}`)).status, 401);
    assert.equal((await post(`/v1/conversations/${mineId}`, { archived: true })).status, 401);
  });

  it("lists only the actor's own conversations", async () => {
    const res = await get("/v1/conversations", await capFor("U1"));
    assert.equal(res.status, 200);
    const { conversations } = (await res.json()) as { conversations: Array<{ id: string; archived: boolean }> };
    assert.ok(conversations.some((c) => c.id === mineId));
    assert.ok(!conversations.some((c) => c.id === theirsId), "another person's conversation never appears");
  });

  it("archives and unarchives one of the actor's own conversations", async () => {
    const token = await capFor("U1");
    const res = await post(`/v1/conversations/${mineId}`, { archived: true }, token);
    assert.equal(res.status, 200);
    const { conversation } = (await res.json()) as { conversation: { archived: boolean } };
    assert.equal(conversation.archived, true);

    const back = await post(`/v1/conversations/${mineId}`, { archived: false }, token);
    assert.equal(back.status, 200);
    assert.equal(((await back.json()) as { conversation: { archived: boolean } }).conversation.archived, false);
  });

  it("archiving is per-participant view state, not visible to the other viewer's list semantics", async () => {
    const token = await capFor("U1");
    await post(`/v1/conversations/${mineId}`, { archived: true }, token);
    const other = await built.app.listSessions(P.U2);
    assert.ok(!other.some((s) => s.id === mineId && s.archived), "U1's archive never marks U2's view");
    await post(`/v1/conversations/${mineId}`, { archived: false }, token);
  });

  it("refuses a conversation the actor can't see (404, no existence leak)", async () => {
    const token = await capFor("U1");
    assert.equal((await get(`/v1/conversations/${theirsId}`, token)).status, 404);
    assert.equal((await post(`/v1/conversations/${theirsId}`, { archived: true }, token)).status, 404);
  });

  it("reads and tail-pages one of the actor's own conversations", async () => {
    for (let turn = 2; turn <= 21; turn++) {
      await built.app.turn(dm("U1", `launch question ${turn}`, "web:U1:c1"));
    }
    const token = await capFor("U1");
    const bounded = await get(`/v1/conversations/${mineId}`, token);
    assert.equal(bounded.status, 200);
    const boundedBody = (await bounded.json()) as {
      entries: Array<{ type: string; payload: { text?: string } }>;
      earlierEntries?: number;
    };
    assert.ok(!boundedBody.entries.some((entry) => entry.payload.text === "plan the launch"));
    assert.ok(boundedBody.entries.some((entry) => entry.payload.text === "launch question 21"));
    assert.ok((boundedBody.earlierEntries ?? 0) > 0);

    const tail = await get(`/v1/conversations/${mineId}?tailTurns=1`, token);
    assert.equal(tail.status, 200);
    const tailBody = (await tail.json()) as {
      entries: Array<{ type: string; payload: { text?: string } }>;
      earlierEntries?: number;
    };
    assert.ok(tailBody.entries.some((entry) => entry.payload.text === "launch question 21"));
    assert.ok(!tailBody.entries.some((entry) => entry.payload.text === "launch question 20"));
    assert.ok((tailBody.earlierEntries ?? 0) > 0);
    assert.equal((await get(`/v1/conversations/${mineId}?sinceSeq=0`, token)).status, 400);
  });

  it("forks carry the source transcript into a new sidebar session", async () => {
    const out = await startSession(built.app, built.sessions, P.U1, {
      scopeId: scopeId("personal", P.U1),
      forkOf: mineId,
    });
    assert.ok("session" in out);
    assert.notEqual(out.session.id, mineId);
    const entries = await built.sessions.getEntries(out.session.id);
    assert.ok(entries.some((e) => JSON.stringify(e.payload).includes("plan the launch")));
    assert.ok((await built.app.listSessions(P.U1)).some((s) => s.id === out.session.id));
  });

  it("refuses to color a conversation the actor can't see", async () => {
    const res = await post(`/v1/conversations/${theirsId}`, { color: "#123456" }, await capFor("U1"));
    assert.equal(res.status, 404);
  });

  it("validates the patch body", async () => {
    const token = await capFor("U1");
    assert.equal((await post(`/v1/conversations/${mineId}`, {}, token)).status, 400);
    assert.equal((await post(`/v1/conversations/${mineId}`, { archived: "yes" }, token)).status, 400);
    assert.equal((await post(`/v1/conversations/${mineId}`, { title: 5 }, token)).status, 400);
    assert.equal((await post(`/v1/conversations/${mineId}`, { color: "red" }, token)).status, 400);
  });

  it("sets and clears the sidebar color", async () => {
    const token = await capFor("U1");
    const set = await post(`/v1/conversations/${mineId}`, { color: "#A1B2C3" }, token);
    assert.equal(set.status, 200);
    assert.equal(((await set.json()) as { conversation: { color: string | null } }).conversation.color, "#a1b2c3");

    const clear = await post(`/v1/conversations/${mineId}`, { color: null }, token);
    assert.equal(clear.status, 200);
    assert.equal(((await clear.json()) as { conversation: { color: string | null } }).conversation.color, null);
  });

  it("renames and pins through the same patch", async () => {
    const token = await capFor("U1");
    const res = await post(`/v1/conversations/${mineId}`, { title: "Launch plan", pinned: true }, token);
    assert.equal(res.status, 200);
    const { conversation } = (await res.json()) as { conversation: { title: string | null; pinned: boolean } };
    assert.equal(conversation.title, "Launch plan");
    assert.equal(conversation.pinned, true);
  });
});
