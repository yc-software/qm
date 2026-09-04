import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "deploy-logs-route-secret".repeat(2);

describe("deployment logs route", () => {
  let server: Server;
  let base: string;
  let lastTail: number | null = null;

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

  const get = async (path: string, actorId?: string) =>
    fetch(`${base}${path}`, {
      headers: actorId ? { "x-agent-capability": await capFor(actorId) } : {},
    });

  before(async () => {
    const app = {
      authorizesCapabilityScope: async () => true,
      deploymentLogsFor: async (id: string, viewer: string, opts: { tailLines: number }) => {
        lastTail = opts.tailLines;
        if (id === "missing") return { status: "not_found" as const };
        if (viewer !== "U1") return { status: "denied" as const };
        if (id === "silent") return { status: "ok" as const, logs: null };
        return { status: "ok" as const, logs: "line1\nline2\n" };
      },
    } as unknown as App;
    server = createServer(app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("requires an identified viewer", async () => {
    assert.equal((await get("/v1/deployments/mine/logs")).status, 401);
  });

  it("returns logs to a viewer who can reach the deployment", async () => {
    const response = await get("/v1/deployments/mine/logs", "U1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { logs: "line1\nline2\n" });
    assert.equal(lastTail, 200);
  });

  it("passes tailLines through and rejects out-of-range values", async () => {
    assert.equal((await get("/v1/deployments/mine/logs?tailLines=50", "U1")).status, 200);
    assert.equal(lastTail, 50);
    assert.equal((await get("/v1/deployments/mine/logs?tailLines=0", "U1")).status, 400);
    assert.equal((await get("/v1/deployments/mine/logs?tailLines=2001", "U1")).status, 400);
    assert.equal((await get("/v1/deployments/mine/logs?tailLines=abc", "U1")).status, 400);
  });

  it("hides denied and missing deployments as not_found", async () => {
    assert.equal((await get("/v1/deployments/mine/logs", "U2")).status, 404);
    assert.equal((await get("/v1/deployments/missing/logs", "U1")).status, 404);
  });

  it("says when the provider keeps no logs", async () => {
    const response = await get("/v1/deployments/silent/logs", "U1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { logs: null, message: "no logs available for this deployment" });
  });
});
