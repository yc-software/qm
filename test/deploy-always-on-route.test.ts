import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "deploy-always-on-route-secret".repeat(2);

describe("deployment always-on route", () => {
  let server: Server;
  let base: string;
  let flag: boolean | undefined;

  const capFor = (actorId: string) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("personal", actorId),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );

  const post = async (path: string, body: unknown, actorId: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await capFor(actorId) },
      body: JSON.stringify(body),
    });

  before(async () => {
    const deployment = {
      id: "dep-1",
      name: "warm-app",
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      currentVersion: 1,
      status: "running" as const,
      endpoint: null,
      versions: [{ version: 1, createdAt: 1, entrypoint: "x", snapshotDir: "/tmp" }],
    };
    const app = {
      authorizesCapabilityScope: async () => true,
      listDeployments: async () => [deployment],
      canManageDeployment: async (_id: string, principalId: string) => principalId === "U1",
      setDeploymentAlwaysOn: async (_id: string, alwaysOn: boolean) => {
        flag = alwaysOn;
        return { ...deployment, ...(alwaysOn ? { alwaysOn: true } : {}) };
      },
    } as unknown as App;
    server = createServer(app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("lets a manager turn always-on on, by name", async () => {
    const response = await post("/v1/deployments/warm-app/always-on", { alwaysOn: true }, "U1");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { deployment: { alwaysOn?: boolean } };
    assert.equal(body.deployment.alwaysOn, true);
    assert.equal(flag, true);
  });

  it("rejects a caller who does not manage the app", async () => {
    assert.equal((await post("/v1/deployments/warm-app/always-on", { alwaysOn: true }, "U2")).status, 403);
  });

  it("requires a boolean alwaysOn", async () => {
    assert.equal((await post("/v1/deployments/warm-app/always-on", { alwaysOn: "yes" }, "U1")).status, 400);
  });

  it("404s an unknown deployment", async () => {
    assert.equal((await post("/v1/deployments/nope/always-on", { alwaysOn: true }, "U1")).status, 404);
  });
});
