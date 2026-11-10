import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../src/api/app-types.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { browserImpersonationCookie, browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";

const testTmp = await mkdtemp(join(tmpdir(), "dictation-route-test-"));
process.env.TMPDIR = testTmp;
const { createServer } = await import("../src/api/server.ts");
const { sweepDictationSpool } = await import("../src/api/routes/voice.ts");

async function serve(deps: Partial<ServerDeps>): Promise<string> {
  const server = createServer(
    {} as App,
    {
      signingSecret: "voice-route-signing-secret-0123456789",
      replayDedupe: { claim: async () => true },
      ...browserSessionDeps,
      admin: { adminStatusOf: async (_tenant: unknown, { id }: { id: string }) => ({ isAdmin: id === "admin" }) },
      ...deps,
    } as ServerDeps,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  test.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const base = await serve({ openaiApiKey: "voice-test-key" });
const keyless = await serve({});
const origin = browserSessionDeps.portalUrl;
const identity = (user = "alice") => ({ cookie: browserSessionCookie(user) });
const impersonating = {
  cookie: `${browserSessionCookie("admin")}; ${browserImpersonationCookie("admin", "alice")}`,
};
const headers = { ...identity(), "content-type": "audio/mp4", origin };
const voiceHeaders = { ...identity(), "content-type": "application/json", origin };
const offer = JSON.stringify({ sdp: "v=0\r\no=offer" });

let openai: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end("{}");
const openaiStub = createHttpServer((req, res) => openai(req, res));
await new Promise<void>((resolve) => openaiStub.listen(0, resolve));
const spoolDir = join(tmpdir(), "qm-dictation");
const spooled = async () => new Set(await readdir(spoolDir).catch(() => []));

function routeOpenAIToStub(t: TestContext) {
  const actualFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    actualFetch(
      String(input).replace("https://api.openai.com", `http://localhost:${(openaiStub.address() as AddressInfo).port}`),
      init,
    ),
  );
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
}

test.after(() => {
  openaiStub.close();
  void rm(testTmp, { recursive: true, force: true });
});

test("dictation checks identity, origin, impersonation and format before provider access", async () => {
  for (const [requestHeaders, expected] of [
    [{}, 401],
    [{ "content-type": "audio/mp4" }, 401],
    [{ ...headers, ...impersonating }, 404],
    [{ ...headers, origin: "https://evil.test" }, 403],
    [{ ...headers, origin: "null" }, 403],
    [{ ...identity(), "content-type": "audio/mp4" }, 403],
    [{ ...headers, "content-type": "text/plain" }, 415],
  ] as const) {
    assert.equal(
      (await fetch(`${base}/api/dictation`, { method: "POST", headers: requestHeaders, body: "audio" })).status,
      expected,
      JSON.stringify(requestHeaders),
    );
  }
  for (const user of ["alice", "bob"]) {
    const capability = await fetch(`${base}/api/dictation`, { headers: identity(user) });
    assert.deepEqual(await capability.json(), { enabled: true, provider: "OpenAI" });
    assert.equal(capability.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(await (await fetch(`${base}/api/dictation`, { headers: impersonating })).json(), {
    enabled: false,
    provider: null,
  });
});

test("without an OpenAI key nobody gets dictation or voice", async () => {
  assert.deepEqual(await (await fetch(`${keyless}/api/dictation`, { headers: identity() })).json(), {
    enabled: false,
    provider: null,
  });
  assert.deepEqual(await (await fetch(`${keyless}/api/voice`, { headers: identity() })).json(), {
    enabled: false,
    model: "gpt-live-1",
  });
  const dictation = await fetch(`${keyless}/api/dictation`, { method: "POST", headers, body: "audio" });
  assert.deepEqual(
    [dictation.status, ((await dictation.json()) as { error?: string }).error],
    [404, "dictation_disabled"],
  );
  const voice = await fetch(`${keyless}/api/voice/sessions`, {
    method: "POST",
    headers: { ...identity(), origin, "content-type": "application/json" },
    body: offer,
  });
  assert.deepEqual([voice.status, ((await voice.json()) as { error?: string }).error], [404, "voice_disabled"]);
});

test("dictation uploads the whole recording to OpenAI and removes its spool file", async (t) => {
  routeOpenAIToStub(t);
  const before = await spooled();
  const audio = new Uint8Array(30 * 1024 * 1024).map((_, i) => (i * 31) & 255);
  let received = "";
  openai = (req, res) => {
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void new Response(Buffer.concat(chunks), { headers: { "content-type": req.headers["content-type"]! } })
        .formData()
        .then(async (form) => {
          const file = form.get("file") as File;
          received = hash.update(Buffer.from(await file.arrayBuffer())).digest("hex");
          assert.equal(form.get("model"), "gpt-transcribe");
          assert.equal(file.type, "audio/mp4");
          reply(200, { text: " long recording " })(req, res);
        });
    });
  };
  const response = await fetch(`${base}/api/dictation`, { method: "POST", headers, body: audio });
  assert.deepEqual(await response.json(), { text: "long recording" });
  assert.equal(received, createHash("sha256").update(audio).digest("hex"));
  assert.deepEqual(await spooled(), before);
});

test("dictation survives OpenAI answering before reading the upload", async (t) => {
  routeOpenAIToStub(t);
  openai = reply(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "7" });
  const response = await fetch(`${base}/api/dictation`, {
    method: "POST",
    headers,
    body: new Uint8Array(5 * 1024 * 1024),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal((await fetch(`${base}/api/dictation`, { headers: identity() })).status, 200);
});

test("dictation maps OpenAI errors by code", async (t) => {
  routeOpenAIToStub(t);
  const post = async (): Promise<Record<string, unknown>> => {
    const response = await fetch(`${base}/api/dictation`, { method: "POST", headers, body: "audio" });
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      ...((await response.json()) as Record<string, unknown>),
    };
  };
  const cases: [number, string, Record<string, string>, Record<string, unknown>][] = [
    [
      429,
      "rate_limit_exceeded",
      { "retry-after": "12" },
      { status: 429, retryAfter: "12", error: "provider_rate_limit" },
    ],
    [429, "rate_limit_exceeded", {}, { retryAfter: null, error: "provider_rate_limit" }],
    [429, "rate_limit_exceeded", { "retry-after": "" }, { retryAfter: null }],
    [429, "rate_limit_exceeded", { "retry-after": "1e3" }, { retryAfter: null }],
    [429, "rate_limit_exceeded", { "retry-after": "-5" }, { retryAfter: null }],
    [429, "rate_limit_exceeded", { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }, { retryAfter: null }],
    [429, "rate_limit_exceeded", { "retry-after": "99999" }, { retryAfter: "3600" }],
    [429, "insufficient_quota", {}, { status: 503, error: "dictation_unavailable" }],
    [413, "file_too_large", {}, { status: 413, error: "audio_too_large" }],
    [400, "unsupported_format", {}, { status: 400, error: "invalid_audio" }],
    [400, "invalid_value", {}, { status: 502, error: "dictation_rejected" }],
    [400, "invalid_parameter", {}, { status: 502, error: "dictation_rejected" }],
    [401, "invalid_api_key", {}, { status: 502, error: "dictation_rejected" }],
    [409, "conflict", {}, { status: 503, error: "dictation_unavailable" }],
    [302, "redirect", { location: "https://elsewhere.test/" }, { status: 503, error: "dictation_unavailable" }],
    [500, "server_error", {}, { status: 503, error: "dictation_unavailable" }],
  ];
  for (const [status, code, providerHeaders, expected] of cases) {
    openai = reply(status, { error: { code, message: "x".repeat(1000) } }, providerHeaders);
    const result = await post();
    for (const [key, value] of Object.entries(expected))
      assert.equal(result[key], value, `${status} ${code} ${JSON.stringify(providerHeaders)}: ${key}`);
  }
  openai = reply(400, { error: { code: "invalid_value", param: "file" } });
  assert.equal((await post()).error, "invalid_audio");
});

test("dictation reports storage failures as unavailable instead of hanging", async (t) => {
  routeOpenAIToStub(t);
  const actual = fs.createWriteStream;
  t.mock.method(fs, "createWriteStream", (path: string, options: object) => {
    actual(path, options).destroy();
    return new Writable({
      write(_chunk, _encoding, done) {
        done(Object.assign(new Error("no space left on device"), { code: "ENOSPC", syscall: "write" }));
      },
    });
  });
  const response = await fetch(`${base}/api/dictation`, {
    method: "POST",
    headers,
    body: new Uint8Array(256 * 1024),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as { error?: string }).error, "dictation_unavailable");
  assert.deepEqual(await spooled(), new Set());
});

test("startup sweep removes only stale spool files", async () => {
  await mkdir(spoolDir, { recursive: true });
  const stale = join(spoolDir, "stale-test");
  const fresh = join(spoolDir, "fresh-test");
  await writeFile(stale, "old");
  await writeFile(fresh, "new");
  const old = new Date(Date.now() - 2 * 3_600_000);
  await utimes(stale, old, old);
  await sweepDictationSpool();
  await assert.rejects(stat(stale));
  assert.ok(await stat(fresh));
  await sweepDictationSpool(Date.now() + 2 * 3_600_000);
  assert.deepEqual(await spooled(), new Set());
});

test("empty and interrupted uploads never reach OpenAI or leave spool files", async (t) => {
  routeOpenAIToStub(t);
  const before = await spooled();
  let calls = 0;
  openai = (req, res) => {
    calls++;
    reply(200, { text: "unexpected" })(req, res);
  };
  assert.equal(
    ((await (await fetch(`${base}/api/dictation`, { method: "POST", headers, body: "" })).json()) as { error?: string })
      .error,
    "empty_audio",
  );
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new Uint8Array(64 * 1024));
      setTimeout(() => controller.abort(), 100);
    },
  });
  await assert.rejects(
    fetch(`${base}/api/dictation`, {
      method: "POST",
      headers,
      body,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(calls, 0);
  assert.deepEqual(await spooled(), before);
});

test("dictation returns only transcript text and sanitizes provider failures", async (t) => {
  const actualFetch = globalThis.fetch;
  let failure = false;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== "https://api.openai.com/v1/audio/transcriptions") return actualFetch(input, init);
    if (failure) return new Response("secret details", { status: 401 });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer voice-test-key");
    return Response.json({ text: "Review this draft.", token: "must not leak" });
  });
  const result = await fetch(`${base}/api/dictation`, { method: "POST", headers, body: "audio" });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { text: "Review this draft." });
  const native = await fetch(`${base}/api/dictation`, {
    method: "POST",
    headers: { ...identity(), "content-type": "audio/mp4", origin, "x-qm-client": "ios" },
    body: "audio",
  });
  assert.equal(native.status, 200);
  failure = true;
  const rejected = await fetch(`${base}/api/dictation`, { method: "POST", headers, body: "audio" });
  assert.equal(rejected.status, 502);
  assert.equal((await rejected.text()).includes("secret details"), false);
});

test("disconnecting a dictation request cancels its provider request", async (t) => {
  const actualFetch = globalThis.fetch;
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== "https://api.openai.com/v1/audio/transcriptions") return actualFetch(input, init);
    started.resolve();
    return new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () => {
          cancelled.resolve();
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
  });
  const controller = new AbortController();
  const result = fetch(`${base}/api/dictation`, { method: "POST", headers, body: "audio", signal: controller.signal });
  const rejected = assert.rejects(result);
  await started.promise;
  controller.abort();
  await Promise.all([rejected, cancelled.promise]);
});

test("provider network failures log their cause chain", async (t) => {
  const actualFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== "https://api.openai.com/v1/audio/transcriptions") return actualFetch(input, init);
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
  });
  const logged: string[] = [];
  t.mock.method(console, "error", (line: unknown) => void logged.push(String(line)));
  const result = await fetch(`${base}/api/dictation`, { method: "POST", headers, body: "audio" });
  assert.equal(result.status, 503);
  const line = logged.find(
    (entry) => entry.startsWith("[voice] dictation_provider:") && entry.includes('"aborted":false'),
  );
  assert.match(line ?? "", /fetch failed <- .*ECONNRESET.*socket hang up/);
  assert.match(line ?? "", /"path":"audio\/transcriptions"/);
});

test("voice sessions authenticate and refuse foreign origins and impersonation before spending", async () => {
  assert.equal((await fetch(`${base}/api/voice/sessions`, { method: "POST", body: offer })).status, 401);
  for (const [requestHeaders, expected] of [
    [{ ...voiceHeaders, origin: "https://evil.test" }, 403],
    [{ ...voiceHeaders, origin: "null" }, 403],
    [{ ...voiceHeaders, ...impersonating }, 404],
  ] as const) {
    const response = await fetch(`${base}/api/voice/sessions`, {
      method: "POST",
      headers: requestHeaders,
      body: offer,
    });
    assert.equal(response.status, expected, JSON.stringify(requestHeaders));
  }
  const capability = await fetch(`${base}/api/voice`, { headers: identity("bob") });
  assert.deepEqual(await capability.json(), { enabled: true, model: "gpt-live-1" });
  assert.equal(capability.headers.get("cache-control"), "no-store");
});

test("voice rejects invalid and oversized offers", async () => {
  for (const body of ["{", "null", "[]", "{}", JSON.stringify({ sdp: "bad" })]) {
    const response = await fetch(`${base}/api/voice/sessions`, { method: "POST", headers: voiceHeaders, body });
    assert.equal(response.status, 400, body);
  }
  const large = await fetch(`${base}/api/voice/sessions`, {
    method: "POST",
    headers: voiceHeaders,
    body: JSON.stringify({ sdp: "v=0" + "x".repeat(70_000) }),
  });
  assert.equal(large.status, 413);
});

test("voice relays only a sanitized SDP result and never a provider key", async (t) => {
  const actualFetch = globalThis.fetch;
  let providerCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== "https://api.openai.com/v1/live/sessions") return actualFetch(input, init);
    providerCalls++;
    return Response.json({
      session: { id: "live_route" },
      transport: { type: "webrtc", sdp: "v=0\r\no=answer" },
      api_key: "must-not-leak",
    });
  });
  const response = await fetch(`${base}/api/voice/sessions`, { method: "POST", headers: voiceHeaders, body: offer });
  assert.equal(response.status, 201);
  assert.equal(providerCalls, 1);
  assert.deepEqual(await response.json(), {
    session: { id: "live_route" },
    transport: { type: "webrtc", sdp: "v=0\r\no=answer" },
  });
});

test("a signed caller's voice body is buffered and covered by its signature", async () => {
  const path = "/v1/web/voice/sessions";
  const signed = (body: string) => signedHeaders("voice-route-signing-secret-0123456789", "POST", path, body);
  const forged = await fetch(`${base}${path}`, { method: "POST", headers: signed("{}"), body: offer });
  assert.equal(forged.status, 401);
  const matching = await fetch(`${base}${path}`, { method: "POST", headers: signed(offer), body: offer });
  assert.deepEqual([matching.status, await matching.json()], [400, { error: "invalid_offer" }]);
});
