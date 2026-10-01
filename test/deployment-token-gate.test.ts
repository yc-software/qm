import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import {
  CONTROL_PLANE_AUD,
  CREDENTIAL_BROKER_AUD,
  DEPLOYMENT_CREDENTIAL_TTL_MS,
  mintCapabilityToken,
} from "../src/auth/capability-token.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";
import { personalScope } from "../src/types.ts";

const SECRET = "deployment-token-gate-secret".repeat(2);

describe("a published app's broker token follows the app it was minted for, on every broker route", () => {
  let server: Server;
  let base: string;
  let deploymentsAllowed = true;
  let scopeAuthorized = true;
  let offboarded = false;
  const authorized: unknown[] = [];
  const deployments = new Map<string, Deployment>();
  const running = (id: string, createdBy = "publisher"): Deployment => ({
    id,
    createdBy,
    ownerScopeId: personalScope(createdBy),
    currentVersion: 1,
    status: "running",
    endpoint: null,
    versions: [],
  });

  const tokenFor = (deployment: string, actorId = "publisher", aud = CREDENTIAL_BROKER_AUD) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: personalScope(actorId),
        aud,
        credentials: ["sample-api"],
        deployment,
        exp: Date.now() + DEPLOYMENT_CREDENTIAL_TTL_MS,
      },
      SECRET,
    );

  const routes = {
    broker: (token: string) =>
      fetch(`${base}/v1/credentials/broker`, {
        method: "POST",
        headers: { "x-agent-capability": token, "content-type": "application/json" },
        body: JSON.stringify({ credential: "sample-api", url: "https://relay.example/sample-api/me" }),
      }),
    git: (token: string) =>
      fetch(`${base}/v1/credentials/git/sample-api/sample-api/repo.git/info/refs?service=git-upload-pack`, {
        headers: { "x-agent-capability": token },
      }),
  };
  const statuses = async (token: () => Promise<string>) => ({
    broker: (await routes.broker(await token())).status,
    git: (await routes.git(await token())).status,
  });

  before(async () => {
    const app = {
      authorizesCapabilityScope: async (claims: unknown) => {
        authorized.push(claims);
        return scopeAuthorized;
      },
      getDeployment: async (id: string) => deployments.get(id) ?? null,
    } as unknown as App;
    const deps = {
      identity: {
        refresh: async () => {},
        classify: () => ({ type: offboarded ? "offboarded" : "internal" }),
      },
      serviceCreds: {
        getServiceCredentialSecret: async () => ({
          slug: "sample-api",
          name: "Sample",
          secret: "s3cret",
          host: "relay.example",
          allowedMethods: ["GET", "POST"],
          allowedPathPrefixes: ["/sample-api"],
          enabled: true,
          deployments: deploymentsAllowed,
        }),
      },
      brokerFetch: async () => ({ status: 200, text: async () => "{}" }),
      gitHttpFetch: async () => ({ status: 200, headers: {}, body: Readable.from(["0000"]) }),
    } as unknown as Partial<ServerDeps>;
    server = createServer(app, { signingSecret: SECRET, ...deps });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reaches upstream while the app is running and the credential is on for apps", async () => {
    deployments.set("d1", running("d1"));
    assert.deepEqual(await statuses(() => tokenFor("d1")), { broker: 200, git: 200 });
  });

  it("is refused once the app is stopped, archived or gone, and for a token whose actor is not the publisher", async () => {
    const refused = { broker: 401, git: 401 };
    deployments.set("d1", { ...running("d1"), status: "stopped" });
    assert.deepEqual(await statuses(() => tokenFor("d1")), refused);
    deployments.set("d1", { ...running("d1"), status: "archived" });
    assert.deepEqual(await statuses(() => tokenFor("d1")), refused);
    deployments.delete("d1");
    assert.deepEqual(await statuses(() => tokenFor("d1")), refused);
    deployments.set("d2", running("d2", "someone-else"));
    assert.deepEqual(await statuses(() => tokenFor("d2", "publisher")), refused);
  });

  it("is refused when an admin switches the credential off for published apps", async () => {
    deployments.set("d1", running("d1"));
    deploymentsAllowed = false;
    try {
      assert.deepEqual(await statuses(() => tokenFor("d1")), { broker: 403, git: 403 });
    } finally {
      deploymentsAllowed = true;
    }
  });

  it("is refused without a token, with the wrong audience, and after scope membership is revoked", async () => {
    deployments.set("d1", running("d1"));
    assert.equal((await fetch(`${base}/v1/credentials/git/sample-api/sample-api/repo.git/info/refs`)).status, 401);
    assert.deepEqual(await statuses(() => tokenFor("d1", "publisher", CONTROL_PLANE_AUD)), { broker: 403, git: 403 });
    scopeAuthorized = false;
    try {
      assert.deepEqual(await statuses(() => tokenFor("d1")), { broker: 403, git: 403 });
    } finally {
      scopeAuthorized = true;
    }
  });

  it("is refused once the publisher is offboarded", async () => {
    deployments.set("d1", running("d1"));
    offboarded = true;
    try {
      assert.deepEqual(await statuses(() => tokenFor("d1")), { broker: 401, git: 401 });
    } finally {
      offboarded = false;
    }
  });

  it("checks scope membership with the token's bot and member claims on both routes", async () => {
    const token = () =>
      mintCapabilityToken(
        {
          actorId: "B1",
          scopeId: "channel:C1",
          aud: CREDENTIAL_BROKER_AUD,
          credentials: ["sample-api"],
          botActor: true,
          liveActor: true,
          members: [{ id: "B1", type: "internal" }],
          exp: Date.now() + DEPLOYMENT_CREDENTIAL_TTL_MS,
        },
        SECRET,
      );
    authorized.length = 0;
    assert.deepEqual(await statuses(token), { broker: 200, git: 200 });
    const expected = {
      actorId: "B1",
      scopeId: "channel:C1",
      botActor: true,
      liveActor: true,
      members: [{ id: "B1", type: "internal" }],
    };
    assert.deepEqual(authorized, [expected, expected]);
  });
});
