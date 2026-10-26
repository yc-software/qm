import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import type { Dispatcher } from "undici";
import { createAgentEgress, AGENT_EGRESS_TOKEN_TTL_MS } from "../src/egress/agent-egress.ts";
import { EGRESS_PROXY_AUD, verifyCapabilityToken } from "../src/auth/capability-token.ts";
import { createBrokerFetch } from "../src/api/credential-broker.ts";
import { buildEgressAuthzServer } from "../src/egress-authz-main.ts";
import type { EgressAuditRecord } from "../src/admin/egress-audit-sink.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "test-agent-egress-secret";
const ctx = { actorId: "U_regan", scopeId: scopeId("personal", "U_regan") };

const listen = (s: Server): Promise<number> =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

function fakeDispatcher(): Dispatcher & { closed: boolean } {
  const d = { closed: false, close: async () => void (d.closed = true) };
  return d as unknown as Dispatcher & { closed: boolean };
}

test("agent egress mints a host-scoped egress token per principal, scope and host", async () => {
  const minted: Array<{ uri: string; token: string }> = [];
  const now = 1_000_000;
  const egress = createAgentEgress({
    proxyUrl: "https://egress.example.test:3128",
    capabilitySecret: SECRET,
    now: () => now,
    createDispatcher: (uri, token) => {
      minted.push({ uri, token });
      return fakeDispatcher();
    },
  });
  const a = await egress.dispatcher(ctx, "api.github.com");
  const again = await egress.dispatcher(ctx, "API.GITHUB.COM");
  assert.equal(again, a, "same principal/scope/host reuses the dispatcher");
  const other = await egress.dispatcher(ctx, "api.openai.com");
  assert.notEqual(other, a);
  const otherActor = await egress.dispatcher({ ...ctx, actorId: "U_other" }, "api.github.com");
  assert.notEqual(otherActor, a);
  assert.equal(minted.length, 3);
  assert.ok(minted.every((m) => m.uri === "https://egress.example.test:3128"));

  const claims = await verifyCapabilityToken(minted[0]!.token, SECRET, now);
  assert.ok(claims);
  assert.equal(claims.aud, EGRESS_PROXY_AUD);
  assert.equal(claims.actorId, ctx.actorId);
  assert.equal(claims.scopeId, ctx.scopeId);
  assert.deepEqual(claims.egress, { allowedHosts: ["api.github.com"], denyPrivateNetworks: true });
  assert.equal(claims.exp, now + AGENT_EGRESS_TOKEN_TTL_MS);
  assert.equal(await verifyCapabilityToken(minted[0]!.token, SECRET, now + AGENT_EGRESS_TOKEN_TTL_MS + 1), null);

  const env = await egress.proxyEnv(ctx, ["github.com", "api.github.com"], { PATH: "/bin" });
  assert.equal(env.PATH, "/bin");
  assert.match(env.HTTPS_PROXY!, /^https:\/\/x:[^@]+@egress\.example\.test:3128$/);
  assert.equal(env.GIT_HTTP_PROXY_AUTHMETHOD, "basic");
  const envClaims = await verifyCapabilityToken(new URL(env.HTTPS_PROXY!).password, SECRET, now);
  assert.deepEqual(envClaims?.egress?.allowedHosts, ["github.com", "api.github.com"]);

  await egress.close();
  assert.ok((a as unknown as { closed: boolean }).closed);
});

/** A minimal HTTP CONNECT proxy that checks the bearer token and records the tunnelled host. */
function connectProxy(onConnect: (host: string, token: string | undefined) => boolean) {
  const seen: Array<{ host: string; token?: string }> = [];
  const server = createHttpServer((_req, res) => {
    res.writeHead(405).end();
  });
  server.on("connect", (req, socket, head) => {
    const authority = req.url ?? "";
    const raw = req.headers["proxy-authorization"];
    const token = typeof raw === "string" && /^bearer /i.test(raw) ? raw.slice(7) : undefined;
    const host = authority.replace(/:\d+$/, "");
    seen.push({ host, ...(token ? { token } : {}) });
    if (!onConnect(host, token)) {
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const port = Number(authority.split(":").pop());
    const upstream = netConnect(port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return { server, seen };
}

test("agent egress tunnels requests through the proxy with the minted token", async () => {
  const origin = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, host: req.headers.host, auth: req.headers.authorization ?? null }));
  });
  const originPort = await listen(origin);
  const proxy = connectProxy(() => true);
  const proxyPort = await listen(proxy.server);
  const egress = createAgentEgress({ proxyUrl: `http://127.0.0.1:${proxyPort}`, capabilitySecret: SECRET });
  try {
    const res = await egress.fetch(
      `http://127.0.0.1:${originPort}/v1/thing?x=1`,
      { headers: { authorization: "Bearer upstream-secret" } },
      ctx,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { path: string; auth: string | null };
    assert.equal(body.path, "/v1/thing?x=1");
    assert.equal(body.auth, "Bearer upstream-secret");
    assert.equal(proxy.seen.length, 1);
    assert.equal(proxy.seen[0]!.host, "127.0.0.1");
    const claims = await verifyCapabilityToken(proxy.seen[0]!.token!, SECRET);
    assert.equal(claims?.actorId, ctx.actorId);
    assert.deepEqual(claims?.egress?.allowedHosts, ["127.0.0.1"]);

    // The bound fetch takes the same route.
    const bound = egress.fetchFor({ actorId: "U_other", scopeId: scopeId("org", "acme") });
    const res2 = await bound(`http://127.0.0.1:${originPort}/other`);
    assert.equal(res2.status, 200);
    assert.equal(proxy.seen.length, 2);
    assert.equal((await verifyCapabilityToken(proxy.seen[1]!.token!, SECRET))?.actorId, "U_other");
  } finally {
    await egress.close();
    await close(proxy.server);
    await close(origin);
  }
});

test("agent egress surfaces a proxy denial as a failed request, not a direct connection", async () => {
  const origin = createHttpServer((_req, res) => res.writeHead(200).end("reached"));
  const originPort = await listen(origin);
  let originHits = 0;
  origin.on("request", () => originHits++);
  const proxy = connectProxy(() => false);
  const proxyPort = await listen(proxy.server);
  const egress = createAgentEgress({ proxyUrl: `http://127.0.0.1:${proxyPort}`, capabilitySecret: SECRET });
  try {
    await assert.rejects(egress.fetch(`http://127.0.0.1:${originPort}/`, undefined, ctx));
    assert.equal(proxy.seen.length, 1);
    assert.equal(originHits, 0);
  } finally {
    await egress.close();
    await close(proxy.server);
    await close(origin);
  }
});

test("the real egress authorizer admits the minted token for its host and audits the principal", async () => {
  // The CONNECT proxy defers to the same authz server the Envoy data plane calls, so this covers the
  // token claims end to end: aud, host allowlist and audit attribution.
  const records: Omit<EgressAuditRecord, "ts">[] = [];
  const authz = buildEgressAuthzServer({
    capabilitySecret: SECRET,
    audit: { record: (r) => void records.push(r) },
    lookup: async (host) => (host === "origin.test" ? ["93.184.216.34"] : []),
  });
  const authzPort = await listen(authz);
  const ask = (authority: string, token: string | undefined): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: authzPort,
          path: "/",
          headers: {
            "x-egress-authority": authority,
            ...(token ? { "proxy-authorization": `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
  const origin = createHttpServer((_req, res) => res.writeHead(200).end("ok"));
  const originPort = await listen(origin);
  const decisions: number[] = [];
  const proxy = createHttpServer((_req, res) => res.writeHead(405).end());
  proxy.on("connect", (req, socket, head) => {
    const raw = req.headers["proxy-authorization"];
    const token = typeof raw === "string" ? raw.replace(/^bearer /i, "") : undefined;
    void ask(req.url ?? "", token).then((status) => {
      decisions.push(status);
      if (status !== 200) return void socket.end(`HTTP/1.1 ${status} Denied\r\ncontent-length: 0\r\n\r\n`);
      const upstream = netConnect(originPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
  });
  const proxyPort = await listen(proxy);
  const egress = createAgentEgress({ proxyUrl: `http://127.0.0.1:${proxyPort}`, capabilitySecret: SECRET });
  try {
    const res = await egress.fetch("http://origin.test:80/hello", undefined, ctx);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.deepEqual(decisions, [200]);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.host, "origin.test");
    assert.equal(records[0]!.allowed, true);
    assert.equal(records[0]!.principalId, ctx.actorId);
    assert.equal(records[0]!.scopeLabel, ctx.scopeId);

    // A token minted for one host does not open another.
    const originOnly = new URL((await egress.proxyEnv(ctx, ["origin.test"])).HTTPS_PROXY!).password;
    assert.equal(await ask("elsewhere.test:443", originOnly), 403);
    assert.equal(records.at(-1)!.allowed, false);
  } finally {
    await egress.close();
    await close(proxy);
    await close(origin);
    await close(authz);
  }
});

test("broker fetch goes through agent egress when given a caller, else directly", async () => {
  const calls: Array<{ url: string; ctx?: unknown }> = [];
  const egress = {
    fetch: async (url: string | URL, _init: RequestInit | undefined, c: unknown) => {
      calls.push({ url: String(url), ctx: c });
      return new Response("via-proxy", { status: 201, headers: { "content-type": "text/plain" } });
    },
  } as unknown as Parameters<typeof createBrokerFetch>[0];
  const brokerFetch = createBrokerFetch(egress);
  const r = await brokerFetch("https://api.example.test/x", { method: "GET", headers: {} }, ctx);
  assert.equal(r.status, 201);
  assert.equal(r.contentType, "text/plain");
  assert.equal(await r.text(), "via-proxy");
  assert.deepEqual(calls, [{ url: "https://api.example.test/x", ctx }]);

  // Without a caller the broker falls back to a direct request (exercised against a local origin).
  const origin = createHttpServer((_req, res) => res.writeHead(200).end("direct"));
  const port = await listen(origin);
  try {
    const direct = await brokerFetch(`http://127.0.0.1:${port}/`, { method: "GET", headers: {} });
    assert.equal(await direct.text(), "direct");
    assert.equal(calls.length, 1);
  } finally {
    await close(origin);
  }
});

test("a plain http request to the proxy (not CONNECT) is not how agent egress talks", async () => {
  // Guard against regressions where the dispatcher stops tunnelling: the proxy above answers 405
  // to plain requests, so a non-CONNECT path would surface as a 405 rather than the origin's body.
  const proxy = connectProxy(() => true);
  const proxyPort = await listen(proxy.server);
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: proxyPort, path: "http://example.test/" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 405);
  } finally {
    await close(proxy.server);
  }
});
