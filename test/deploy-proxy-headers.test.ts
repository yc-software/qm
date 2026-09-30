import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestOptions,
  type Server as HttpServer,
} from "node:http";
import {
  constants as http2Constants,
  createServer as createHttp2Server,
  type Http2Server,
  type Http2ServerResponse,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { createAdminService } from "../src/admin/admin-service.ts";
import { signRequest } from "../src/auth/source-auth.ts";

function appWith(endpoint: Record<string, unknown>): App {
  return { reachDeployment: async () => ({ status: "ok", endpoint }) } as unknown as App;
}

const listen = (server: HttpServer | Http2Server): number => {
  server.listen(0);
  return (server.address() as AddressInfo).port;
};
const close = (server: HttpServer | Http2Server) => new Promise<void>((r) => server.close(() => r()));

async function withProxy(
  upstream: HttpServer | Http2Server,
  endpoint: Record<string, unknown> | ((upstreamPort: number) => App),
  run: (ctx: { base: string; port: number }) => Promise<void>,
  options: Parameters<typeof createServer>[1] = {},
): Promise<void> {
  const sessions = new Set<ServerHttp2Session>();
  upstream.on("session", (session: ServerHttp2Session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  const upstreamPort = listen(upstream);
  const app =
    typeof endpoint === "function"
      ? endpoint(upstreamPort)
      : appWith({ host: "127.0.0.1", port: upstreamPort, ...endpoint });
  const server = createInsecureTestServer(app, options);
  const port = listen(server);
  try {
    await run({ base: `http://localhost:${port}`, port });
  } finally {
    await close(server);
    for (const session of sessions) session.destroy();
    (upstream as { closeAllConnections?: () => void }).closeAllConnections?.();
    await close(upstream);
  }
}

function recorder(reply = "ok") {
  const seen: { headers: IncomingHttpHeaders; body?: string } = { headers: {} };
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      seen.headers = req.headers;
      seen.body = Buffer.concat(chunks).toString("utf8");
      res.end(reply);
    });
  });
  return { server, seen };
}

function rawRequest(port: number, options: RequestOptions, chunks: string[] = []) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string; aborted: boolean }>(
    (resolve, reject) => {
      const rq = httpRequest({ host: "localhost", port, ...options }, (rs) => {
        const body: Buffer[] = [];
        const done = (aborted: boolean) =>
          resolve({ status: rs.statusCode ?? 0, headers: rs.headers, body: Buffer.concat(body).toString(), aborted });
        rs.on("data", (chunk) => body.push(chunk as Buffer));
        rs.on("aborted", () => done(true));
        rs.on("end", () => done(false));
      });
      rq.on("error", reject);
      for (const chunk of chunks) rq.write(chunk);
      rq.end();
    },
  );
}

function sseReady(res: Http2ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write("data: ready\n\n");
}

async function openEvents(base: string, signal?: AbortSignal) {
  const events = await fetch(`${base}/d/some-id/events`, signal ? { signal } : {});
  const reader = events.body!.getReader();
  assert.match(Buffer.from((await reader.read()).value!).toString(), /data: ready/);
  return reader;
}

function refuse(stream: ServerHttp2Stream): void {
  stream.session!.goaway(http2Constants.NGHTTP2_NO_ERROR, stream.id! - 2);
  stream.close(http2Constants.NGHTTP2_REFUSED_STREAM);
}

test("/d/ proxy attaches the endpoint's proxyHeaders — the internal path authenticates to a token-gated deployment", async () => {
  const { server, seen } = recorder("upstream-ok");
  await withProxy(server, { proxyHeaders: { cookie: "dpl_access=tok" } }, async ({ base }) => {
    const res = await fetch(`${base}/d/some-id/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "upstream-ok");
    assert.equal(seen.headers.cookie, "dpl_access=tok");
  });
});

test("/d/ proxy multiplexes concurrent requests over one HTTP/2 session", async () => {
  let sessionCount = 0;
  const seenAuth = new Set<string>();
  const upstream = createHttp2Server((req, res) => {
    seenAuth.add(String(req.headers["x-aws-proxy-auth"] ?? ""));
    if (req.url === "/events") return sseReady(res);
    setTimeout(() => res.end(req.url), 30);
  });
  upstream.on("session", () => sessionCount++);
  const endpoint = { httpVersion: "2", proxyHeaders: { "X-aws-proxy-auth": "vm-token" } };
  await withProxy(upstream, endpoint, async ({ base }) => {
    const eventsAbort = new AbortController();
    const eventsReader = await openEvents(base, eventsAbort.signal);
    const responses = await Promise.all(Array.from({ length: 16 }, (_, i) => fetch(`${base}/d/some-id/request-${i}`)));
    assert.deepEqual(
      responses.map((response) => response.status),
      Array(16).fill(200),
    );
    assert.deepEqual(
      await Promise.all(responses.map((response) => response.text())),
      Array.from({ length: 16 }, (_, i) => `/request-${i}`),
    );
    assert.equal(sessionCount, 1);
    assert.deepEqual([...seenAuth], ["vm-token"]);
    eventsAbort.abort();
    await eventsReader.closed.catch(() => undefined);
    const afterAbort = await fetch(`${base}/d/some-id/after-abort`);
    assert.equal(await afterAbort.text(), "/after-abort");
    assert.equal(sessionCount, 1, "aborting one SSE stream keeps the shared session alive");
  });
});

test("/d/ proxy retires a GOAWAY session even while an SSE stream is open", async () => {
  const sessions: ServerHttp2Session[] = [];
  const slowStart = Promise.withResolvers<void>();
  const upstream = createHttp2Server((req, res) => {
    if (req.url === "/events") sseReady(res);
    else if (req.url === "/slow") {
      slowStart.resolve();
      setTimeout(() => res.end("slow-ok"), 50);
    } else res.end("replacement-ok");
  });
  upstream.on("session", (session) => sessions.push(session));
  await withProxy(upstream, { httpVersion: "2" }, async ({ base }) => {
    const reader = await openEvents(base);
    const slow = fetch(`${base}/d/some-id/slow`);
    await slowStart.promise;
    sessions[0]!.goaway();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const replacement = await fetch(`${base}/d/some-id/after-goaway`);
    assert.equal(await replacement.text(), "replacement-ok");
    assert.equal(await (await slow).text(), "slow-ok", "GOAWAY drains an accepted request instead of truncating it");
    assert.equal(sessions.length, 2);
    await reader.cancel().catch(() => undefined);
    await new Promise<void>((resolve) => (sessions[0]!.closed ? resolve() : sessions[0]!.once("close", resolve)));
    assert.equal(sessions[0]!.closed, true);
  });
});

test("/d/ proxy retries a GOAWAY-refused GET once but never replays a POST body", async () => {
  const hits = { "/retry-get": 0, "/retry-stream": 0, "/no-retry-post": 0, "/dead-session": 0 };
  const upstream = createHttp2Server();
  upstream.on("stream", (stream, headers) => {
    stream.on("error", () => undefined);
    const path = headers[":path"] as keyof typeof hits;
    const hit = path in hits ? ++hits[path] : 0;
    if (hit === 1 && path === "/dead-session") return stream.session!.destroy();
    if (hit === 1) return refuse(stream);
    stream.respond({ ":status": 200 });
    if (path !== "/retry-stream") return stream.end("ok");
    stream.write("first\n");
    setTimeout(() => stream.end("second\n"), 60);
  });
  await withProxy(
    upstream,
    { httpVersion: "2" },
    async ({ base }) => {
      assert.equal((await fetch(`${base}/d/some-id/warm`)).status, 200);
      const retried = await fetch(`${base}/d/some-id/retry-get`);
      assert.equal(retried.status, 200);
      assert.equal(await retried.text(), "ok");
      assert.equal(hits["/retry-get"], 2);

      const streamed = await fetch(`${base}/d/some-id/retry-stream`);
      assert.equal(
        await streamed.text(),
        "first\nsecond\n",
        "the failed stream's old timeout cannot terminate the replacement response",
      );
      assert.equal(hits["/retry-stream"], 2);

      const mutation = await fetch(`${base}/d/some-id/no-retry-post`, { method: "POST", body: "must-not-replay" });
      assert.equal(mutation.status, 502);
      assert.equal(hits["/no-retry-post"], 1);

      const recovered = await fetch(`${base}/d/some-id/dead-session`);
      assert.equal(recovered.status, 200);
      assert.equal(hits["/dead-session"], 2, "a safe request retries once after the shared session dies");
    },
    { deployDialTimeoutMs: 30 },
  );
});

test("/d/ proxy keeps the shared HTTP/2 session when one request has invalid headers", async () => {
  let sessionCount = 0;
  let invalidHeaders = false;
  const upstream = createHttp2Server((req, res) => (req.url === "/events" ? sseReady(res) : res.end("ok")));
  upstream.on("session", () => sessionCount++);
  const app = (port: number) =>
    ({
      reachDeployment: async () => ({
        status: "ok",
        endpoint: {
          host: "127.0.0.1",
          port,
          httpVersion: "2",
          ...(invalidHeaders ? { proxyHeaders: { connection: "invalid" } } : {}),
        },
      }),
    }) as unknown as App;
  await withProxy(upstream, app, async ({ base }) => {
    const eventsAbort = new AbortController();
    const reader = await openEvents(base, eventsAbort.signal);
    invalidHeaders = true;
    assert.equal((await fetch(`${base}/d/some-id/invalid`)).status, 502);
    invalidHeaders = false;
    assert.equal((await fetch(`${base}/d/some-id/healthy`)).status, 200);
    assert.equal(sessionCount, 1, "a request-local construction error does not kill unrelated streams");
    eventsAbort.abort();
    await reader.closed.catch(() => undefined);
  });
});

test("/d/ proxy never retries after an HTTP/2 timeout has committed a 504", async () => {
  let hits = 0;
  const upstream = createHttp2Server();
  upstream.on("stream", (stream) => {
    stream.on("error", () => undefined);
    hits++;
    setTimeout(() => stream.session?.destroy(), 40);
  });
  await withProxy(
    upstream,
    { httpVersion: "2" },
    async ({ base }) => {
      assert.equal((await fetch(`${base}/d/some-id/timeout`)).status, 504);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(hits, 1);
    },
    { deployDialTimeoutMs: 30 },
  );
});

test("/d/ proxy resets the downstream response when an HTTP/2 body is truncated", async () => {
  const upstream = createHttp2Server();
  upstream.on("stream", (stream) => {
    stream.on("error", () => undefined);
    stream.respond({ ":status": 200 });
    stream.write("partial");
    setTimeout(() => stream.destroy(new Error("truncated")), 20);
  });
  await withProxy(upstream, { httpVersion: "2" }, async ({ port }) => {
    const { body, aborted } = await rawRequest(port, { path: "/d/some-id/truncated" });
    assert.deepEqual({ body, aborted }, { body: "partial", aborted: true });
  });
});

test("/d/ proxy returns 504 instead of hanging when the deployment accepts but never responds", async () => {
  await withProxy(
    createHttpServer(() => {}),
    {},
    async ({ base }) => {
      const res = await fetch(`${base}/d/some-id/`);
      assert.equal(res.status, 504);
      assert.equal(((await res.json()) as { error?: string }).error, "gateway_timeout");
    },
    { deployDialTimeoutMs: 200 },
  );
});

test("/d/ proxy sends no extra headers when the endpoint declares none, and scrubs the dpl_access gate cookie even with stray whitespace around '='", async () => {
  const { server, seen } = recorder();
  await withProxy(server, {}, async ({ base }) => {
    assert.equal((await fetch(`${base}/d/some-id/`)).status, 200);
    assert.equal(seen.headers.cookie, undefined);
    const res = await fetch(`${base}/d/some-id/`, {
      headers: { cookie: "theme=dark; dpl_access = sneaky-gate-token; session=abc" },
    });
    assert.equal(res.status, 200);
    assert.equal(seen.headers.cookie, "theme=dark; session=abc");
  });
});

test("admin deployment proxy bypasses deployment ACL after admin auth and audits the visit", async () => {
  let upstreamUrl = "";
  const upstream = createHttpServer((req, res) => {
    upstreamUrl = req.url ?? "";
    res.end("admin-upstream-ok");
  });
  const upstreamPort = listen(upstream);

  const auditEvents: Array<{ principalId: string; action: string; resource: string; scopeLabel: string }> = [];
  let bypassAcl: boolean | undefined;
  const app = {
    listDeployments: async () => [{ id: "d1", ownerScopeId: "personal:U1" }],
    reachDeployment: async (_id: string, _principal: string, opts?: { bypassAcl?: boolean }) => {
      bypassAcl = opts?.bypassAcl;
      return opts?.bypassAcl
        ? { status: "ok", endpoint: { host: "127.0.0.1", port: upstreamPort } }
        : { status: "denied" };
    },
  } as unknown as App;
  const SECRET = "admin-deploy-proxy-secret".repeat(3);
  const server = createServer(app, {
    admin: createAdminService(),
    signingSecret: SECRET,
    auditLog: {
      record: (e) => auditEvents.push(e),
      events: async () => auditEvents as any,
      tail: async () => auditEvents as any,
    },
  });
  const base = `http://localhost:${listen(server)}`;
  try {
    const path = "/v1/admin/deployments/d1/proxy/hello?x=1";
    const actor = "admin-alice@default-org";
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`${base}${path}`, {
      headers: {
        "x-admin-actor": actor,
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `GET\n${path}\n${actor}`),
      },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "admin-upstream-ok");
    assert.equal(upstreamUrl, "/hello?x=1");
    assert.equal(bypassAcl, true);
    assert.ok(
      auditEvents.some(
        (e) =>
          e.principalId === "admin-alice" &&
          e.action === "deployment.visit" &&
          e.resource === "d1" &&
          e.scopeLabel === "personal:U1",
      ),
    );
  } finally {
    await close(server);
    await close(upstream);
  }
});

test("/d/ proxy forwards the client's content-type and body with an explicit content-length — never chunked (the MicroVM ingress rejects chunked uploads), buffering a chunked client body", async () => {
  const { server, seen } = recorder();
  await withProxy(server, {}, async ({ base, port }) => {
    const payload = JSON.stringify({ fund: "Fund I", as_of: "2026-03-31" });
    const res = await fetch(`${base}/d/some-id/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assert.equal(res.status, 200);
    assert.equal(seen.headers["content-type"], "application/json");
    assert.equal(seen.body, payload);
    assert.equal(seen.headers["content-length"], String(Buffer.byteLength(payload)));
    assert.equal(seen.headers["transfer-encoding"], undefined);

    const chunked = await rawRequest(
      port,
      { path: "/d/some-id/api/query", method: "POST", headers: { "content-type": "application/json" } },
      ['{"a":', "1}"],
    );
    assert.equal(chunked.status, 200);
    assert.equal(seen.body, '{"a":1}');
    assert.equal(seen.headers["content-length"], "7");
    assert.equal(seen.headers["transfer-encoding"], undefined);
  });
});

test("/d/ proxy forwards client cookies but scrubs the dpl_access gate token, and endpoint proxyHeaders still win", async () => {
  const { server, seen } = recorder();
  await withProxy(server, { proxyHeaders: { "X-aws-proxy-auth": "vm-token" } }, async ({ base }) => {
    const res = await fetch(`${base}/d/some-id/`, {
      headers: {
        cookie: "theme=dark; dpl_access=secret-gate-token; session=abc",
        "x-aws-proxy-auth": "spoofed",
        "x-portal-identity": "gateway-bearer",
      },
    });
    assert.equal(res.status, 200);
    assert.equal(seen.headers.cookie, "theme=dark; session=abc");
    assert.equal(seen.headers["x-aws-proxy-auth"], "vm-token");
    assert.equal(seen.headers["x-portal-identity"], undefined);
  });
});

test("/d/ proxy strips headers the client names in its own Connection header (dynamic hop-by-hop, RFC 9110)", async () => {
  const { server, seen } = recorder();
  await withProxy(server, {}, async ({ port }) => {
    const { status } = await rawRequest(port, {
      path: "/d/some-id/",
      method: "GET",
      headers: { connection: "x-hop-secret", "x-hop-secret": "leak", "x-keep": "kept" },
    });
    assert.equal(status, 200);
    assert.equal(seen.headers["x-hop-secret"], undefined);
    assert.equal(seen.headers["x-keep"], "kept");
  });
});

test("/d/ proxy strips fixed and Connection-named hop-by-hop response headers", async () => {
  const upstream = createHttpServer((_req, res) => {
    res.writeHead(200, {
      connection: "x-private",
      "x-private": "leak",
      "proxy-authenticate": 'Basic realm="upstream"',
      "x-keep": "kept",
    });
    res.end("ok");
  });
  await withProxy(upstream, {}, async ({ port }) => {
    const { headers } = await rawRequest(port, { path: "/d/some-id/" });
    assert.equal(headers["x-private"], undefined);
    assert.equal(headers["proxy-authenticate"], undefined);
    assert.equal(headers["x-keep"], "kept");
  });
});
