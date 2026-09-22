import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createDeploymentAccessRequests, type DeploymentAccessRequest } from "../src/deploy/access-requests.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { scopeId, type Destination } from "../src/types.ts";

const OWNER = "alice@example.com";
const VISITOR = "mallory@example.com";
const SESSION_SECRET = "portal-session-secret";
const SIGNING_SECRET = "deploy-access-route-secret".repeat(2);
const auditLog = { record() {}, events: async () => [], tail: async () => [] };

function postWithHost(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", port, path, method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

function portalSession(sub: string): string {
  const key = createHmac("sha256", SESSION_SECRET).update("portal.session.v1").digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ k: "session", sub, org: "acme", iat: now, exp: now + 3600 })).toString(
    "base64url",
  );
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

test("the gateway records the request and the owner decides it through the API on a live turn", async () => {
  const acl = createAclStore();
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "h", port: 1 }),
      destroy: async () => {},
    },
    auditLog,
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "access-route-")),
  });
  const deliveries: Array<{ destination: Destination; text: string }> = [];
  const identity = createIdentityService();
  const app = createApp({
    deploy,
    acl,
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
    identity,
    auditLog,
    deliveries: { enqueue: async (d: (typeof deliveries)[number]) => void deliveries.push(d) },
    onDeploymentShared: (event: Parameters<typeof requests.shared>[0]) => requests.shared(event),
  } as unknown as Parameters<typeof createApp>[0]);
  const requests = createDeploymentAccessRequests({
    requests: createMemoryMap<DeploymentAccessRequest>(),
    app,
    deliveries: {
      enqueue: async (d) => {
        deliveries.push(d);
      },
    },
    identity,
    appUrl: () => undefined,
  });
  const deployment = await app.deploy({
    ownerScopeId: scopeId("personal", OWNER),
    createdBy: OWNER,
    entrypoint: "x",
    files: [],
    name: "mysite",
  });

  const gateway = createInsecureTestServer(app, {
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
    deployAppsSessionSecret: SESSION_SECRET,
    deployAppsLoginUrl: "https://portal.example.com",
    deploymentAccessRequests: requests,
  });
  const api = createServer(app, { signingSecret: SIGNING_SECRET, deploymentAccessRequests: requests });
  gateway.listen(0);
  api.listen(0);
  const apiBase = `http://localhost:${(api.address() as AddressInfo).port}`;
  const cap = (actorId: string, liveActor?: boolean) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("personal", actorId),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
        ...(liveActor === undefined ? {} : { liveActor }),
      },
      SIGNING_SECRET,
    );
  const decide = async (id: string, decision: string, actorId: string, liveActor?: boolean) =>
    fetch(`${apiBase}/v1/deployment-access-requests/${encodeURIComponent(id)}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await cap(actorId, liveActor) },
      body: JSON.stringify({ decision }),
    });

  try {
    const asked = await postWithHost((gateway.address() as AddressInfo).port, "/__claw__/request-access", {
      Host: "mysite.apps.example.com",
      Cookie: `portal_session=${portalSession(VISITOR)}`,
    });
    assert.equal(asked, 200);
    assert.equal(deliveries.length, 1);
    const requestId = deliveries[0]!.destination.deploymentAccessRequestId as string;
    assert.ok(requestId, "the owner's notice carries the request id so surfaces can render Approve/Decline");
    assert.equal(deliveries[0]!.destination.target, OWNER);
    assert.match(deliveries[0]!.text, /Approve to share it with them/);

    const listed = await fetch(`${apiBase}/v1/deployment-access-requests`, {
      headers: { "x-agent-capability": await cap(OWNER) },
    });
    assert.deepEqual(
      ((await listed.json()) as { requests: Array<{ id: string }> }).requests.map((r) => r.id),
      [requestId],
    );
    const strangerList = await fetch(`${apiBase}/v1/deployment-access-requests`, {
      headers: { "x-agent-capability": await cap(VISITOR) },
    });
    assert.deepEqual((await strangerList.json()) as unknown, { requests: [] });

    assert.equal((await decide(requestId, "approve", OWNER)).status, 403, "a background turn cannot decide");
    assert.equal((await decide(requestId, "approve", VISITOR, true)).status, 403, "the requester cannot self-approve");
    assert.equal((await decide(requestId, "maybe", OWNER, true)).status, 400);
    assert.equal((await app.reachDeployment(deployment.id, VISITOR)).status, "denied");

    const approved = await decide(requestId, "approve", OWNER, true);
    assert.equal(approved.status, 200);
    assert.equal(((await approved.json()) as { request: { status: string } }).request.status, "approved");
    assert.equal((await app.reachDeployment(deployment.id, VISITOR)).status, "ok");
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1]!.destination.target, VISITOR);
    assert.match(deliveries[1]!.text, /gave you access to the app "mysite"/);
    assert.equal((await decide("nope", "approve", OWNER, true)).status, 403);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => gateway.close(() => resolve())),
      new Promise<void>((resolve) => api.close(() => resolve())),
    ]);
  }
});
