import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App, RedeployInput } from "../src/api/app.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "deploy-redeploy-route-secret".repeat(2);

describe("deployment redeploy route", () => {
  let server: Server;
  let base: string;
  let received: RedeployInput | undefined;

  const post = async (path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `POST\n${path}\n${raw}`),
      },
      body: raw,
    });
  };

  before(async () => {
    const deployment = {
      id: "dep-1",
      name: "envy",
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      currentVersion: 1,
      status: "running" as const,
      endpoint: null,
      versions: [{ version: 1, createdAt: 1, entrypoint: "x", snapshotDir: "/tmp" }],
    };
    const app = {
      listDeployments: async () => [deployment],
      canManageDeployment: async () => true,
      redeploy: async (_id: string, input: RedeployInput) => {
        received = input;
        return deployment;
      },
    } as unknown as App;
    server = createServer(app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("forwards env and home files to the deploy service", async () => {
    const body = {
      entrypoint: "node app.js",
      files: [{ path: "app.js", data: "listen" }],
      homeFiles: [{ path: ".npmrc", data: "token" }],
      env: { DB_URL: "postgres://one" },
    };
    const response = await post("/v1/deployments/envy/redeploy", body);
    assert.equal(response.status, 200);
    assert.deepEqual(received, body);
  });

  it("still requires an entrypoint and files", async () => {
    assert.equal((await post("/v1/deployments/envy/redeploy", { env: { A: "1" } })).status, 400);
  });
});
