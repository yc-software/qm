import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

process.env.CORE_SIGNING_SECRET = "voice-route-test";
process.env.WEB_UI_PUBLIC_URL = "https://qm.example.test";
process.env.WEB_UI_VOICE_USERS = "alice";
process.env.OPENAI_API_KEY = "voice-test-key";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const identity = (user = "alice") => ({
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, "voice-route-test"),
});
const headers = { ...identity(), "content-type": "audio/mp4", origin: "https://qm.example.test" };

test.after(() => {
  surface.close();
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

test("dictation maps OpenAI's limits to client errors", async (t) => {
  const actualFetch = globalThis.fetch;
  let provider = () => new Response("{}");
  let uploaded: number | undefined;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== "https://api.openai.com/v1/audio/transcriptions") return actualFetch(input, init);
    uploaded = ((init!.body as FormData).get("file") as File).size;
    return provider();
  });
  const fail =
    (status: number, code: string, headers: Record<string, string> = {}) =>
    () =>
      new Response(JSON.stringify({ error: { code } }), { status, headers });
  const post = async (body: BodyInit = "audio") => {
    const response = await fetch(`${base}/api/dictation`, { method: "POST", headers, body });
    return { status: response.status, retryAfter: response.headers.get("retry-after"), ...(await response.json()) };
  };
  provider = fail(429, "rate_limit_exceeded", { "retry-after": "12" });
  assert.deepEqual(
    [(await post()).status, (await post()).retryAfter, (await post()).error],
    [429, "12", "provider_rate_limit"],
  );
  for (const retryAfter of ["", "1e3", "-5", "Wed, 21 Oct 2015 07:28:00 GMT"]) {
    provider = fail(429, "rate_limit_exceeded", { "retry-after": retryAfter });
    assert.equal((await post()).retryAfter, null);
  }
  provider = fail(429, "rate_limit_exceeded");
  assert.equal((await post()).retryAfter, null);
  provider = fail(429, "rate_limit_exceeded", { "retry-after": "99999" });
  assert.equal((await post()).retryAfter, "3600");
  provider = fail(429, "insufficient_quota");
  assert.equal((await post()).error, "dictation_unavailable");
  provider = fail(413, "file_too_large");
  assert.equal((await post()).error, "audio_too_large");
  provider = fail(400, "unsupported_format");
  assert.equal((await post()).error, "invalid_audio");
  provider = fail(400, "invalid_parameter");
  assert.equal((await post()).error, "dictation_unavailable");
  uploaded = undefined;
  assert.equal((await post("")).error, "empty_audio");
  assert.equal(uploaded, undefined);
  provider = () => Response.json({ text: "long recording" });
  const audio = new Uint8Array(30 * 1024 * 1024);
  assert.equal((await post(audio)).text, "long recording");
  assert.equal(uploaded, audio.byteLength);
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
  assert.equal(rejected.status, 503);
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
