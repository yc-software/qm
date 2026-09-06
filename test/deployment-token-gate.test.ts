import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import {
  CREDENTIAL_BROKER_AUD,
  DEPLOYMENT_CREDENTIAL_TTL_MS,
  mintCapabilityToken,
} from "../src/auth/capability-token.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";
import { personalScope } from "../src/types.ts";

const SECRET = "deployment-token-gate-secret".repeat(2);

describe("a published app's broker token follows the app it was minted for", () => {
  let server: Server;
  let base: string;
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

  const tokenFor = (deployment: string, actorId = "publisher") =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: personalScope(actorId),
        aud: CREDENTIAL_BROKER_AUD,
        credentials: ["sample-api"],
        deployment,
        exp: Date.now() + DEPLOYMENT_CREDENTIAL_TTL_MS,
      },
      SECRET,
    );

  const broker = async (token: string) =>
    fetch(`${base}/v1/credentials/broker`, {
      method: "POST",
      headers: { "x-agent-capability": token, "content-type": "application/json" },
      body: JSON.stringify({ credential: "sample-api", url: "https://relay.example/sample-api/me" }),
    });

  before(async () => {
    const app = {
      authorizesCapabilityScope: async () => true,
      getDeployment: async (id: string) => deployments.get(id) ?? null,
    } as unknown as App;
    server = createServer(app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("passes the gate while the app is running and reaches the broker route", async () => {
    deployments.set("d1", running("d1"));
    const response = await broker(await tokenFor("d1"));
    assert.notEqual(response.status, 401);
    assert.notEqual(response.status, 403);
  });

  it("is refused once the app is stopped, archived or gone, and for a token whose actor is not the publisher", async () => {
    deployments.set("d1", { ...running("d1"), status: "stopped" });
    assert.equal((await broker(await tokenFor("d1"))).status, 401);
    deployments.set("d1", { ...running("d1"), status: "archived" });
    assert.equal((await broker(await tokenFor("d1"))).status, 401);
    deployments.delete("d1");
    assert.equal((await broker(await tokenFor("d1"))).status, 401);
    deployments.set("d2", running("d2", "someone-else"));
    assert.equal((await broker(await tokenFor("d2", "publisher"))).status, 401);
  });
});
