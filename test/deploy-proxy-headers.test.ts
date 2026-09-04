import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { constants as http2Constants, createServer as createHttp2Server, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { createAdminService } from "../src/admin/admin-service.ts";
import { signRequest } from "../src/auth/source-auth.ts";

function appWith(endpoint: Record<string, unknown>): App {
  return { reachDeployment: async () => ({ status: "ok", endpoint }) } as unknown as App;
}

test("/d/ proxy attaches the endpoint's proxyHeaders — the internal path authenticates to a token-gated deployment", async () => {
  let seenCookie: string | undefined;
  const upstream = createHttpServer((req, res) => {
    seenCookie = req.headers.cookie;
    res.end("upstream-ok");
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const server = createInsecureTestServer(
    appWith({ host: "127.0.0.1", port: upstreamPort, proxyHeaders: { cookie: "dpl_access=tok" } }),
  );
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/d/some-id/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "upstream-ok");
    assert.equal(seenCookie, "dpl_access=tok");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy multiplexes concurrent requests over one HTTP/2 session", async () => {
  let sessionCount = 0;
  const sessions = new Set<ServerHttp2Session>();
  const seenAuth = new Set<string>();
  const upstream = createHttp2Server((req, res) => {
    seenAuth.add(String(req.headers["x-aws-proxy-auth"] ?? ""));
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: ready\n\n");
      return;
    }
    setTimeout(() => res.end(req.url), 30);
  });
  upstream.on("session", (session) => {
    sessionCount++;
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const server = createInsecureTestServer(
    appWith({
      host: "127.0.0.1",
      port: upstreamPort,
      httpVersion: "2",
      proxyHeaders: { "X-aws-proxy-auth": "vm-token" },
    }),
  );
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const eventsAbort = new AbortController();
    const events = await fetch(`${base}/d/some-id/events`, { signal: eventsAbort.signal });
    const eventsReader = events.body!.getReader();
    assert.match(Buffer.from((await eventsReader.read()).value!).toString(), /data: ready/);
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
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    for (const session of sessions) session.destroy();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy retires a GOAWAY session even while an SSE stream is open", async () => {
  const sessions: ServerHttp2Session[] = [];
  let slowStarted!: () => void;
  const slowStart = new Promise<void>((resolve) => (slowStarted = resolve));
  const upstream = createHttp2Server((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: ready\n\n");
    } else if (req.url === "/slow") {
      slowStarted();
      setTimeout(() => res.end("slow-ok"), 50);
    } else {
      res.end("replacement-ok");
    }
  });
  upstream.on("session", (session) => sessions.push(session));
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort, httpVersion: "2" }));
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    const events = await fetch(`${base}/d/some-id/events`);
    const reader = events.body!.getReader();
    assert.match(Buffer.from((await reader.read()).value!).toString(), /data: ready/);
    const slow = fetch(`${base}/d/some-id/slow`);
    await slowStart;
    sessions[0]!.goaway();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const replacement = await fetch(`${base}/d/some-id/after-goaway`);
    assert.equal(await replacement.text(), "replacement-ok");
    assert.equal(await (await slow).text(), "slow-ok", "GOAWAY drains an accepted request instead of truncating it");
    assert.equal(sessions.length, 2);
    await reader.cancel().catch(() => undefined);
    await new Promise<void>((resolve) => (sessions[0]!.closed ? resolve() : sessions[0]!.once("close", resolve)));
    assert.equal(sessions[0]!.closed, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    for (const session of sessions) session.destroy();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy retries a GOAWAY-refused GET once but never replays a POST body", async () => {
  const sessions = new Set<ServerHttp2Session>();
  let getHits = 0;
  let streamHits = 0;
  let postHits = 0;
  let deadHits = 0;
  const upstream = createHttp2Server();
  upstream.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  upstream.on("stream", (stream, headers) => {
    stream.on("error", () => undefined);
    const path = headers[":path"];
    if (path === "/retry-get" && ++getHits === 1) {
      stream.session!.goaway(http2Constants.NGHTTP2_NO_ERROR, stream.id! - 2);
      stream.close(http2Constants.NGHTTP2_REFUSED_STREAM);
      return;
    }
    if (path === "/retry-stream" && ++streamHits === 1) {
      stream.session!.goaway(http2Constants.NGHTTP2_NO_ERROR, stream.id! - 2);
      stream.close(http2Constants.NGHTTP2_REFUSED_STREAM);
      return;
    }
    if (path === "/retry-stream") {
      stream.respond({ ":status": 200 });
      stream.write("first\n");
      setTimeout(() => stream.end("second\n"), 60);
      return;
    }
    if (path === "/no-retry-post" && ++postHits === 1) {
      stream.session!.goaway(http2Constants.NGHTTP2_NO_ERROR, stream.id! - 2);
      stream.close(http2Constants.NGHTTP2_REFUSED_STREAM);
      return;
    }
    if (path === "/dead-session" && ++deadHits === 1) {
      stream.session!.destroy();
      return;
    }
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort, httpVersion: "2" }), {
    deployDialTimeoutMs: 30,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    assert.equal((await fetch(`${base}/d/some-id/warm`)).status, 200);
    const retried = await fetch(`${base}/d/some-id/retry-get`);
    assert.equal(retried.status, 200);
    assert.equal(await retried.text(), "ok");
    assert.equal(getHits, 2);

    const streamed = await fetch(`${base}/d/some-id/retry-stream`);
    assert.equal(
      await streamed.text(),
      "first\nsecond\n",
      "the failed stream's old timeout cannot terminate the replacement response",
    );
    assert.equal(streamHits, 2);

    const mutation = await fetch(`${base}/d/some-id/no-retry-post`, { method: "POST", body: "must-not-replay" });
    assert.equal(mutation.status, 502);
    assert.equal(postHits, 1);

    const recovered = await fetch(`${base}/d/some-id/dead-session`);
    assert.equal(recovered.status, 200);
    assert.equal(deadHits, 2, "a safe request retries once after the shared session dies");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    for (const session of sessions) session.destroy();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy keeps the shared HTTP/2 session when one request has invalid headers", async () => {
  let sessionCount = 0;
  let invalidHeaders = false;
  const sessions = new Set<ServerHttp2Session>();
  const upstream = createHttp2Server((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: ready\n\n");
    } else {
      res.end("ok");
    }
  });
  upstream.on("session", (session) => {
    sessionCount++;
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const app = {
    reachDeployment: async () => ({
      status: "ok",
      endpoint: {
        host: "127.0.0.1",
        port: upstreamPort,
        httpVersion: "2",
        ...(invalidHeaders ? { proxyHeaders: { connection: "invalid" } } : {}),
      },
    }),
  } as unknown as App;
  const server = createInsecureTestServer(app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    const eventsAbort = new AbortController();
    const events = await fetch(`${base}/d/some-id/events`, { signal: eventsAbort.signal });
    const reader = events.body!.getReader();
    assert.match(Buffer.from((await reader.read()).value!).toString(), /data: ready/);
    invalidHeaders = true;
    assert.equal((await fetch(`${base}/d/some-id/invalid`)).status, 502);
    invalidHeaders = false;
    assert.equal((await fetch(`${base}/d/some-id/healthy`)).status, 200);
    assert.equal(sessionCount, 1, "a request-local construction error does not kill unrelated streams");
    eventsAbort.abort();
    await reader.closed.catch(() => undefined);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    for (const session of sessions) session.destroy();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy never retries after an HTTP/2 timeout has committed a 504", async () => {
  let hits = 0;
  const sessions = new Set<ServerHttp2Session>();
  const upstream = createHttp2Server();
  upstream.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  upstream.on("stream", (stream) => {
    stream.on("error", () => undefined);
    hits++;
    setTimeout(() => stream.session?.destroy(), 40);
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort, httpVersion: "2" }), {
    deployDialTimeoutMs: 30,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${base}/d/some-id/timeout`);
    assert.equal(response.status, 504);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(hits, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    for (const session of sessions) session.destroy();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy resets the downstream response when an HTTP/2 body is truncated", async () => {
  const sessions = new Set<ServerHttp2Session>();
  const upstream = createHttp2Server();
  upstream.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  upstream.on("stream", (stream) => {
    stream.on("error", () => undefined);
    stream.respond({ ":status": 200 });
    stream.write("partial");
    setTimeout(() => stream.destroy(new Error("truncated")), 20);
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort, httpVersion: "2" }));
  server.listen(0);
  const port = (server.address() as AddressInfo).port;

  try {
    const outcome = await new Promise<{ body: string; aborted: boolean }>((resolve, reject) => {
      const request = httpRequest({ host: "localhost", port, path: "/d/some-id/truncated" }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk as Buffer));
        response.on("aborted", () => resolve({ body: Buffer.concat(chunks).toString(), aborted: true }));
        response.on("end", () => resolve({ body: Buffer.concat(chunks).toString(), aborted: false }));
      });
      request.on("error", reject);
      request.end();
    });
    assert.deepEqual(outcome, { body: "partial", aborted: true });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    for (const session of sessions) session.destroy();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy returns 504 instead of hanging when the deployment accepts but never responds", async () => {
  const held: import("node:net").Socket[] = [];
  const upstream = createHttpServer((req) => {
    held.push(req.socket);
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort }), {
    deployDialTimeoutMs: 200,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/d/some-id/`);
    assert.equal(res.status, 504);
    assert.equal(((await res.json()) as { error?: string }).error, "gateway_timeout");
  } finally {
    for (const s of held) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy sends no extra headers when the endpoint declares none", async () => {
  let seenCookie: string | undefined;
  const upstream = createHttpServer((req, res) => {
    seenCookie = req.headers.cookie;
    res.end("ok");
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort }));
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/d/some-id/`);
    assert.equal(res.status, 200);
    assert.equal(seenCookie, undefined);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("admin deployment proxy bypasses deployment ACL after admin auth and audits the visit", async () => {
  let upstreamUrl = "";
  const upstream = createHttpServer((req, res) => {
    upstreamUrl = req.url ?? "";
    res.end("admin-upstream-ok");
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

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
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
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
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy forwards the client's content-type and body with an explicit content-length — never chunked (the MicroVM ingress rejects chunked uploads)", async () => {
  let seen: { ct?: string; cl?: string; te?: string; body?: string } = {};
  const upstream = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      seen = {
        ct: req.headers["content-type"],
        cl: req.headers["content-length"],
        te: req.headers["transfer-encoding"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.end("ok");
    });
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort }));
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const payload = JSON.stringify({ fund: "Fund I", as_of: "2026-03-31" });
    const res = await fetch(`${base}/d/some-id/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assert.equal(res.status, 200);
    assert.equal(seen.ct, "application/json");
    assert.equal(seen.body, payload);
    assert.equal(seen.cl, String(Buffer.byteLength(payload)));
    assert.equal(seen.te, undefined);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy buffers a chunked client body into an explicit content-length upstream", async () => {
  let seen: { cl?: string; te?: string; body?: string } = {};
  const upstream = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      seen = {
        cl: req.headers["content-length"],
        te: req.headers["transfer-encoding"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.end("ok");
    });
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort }));
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const rq = httpRequest(
        {
          host: "localhost",
          port,
          path: "/d/some-id/api/query",
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (rs) => {
          rs.resume();
          resolve(rs.statusCode ?? 0);
        },
      );
      rq.on("error", reject);
      rq.write('{"a":');
      rq.write("1}");
      rq.end();
    });
    assert.equal(status, 200);
    assert.equal(seen.body, '{"a":1}');
    assert.equal(seen.cl, "7");
    assert.equal(seen.te, undefined);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy forwards client cookies but scrubs the dpl_access gate token, and endpoint proxyHeaders still win", async () => {
  let seenCookie: string | undefined;
  let seenAuth: string | undefined;
  let seenPortalIdentity: string | undefined;
  const upstream = createHttpServer((req, res) => {
    seenCookie = req.headers.cookie;
    seenAuth = req.headers["x-aws-proxy-auth"] as string | undefined;
    seenPortalIdentity = req.headers["x-portal-identity"] as string | undefined;
    res.end("ok");
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const server = createInsecureTestServer(
    appWith({ host: "127.0.0.1", port: upstreamPort, proxyHeaders: { "X-aws-proxy-auth": "vm-token" } }),
  );
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/d/some-id/`, {
      headers: {
        cookie: "theme=dark; dpl_access=secret-gate-token; session=abc",
        "x-aws-proxy-auth": "spoofed",
        "x-portal-identity": "gateway-bearer",
      },
    });
    assert.equal(res.status, 200);
    assert.equal(seenCookie, "theme=dark; session=abc");
    assert.equal(seenAuth, "vm-token");
    assert.equal(seenPortalIdentity, undefined);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy strips headers the client names in its own Connection header (dynamic hop-by-hop, RFC 9110)", async () => {
  let seenHop: string | undefined;
  let seenKeep: string | undefined;
  const upstream = createHttpServer((req, res) => {
    seenHop = req.headers["x-hop-secret"] as string | undefined;
    seenKeep = req.headers["x-keep"] as string | undefined;
    res.end("ok");
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort }));
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const rq = httpRequest(
        {
          host: "localhost",
          port,
          path: "/d/some-id/",
          method: "GET",
          headers: { connection: "x-hop-secret", "x-hop-secret": "leak", "x-keep": "kept" },
        },
        (rs) => {
          rs.resume();
          resolve(rs.statusCode ?? 0);
        },
      );
      rq.on("error", reject);
      rq.end();
    });
    assert.equal(status, 200);
    assert.equal(seenHop, undefined);
    assert.equal(seenKeep, "kept");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
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
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort }));
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const headers = await new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
      const rq = httpRequest({ host: "localhost", port, path: "/d/some-id/" }, (rs) => {
        rs.resume();
        rs.on("end", () => resolve(rs.headers));
      });
      rq.on("error", reject);
      rq.end();
    });
    assert.equal(headers["x-private"], undefined);
    assert.equal(headers["proxy-authenticate"], undefined);
    assert.equal(headers["x-keep"], "kept");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("/d/ proxy scrubs the dpl_access gate cookie even with stray whitespace around '='", async () => {
  let seenCookie: string | undefined;
  const upstream = createHttpServer((req, res) => {
    seenCookie = req.headers.cookie;
    res.end("ok");
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const server = createInsecureTestServer(appWith({ host: "127.0.0.1", port: upstreamPort }));
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/d/some-id/`, {
      headers: { cookie: "theme=dark; dpl_access = sneaky-gate-token; session=abc" },
    });
    assert.equal(res.status, 200);
    assert.equal(seenCookie, "theme=dark; session=abc");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
