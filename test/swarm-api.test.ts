import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";
import { agentApiMatches } from "../src/api/agent-api-catalog.ts";

test("swarm HTTP rejects body identity selectors and completed capabilities while allowing arbitrary context keys", async () => {
  const fixture = await swarmFixture();
  if (fixture.caller.kind !== "agent") throw new Error("wrong caller");
  const capabilitySecret = "swarm-regression-capability-secret";
  const server = createServer(
    { swarms: fixture.service, authorizesCapabilityScope: async () => true } as unknown as App,
    {
      signingSecret: "swarm-regression-source-secret-distinct",
      capabilitySecret,
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/swarm`;
  const token = await mintCapabilityToken(fixture.caller.claims, capabilitySecret);
  const headers = { "x-agent-capability": token, "content-type": "application/json" };
  const post = (body: unknown) => fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    for (const field of [
      "memberId",
      "swarmId",
      "actorId",
      "sessionId",
      "threadRef",
      "scopeId",
      "runId",
      "senderId",
      "swarm",
      "origin",
      "claims",
      "sandboxId",
    ]) {
      for (const action of ["spawn", "send", "context"]) {
        const body =
          action === "context"
            ? { action, context: {} }
            : { action, requestId: "forged", text: "Work", ...(action === "send" ? { audience: ".[]" } : {}) };
        const response = await post({ ...body, [field]: "foreign" });
        assert.equal(response.status, 400, field);
      }
    }
    const context = {
      actorId: "metadata",
      memberId: "metadata",
      swarmId: "metadata",
      arbitrary: { runId: "metadata" },
    };
    assert.equal((await post({ action: "spawn", requestId: "valid", text: "Work", context })).status, 202);
    assert.deepEqual((await fixture.service.inspect(fixture.caller)).peers[1]!.context, context);
    const run = (await fixture.runs.get(fixture.caller.claims.runId!))!;
    assert.equal(await fixture.runs.complete(run.id, run.leaseToken!, { status: "ok", reply: "Done" }), true);
    for (const body of [
      { action: "spawn", requestId: "completed", text: "Work" },
      { action: "send", requestId: "completed", text: "Work", audience: ".[]" },
      { action: "context", context: {} },
    ])
      assert.equal((await post(body)).status, 400);
    assert.equal((await fetch(base, { headers })).status, 400);
    assert.equal((await fetch(`${base}?read=1`, { headers })).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("authenticated swarm API binds agent operations to the token and human operations to portal identity", async () => {
  const fixture = await swarmFixture();
  const secret = "source-auth-test-secret".repeat(3);
  const capabilitySecret = "capability-test-secret".repeat(3);
  const portalIdentitySecret = "portal-test-secret".repeat(3);
  const app = {
    swarms: fixture.service,
    authorizesCapabilityScope: async () => true,
    getSessionForViewer: async (id: string, actorId: string) => {
      const session = await fixture.sessions.getForParticipant(id, actorId);
      return session ? { session, entries: [] } : null;
    },
  } as unknown as App;
  const server = createServer(app, {
    signingSecret: secret,
    capabilitySecret,
    portalIdentitySecret,
    requireSignedPortalIdentity: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.ok(agentApiMatches("GET", "/v1/swarm"));
    assert.ok(agentApiMatches("POST", "/v1/swarm"));
    assert.ok(!agentApiMatches("POST", `/v1/sessions/${fixture.root.id}/swarm`));
    if (fixture.caller.kind !== "agent") throw new Error("wrong caller");
    const token = await mintCapabilityToken(fixture.caller.claims, capabilitySecret);
    const headers = { "x-agent-capability": token, "content-type": "application/json" };
    const spawn = {
      action: "spawn",
      requestId: "pool",
      count: 2,
      text: "Work",
      context: { role: "worker" },
    };
    const created = await fetch(`${base}/v1/swarm`, { method: "POST", headers, body: JSON.stringify(spawn) });
    assert.equal(created.status, 202, await created.text());
    await fixture.service.sweep();
    const view = await fetch(`${base}/v1/swarm`, { headers });
    assert.equal(view.status, 200);
    const data = (await view.json()) as { peers: unknown[] };
    assert.equal(data.peers.length, 3);
    const badAudience = await fetch(`${base}/v1/swarm`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "send", requestId: "bad", audience: "select(", text: "Bad" }),
    });
    assert.equal(badAudience.status, 400);
    const forgedToken = await mintCapabilityToken({ ...fixture.caller.claims, actorId: "bob" }, capabilitySecret);
    assert.equal((await fetch(`${base}/v1/swarm`, { headers: { "x-agent-capability": forgedToken } })).status, 400);
    const path = `/v1/sessions/${fixture.root.id}/swarm`;
    assert.equal((await fetch(`${base}${path}`, { headers })).status, 403);
    const portal = await mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, portalIdentitySecret);
    const body = JSON.stringify({
      action: "send",
      requestId: "human",
      audience: ".[]",
      text: "Review",
    });
    const human = await fetch(`${base}${path}`, {
      method: "POST",
      headers: signedRequestHeaders(secret, "POST", path, body, {
        "x-portal-identity": portal,
        "content-type": "application/json",
      }),
      body,
    });
    assert.equal(human.status, 202);
    const humanData = (await human.json()) as { message: { author: string; actorId: string } };
    assert.equal(humanData.message.author, "human");
    assert.equal(humanData.message.actorId, "alice");
    const unsigned = await fetch(`${base}${path}`, { headers: signedRequestHeaders(secret, "GET", path) });
    assert.equal(unsigned.status, 403);
    const bodyWithoutIdentity = JSON.stringify({ ...spawn, requestId: "forged-human" });
    assert.equal(
      (
        await fetch(`${base}/v1/swarm`, {
          method: "POST",
          headers: signedRequestHeaders(secret, "POST", "/v1/swarm", bodyWithoutIdentity, {
            "x-portal-identity": portal,
            "content-type": "application/json",
          }),
          body: bodyWithoutIdentity,
        })
      ).status,
      403,
    );
    assert.equal((await fetch(`${base}/v1/swarm?read=1&waitMs=10001`, { headers })).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
