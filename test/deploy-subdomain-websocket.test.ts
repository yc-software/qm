import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { request as httpRequest, createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { createApp } from "../src/api/app.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import type { DeployEndpoint } from "../src/deploy/deploy-provider.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { scopeId } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl, testDeployBackings, testMap } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";

const SESSION_SECRET = "portal-session-secret";
const HOST = "live.apps.example.com";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const auditLog = {
  record() {},
  async recordOnce() {},
  events: async () => [],
  tail: async () => [],
};

function mintPortalSession(sub: string): string {
  const key = createHmac("sha256", SESSION_SECRET).update("portal.session.v1").digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ k: "session", sub, org: "acme", iat: now, exp: now + 3600 })).toString(
    "base64url",
  );
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

function frame(text: string, masked: boolean): Buffer {
  const payload = Buffer.from(text);
  const mask = masked ? randomBytes(4) : Buffer.alloc(0);
  const body = masked ? Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!)) : payload;
  return Buffer.concat([Buffer.from([0x81, (masked ? 0x80 : 0) | payload.length]), mask, body]);
}

function readFrames(socket: Duplex, onText: (text: string) => void): void {
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const len = buf[1]! & 0x7f;
      const masked = (buf[1]! & 0x80) !== 0;
      const start = 2 + (masked ? 4 : 0);
      if (buf.length < start + len) return;
      const mask = buf.subarray(2, 6);
      const raw = buf.subarray(start, start + len);
      onText(Buffer.from(masked ? raw.map((b, i) => b ^ mask[i % 4]!) : raw).toString());
      buf = buf.subarray(start + len);
    }
  });
}

function echo(socket: Duplex): void {
  socket.on("end", () => socket.end());
  readFrames(socket, (text) => socket.write(frame(`echo:${text}`, false)));
}

interface Upgraded {
  status: number;
  accept?: string;
  key: string;
  socket?: Duplex;
}

function openSocket(port: number, headers: Record<string, string>): Promise<Upgraded> {
  const key = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/ws?room=1",
      headers: {
        Host: HOST,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      const accept = res.headers["sec-websocket-accept"];
      resolve({ status: res.statusCode ?? 0, key, socket, ...(typeof accept === "string" ? { accept } : {}) });
    });
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, key });
    });
    req.on("error", reject);
    req.end();
  });
}

function roundTrip(socket: Duplex, text: string): Promise<string> {
  return new Promise((resolve) => {
    readFrames(socket, resolve);
    socket.write(frame(text, true));
  });
}

async function gateway(endpoint: DeployEndpoint) {
  const backings = testDeployBackings();
  const deployStore = createDeployStore(backings);
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    provider: { profile: { managedScaleToZero: false }, apply: async () => endpoint, destroy: async () => {} },
    auditLog,
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    deployDir: mkdtempSync(join(tmpdir(), "websocket-")),
  });
  const app = createApp({
    deploy,
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    directory: createPostgresDirectoryStore(testDatabaseUrl()),
    sessions: createPostgresSessionStore(backings.databaseUrl),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
  } as unknown as Parameters<typeof createApp>[0]);
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "live",
  });
  const server = createInsecureTestServer(app, {
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
    deployAppsSessionSecret: SESSION_SECRET,
    deployAppsLoginUrl: "https://portal.example.com",
    auditLog,
  });
  server.listen(0);
  return { server, port: (server.address() as AddressInfo).port };
}

function connections(server: {
  getConnections(cb: (error: Error | null, count: number) => void): unknown;
}): Promise<number> {
  return new Promise((resolve) => server.getConnections((_error, count) => resolve(count)));
}

function close(server: { close(cb: () => void): unknown }): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("app WebSocket: a signed-in owner's upgrade is proxied to the app and frames flow both ways", async () => {
  const seen: IncomingMessage[] = [];
  const upstream = createHttpServer((_req, res) => res.end("plain"));
  upstream.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    seen.push(req);
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + GUID)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`,
    );
    echo(socket);
  });
  upstream.listen(0);
  const { server, port } = await gateway({ host: "127.0.0.1", port: (upstream.address() as AddressInfo).port });
  try {
    const ws = await openSocket(port, {
      Cookie: `portal_session=${mintPortalSession("U1")}; theme=dark`,
      Origin: `https://${HOST}`,
      "Sec-WebSocket-Protocol": "vite-hmr",
    });
    assert.equal(ws.status, 101);
    assert.equal(
      ws.accept,
      createHash("sha1")
        .update(ws.key + GUID)
        .digest("base64"),
    );
    assert.equal(await roundTrip(ws.socket!, "hello"), "echo:hello");
    const req = seen[0]!;
    assert.equal(req.url, "/ws?room=1");
    assert.equal(req.headers["sec-websocket-protocol"], "vite-hmr");
    assert.equal(req.headers.cookie, "theme=dark", "the portal session cookie never reaches the app");
    ws.socket!.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await connections(upstream), 0, "closing the browser side tears down the app side");
  } finally {
    await close(server);
    await close(upstream);
  }
});

test("app WebSocket: anonymous, unshared and cross-origin upgrades are refused before reaching the app", async () => {
  let upgrades = 0;
  const upstream = createHttpServer();
  upstream.on("upgrade", (_req, socket: Duplex) => {
    upgrades++;
    socket.destroy();
  });
  upstream.listen(0);
  const { server, port } = await gateway({ host: "127.0.0.1", port: (upstream.address() as AddressInfo).port });
  try {
    assert.equal((await openSocket(port, {})).status, 401);
    assert.equal((await openSocket(port, { Cookie: `portal_session=${mintPortalSession("U9")}` })).status, 403);
    const crossSite = await openSocket(port, {
      Cookie: `portal_session=${mintPortalSession("U1")}`,
      Origin: "https://other.apps.example.com",
    });
    assert.equal(crossSite.status, 403, "another app on the same site cannot ride the viewer's session");
    assert.equal(upgrades, 0);
  } finally {
    await close(server);
    await close(upstream);
  }
});

test("app WebSocket: an endpoint served over HTTP/2 is still upgraded over HTTP/1.1", async () => {
  const upstream = createHttpServer();
  upstream.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + GUID)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    echo(socket);
  });
  upstream.listen(0);
  const { server, port } = await gateway({
    host: "127.0.0.1",
    port: (upstream.address() as AddressInfo).port,
    httpVersion: "2",
  });
  try {
    const ws = await openSocket(port, { Cookie: `portal_session=${mintPortalSession("U1")}` });
    assert.equal(ws.status, 101);
    assert.equal(await roundTrip(ws.socket!, "via h1"), "echo:via h1");
    ws.socket!.destroy();
  } finally {
    await close(server);
    await close(upstream);
  }
});
