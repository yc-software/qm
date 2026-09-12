import "./support/auto-fake-sprites.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, serverDeps, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";

const SECRET = "peer-routes-test-secret".repeat(3);
const ALICE = scopeId("personal", "U1");
const BOB = scopeId("personal", "U2");

describe("peer coordination HTTP surface", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;
  let aliceSession: string;
  let aliceThread: string;
  let bobSession: string;
  let bobThread: string;

  const token = (actorId: string, scope: ScopeId, threadRef?: string) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scope,
        exp: Date.now() + CAPABILITY_TTL_MS,
        ...(threadRef ? { threadRef } : {}),
      },
      TEST_CAPABILITY_SECRET,
    );

  const call = async (method: string, path: string, tok: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-agent-capability": tok },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const setFlag = (scope: ScopeId, on: boolean) =>
    built.featureFlags.setEnabled("peer_coordination", scope, on, "test");

  const advertisedCoordinationPaths = async (tok: string): Promise<string[]> => {
    const listing = (await (await call("GET", "/v1/apis", tok)).json()) as { endpoints: Array<{ path: string }> };
    return listing.endpoints
      .map((endpoint) => endpoint.path)
      .filter(
        (path) => path.startsWith("/v1/peers") || path.startsWith("/v1/peer-messages") || path.startsWith("/v1/swarms"),
      );
  };

  before(async () => {
    const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "peer-routes-")), signingSecret: SECRET });
    built = buildApp(config);
    const alice = await built.app.spawnSession("U1", { scopeId: ALICE, title: "alice worker" });
    const bob = await built.app.spawnSession("U2", { scopeId: BOB, title: "bob worker" });
    aliceSession = alice!.session.id;
    aliceThread = alice!.session.threadRef;
    bobSession = bob!.session.id;
    bobThread = bob!.session.threadRef;
    server = createServer(built.app, serverDeps(config, built));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("is entirely unreachable while the flag is off", async () => {
    const tok = await token("U1", ALICE, aliceThread);
    for (const [method, path, body] of [
      ["POST", "/v1/peers", { sessionId: aliceSession, agentName: "scout" }],
      ["GET", "/v1/peers", undefined],
      ["GET", `/v1/peers/${aliceSession}`, undefined],
      ["PUT", `/v1/peers/${aliceSession}/character`, { character: {}, ifVersion: 1 }],
      ["POST", "/v1/peer-messages", { text: "hi", recipients: [] }],
      ["GET", "/v1/peer-messages", undefined],
      ["POST", "/v1/peer-messages/audience-preview", { audience: ".[]" }],
      ["POST", "/v1/swarms", { rootSessionId: aliceSession, scopeId: ALICE }],
      ["POST", "/v1/swarms/nope/pool", { requestId: "r", parentSessionId: aliceSession, count: 0, briefs: [] }],
      ["POST", "/v1/swarms/nope/stop", { scope: "swarm" }],
    ] as const) {
      const res = await call(method, path, tok, body);
      assert.equal(res.status, 404, `${method} ${path} must 404 with the flag off`);
    }
    assert.equal(await built.coordination.listPeers().then((peers) => peers.length), 0);
    assert.deepEqual(await advertisedCoordinationPaths(tok), []);
  });

  it("serves the org-wide reads when the only enabled scope is the session's own", async () => {
    await setFlag(ALICE, true);
    const tok = await token("U1", ALICE, aliceThread);
    const registered = await call("POST", "/v1/peers", tok, { sessionId: aliceSession, agentName: "scout" });
    assert.equal(registered.status, 201);

    const published = await call("POST", "/v1/peer-messages", tok, { text: "hello board", recipients: [aliceSession] });
    assert.equal(published.status, 201);
    const messageId = ((await published.json()) as { message: { id: string } }).message.id;

    for (const path of ["/v1/peers", "/v1/peer-messages", `/v1/peer-messages/${messageId}/deliveries`]) {
      assert.equal((await call("GET", path, tok)).status, 200, `${path} must serve on an org-wide read`);
    }
    assert.ok((await advertisedCoordinationPaths(tok)).includes("/v1/peers"));

    await setFlag(ALICE, false);
    for (const path of ["/v1/peers", "/v1/peer-messages", `/v1/peer-messages/${messageId}/deliveries`]) {
      assert.equal((await call("GET", path, tok)).status, 404, `${path} must 404 once the only scope is off`);
    }
    await setFlag(ALICE, true);
  });

  it("gates a subject-scoped mutation on that subject's own scope", async () => {
    const bobToken = await token("U2", BOB, bobThread);
    assert.equal(
      (await call("POST", "/v1/peers", bobToken, { sessionId: bobSession, agentName: "bob-worker" })).status,
      404,
      "a session in a scope that is off stays unreachable",
    );
    await setFlag(BOB, true);
    assert.equal(
      (await call("POST", "/v1/peers", bobToken, { sessionId: bobSession, agentName: "bob-worker" })).status,
      201,
    );
  });

  it("narrows every mutation to the caller's own session", async () => {
    const bobToken = await token("U2", BOB, bobThread);
    const foreignRegister = await call("POST", "/v1/peers", bobToken, {
      sessionId: aliceSession,
      agentName: "impostor",
    });
    assert.equal(foreignRegister.status, 403);

    const foreignCharacter = await call("PUT", `/v1/peers/${aliceSession}/character`, bobToken, {
      character: { group: "new-feature", role: "worker" },
      ifVersion: 1,
    });
    assert.equal(foreignCharacter.status, 403);

    const foreignSwarm = await call("POST", "/v1/swarms", bobToken, {
      rootSessionId: aliceSession,
      scopeId: ALICE,
    });
    assert.equal(foreignSwarm.status, 403);

    const unbound = await token("U2", BOB);
    assert.equal(
      (await call("POST", "/v1/peers", unbound, { sessionId: bobSession, agentName: "x" })).status,
      403,
      "a token with no threadRef has no own session to match",
    );

    const alicePeer = await call("GET", `/v1/peers/${aliceSession}`, bobToken);
    assert.equal(alicePeer.status, 200, "discovery stays organization-wide by design");
    const view = (await alicePeer.json()) as { peer: Record<string, unknown> };
    assert.equal(view.peer.agentName, "scout");
    assert.equal(view.peer.characterVersion, 1, "a refused character write changed nothing");
  });
});
