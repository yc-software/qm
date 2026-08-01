import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "agent-deployment-fetch-secret".repeat(2);

describe("agent deployment fetch", () => {
  let upstream: Server;
  let server: Server;
  let base: string;
  let upstreamPort: number;
  let downPort: number;

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
    upstream = createHttpServer((req, res) => {
      if (req.url === "/binary") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from([0, 255, 1, 254]));
        return;
      }
      if (req.url === "/large") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("abcdefghij");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>owner dashboard</h1>");
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;

    const closed = createHttpServer();
    await new Promise<void>((resolve) => closed.listen(0, resolve));
    downPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const app = {
      authorizesCapabilityScope: async () => true,
      reachDeployment: async (id: string, viewer: string) => {
        if (id !== "mine" && id !== "down") return { status: "not_found" as const };
        if (viewer !== "U1") return { status: "denied" as const };
        return {
          status: "ok" as const,
          endpoint: { host: "127.0.0.1", port: id === "down" ? downPort : upstreamPort },
        };
      },
    } as unknown as App;
    server = createServer(app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("requires an identified viewer", async () => {
    assert.equal((await get("/v1/deployments/mine/fetch")).status, 401);
  });

  it("fetches rendered text for the owner", async () => {
    const response = await get("/v1/deployments/mine/fetch", "U1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<h1>owner dashboard</h1>",
      truncated: false,
    });
  });

  it("hides an out-of-reach deployment", async () => {
    assert.equal((await get("/v1/deployments/mine/fetch", "U2")).status, 404);
  });

  it("truncates at the requested byte cap", async () => {
    const response = await get("/v1/deployments/mine/fetch?path=%2Flarge&maxBytes=4", "U1");
    assert.deepEqual(await response.json(), {
      status: 200,
      contentType: "text/plain",
      body: "abcd",
      truncated: true,
    });
  });

  it("maps an unavailable upstream to 502", async () => {
    const response = await get("/v1/deployments/down/fetch", "U1");
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "upstream_unreachable" });
  });

  it("encodes binary content as base64", async () => {
    const response = await get("/v1/deployments/mine/fetch?path=%2Fbinary", "U1");
    assert.deepEqual(await response.json(), {
      status: 200,
      contentType: "application/octet-stream",
      body: Buffer.from([0, 255, 1, 254]).toString("base64"),
      encoding: "base64",
      truncated: false,
    });
  });

  it("rejects encoded traversal variants", async () => {
    assert.equal((await get("/v1/deployments/mine/fetch?path=%2F%2525252e%2525252e%2525255csecret", "U1")).status, 400);
  });
});
