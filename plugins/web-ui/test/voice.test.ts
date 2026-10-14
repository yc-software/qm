import { test, type TestContext } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { createLiveVoice, transcribe, voiceEnabled, voiceRequestAllowed, VoiceProviderError } from "../server/voice.ts";

const caller = {
  user: "private-user",
  org: "private-org",
  apiKey: "server-only-key",
  signal: new AbortController().signal,
};
const stubFetch = (t: TestContext, impl: (url: string, init?: RequestInit) => Promise<Response>) =>
  t.mock.method(globalThis, "fetch", (url: Parameters<typeof fetch>[0], init?: RequestInit) => impl(String(url), init));
const audioFile = async (bytes: number[]) => {
  const file = join(await mkdtemp(join(tmpdir(), "voice-test-")), "audio");
  await writeFile(file, new Uint8Array(bytes));
  return file;
};
const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

test("voice requires explicit rollout, key, signing, and account access", () => {
  const env = { OPENAI_API_KEY: "test-key", CORE_SIGNING_SECRET: "test-secret", WEB_UI_VOICE_USERS: "alice" };
  assert.equal(voiceEnabled("alice", env), true);
  assert.equal(voiceEnabled("bob", env), false);
  for (const name of Object.keys(env)) assert.equal(voiceEnabled("alice", { ...env, [name]: " " }), false);
});

test("voice requests come from the web origin or a verified native client", () => {
  const url = "https://qm.example.com/";
  assert.equal(voiceRequestAllowed(req({ origin: "https://qm.example.com" }), url, false), true);
  assert.equal(voiceRequestAllowed(req({}), url, true), true);
  assert.equal(voiceRequestAllowed(req({ "sec-fetch-site": "cross-site" }), url, true), false);
  assert.equal(voiceRequestAllowed(req({ origin: "https://evil.test" }), url, true), false);
  for (const origin of ["null", "https://evil.test", "http://qm.example.com", "https://qm.example.com:8443"])
    assert.equal(voiceRequestAllowed(req({ origin }), url, false), false);
  assert.equal(voiceRequestAllowed(req({}), url, false), false);
});

test("session creation keeps credentials and authoritative configuration on server", async (t) => {
  stubFetch(t, async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/live/sessions");
    assert.equal(init?.redirect, "manual");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer server-only-key");
    assert.match(headers.get("OpenAI-Safety-Identifier")!, /^[a-f0-9]{64}$/);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.session.model, "gpt-live-1");
    assert.equal(body.session.store, false);
    assert.equal(body.session.delegation.responses.tools[0].name, "ask_qm");
    assert.equal(body.transport.sdp, "v=0\r\no=offer");
    assert.equal(String(init?.body).includes("private-user"), false);
    return Response.json({
      session: { id: "live_123", secret: "never-forward" },
      transport: { type: "webrtc", sdp: "v=0\r\no=answer" },
      token: "never-forward",
    });
  });
  const result = await createLiveVoice("v=0\r\no=offer", caller);
  assert.deepEqual(result, { session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0\r\no=answer" } });
});

test("provider failures keep diagnostic evidence for error reporting", async (t) => {
  const failed = new Response('{"error":{"code":"invalid_api_key"}}', {
    status: 401,
    headers: { "x-request-id": "req_1" },
  });
  const responses = [failed, Response.json({ session: { id: "live_1" }, transport: { sdp: "bad" } })];
  stubFetch(t, async () => responses.shift() ?? Promise.reject(new TypeError("fetch failed")));
  await assert.rejects(
    createLiveVoice("v=0", caller),
    (error: unknown) =>
      error instanceof VoiceProviderError &&
      error.detail.status === 401 &&
      error.detail.requestId === "req_1" &&
      String(error.detail.body).includes("invalid_api_key"),
  );
  await assert.rejects(createLiveVoice("v=0", caller), /Invalid live session response/);
  await assert.rejects(
    createLiveVoice("v=0", caller),
    (error: unknown) =>
      error instanceof VoiceProviderError && error.detail.path === "live/sessions" && error.cause instanceof TypeError,
  );
});

test("transcription sends audio with the server-selected model and returns only text", async (t) => {
  const responses: Response[] = [];
  stubFetch(t, async (url, init) => {
    if (responses.length) return responses.shift()!;
    assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
    const form = await new Response(init!.body, { headers: init!.headers }).formData();
    assert.equal(form.get("model"), "gpt-transcribe");
    const file = form.get("file") as File;
    assert.equal(file.name, "dictation.m4a");
    assert.equal(file.type, "audio/mp4");
    assert.equal(file.size, 3);
    return Response.json({ text: "  Test dictation.  ", internal: "ignored" });
  });
  assert.equal(await transcribe(await audioFile([1, 2, 3]), 3, "audio/mp4", caller), "Test dictation.");
  responses.push(Response.json({ text: 42 }));
  await assert.rejects(transcribe(await audioFile([1]), 1, "audio/wav", caller), /Invalid transcription/);
});
