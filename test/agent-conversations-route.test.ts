import "./support/auto-fake-sprites.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
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

  const capFor = (actorId: string, scope = scopeId("personal", actorId)) =>
    mintCapabilityToken(
      { actorId, scopeId: scope, aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );

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
    server = createServer(built.app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    mineId = (await built.app.turn(dm("U1", "plan the launch", "web:U1:c1"))).sessionId!;
    theirsId = (await built.app.turn(dm("U2", "someone else's chat", "web:U2:c1"))).sessionId!;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("requires a capability token", async () => {
    assert.equal((await get("/v1/conversations")).status, 401);
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
    const other = await built.app.listSessions("U2");
    assert.ok(!other.some((s) => s.id === mineId && s.archived), "U1's archive never marks U2's view");
    await post(`/v1/conversations/${mineId}`, { archived: false }, token);
  });

  it("refuses a conversation the actor can't see (404, no existence leak)", async () => {
    const res = await post(`/v1/conversations/${theirsId}`, { archived: true }, await capFor("U1"));
    assert.equal(res.status, 404);
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
