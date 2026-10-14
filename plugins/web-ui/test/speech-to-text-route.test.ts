import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

process.env.TMPDIR = await mkdtemp(join(tmpdir(), "dictation-route-test-"));
process.env.CORE_SIGNING_SECRET = "voice-route-test";
process.env.WEB_UI_PUBLIC_URL = "https://qm.example.test";
process.env.WEB_UI_VOICE_USERS = "alice";
process.env.OPENAI_API_KEY = "voice-test-key";
const { handler } = await import("../server/index.ts");
const { sweepDictationSpool } = await import("../server/voice-routes.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const identity = (user = "alice") => ({
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, "voice-route-test"),
});
const headers = { ...identity(), "content-type": "audio/mp4", origin: "https://qm.example.test" };

let openai: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end("{}");
const openaiStub = createServer((req, res) => openai(req, res));
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
  surface.close();
  openaiStub.close();
});

test("dictation checks identity, origin, allowlist and format before provider access", async () => {
  for (const [requestHeaders, expected] of [
    [{}, 401],
    [{ ...headers, ...identity("bob") }, 404],
    [
      {
        ...headers,
        [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
          { p: "alice", imp: "admin", exp: Date.now() + 60_000 },
          "voice-route-test",
        ),
      },
      404,
    ],
    [{ "content-type": "audio/mp4" }, 401],
    [{ ...headers, origin: "https://evil.test" }, 403],
    [{ ...headers, "content-type": "text/plain" }, 415],
  ] as const) {
    assert.equal(
      (await fetch(`${base}/api/dictation`, { method: "POST", headers: requestHeaders, body: "audio" })).status,
      expected,
    );
  }
  const capability = await fetch(`${base}/api/dictation`, { headers: identity() });
  assert.deepEqual(await capability.json(), { enabled: true, provider: "OpenAI" });
  assert.equal(capability.headers.get("cache-control"), "no-store");
});

test("dictation uploads the whole recording to OpenAI and removes its spool file", async (t) => {
  routeOpenAIToStub(t);
  const before = await spooled();
  const audio = new Uint8Array(30 * 1024 * 1024).map((_, i) => (i * 31) & 255);
  let received = "";
  openai = (req, res) => {
    const hash = createHash("sha256");
    let raw = Buffer.alloc(0);
    req.on("data", (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
    });
    req.on("end", () => {
      void new Response(raw, { headers: { "content-type": req.headers["content-type"]! } })
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
  const post = async () => {
    const response = await fetch(`${base}/api/dictation`, { method: "POST", headers, body: "audio" });
    return { status: response.status, retryAfter: response.headers.get("retry-after"), ...(await response.json()) };
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
    (await (await fetch(`${base}/api/dictation`, { method: "POST", headers, body: "" })).json()).error,
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
    headers: { ...identity(), "content-type": "audio/mp4" },
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
