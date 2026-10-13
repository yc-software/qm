import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  dictationEnabled,
  speechToTextProvider,
  readDictation,
  MAX_DICTATION_BYTES,
} from "../server/speech-to-text.ts";

const env = {
  WEB_UI_VOICE_USERS: "alice",
  OPENAI_API_KEY: "test-key",
  CORE_SIGNING_SECRET: "test-secret",
};
test("dictation configuration is provider-specific and account-gated", () => {
  assert.equal(dictationEnabled("alice", env), true);
  assert.equal(dictationEnabled("bob", env), false);
  assert.equal(dictationEnabled("alice", { ...env, OPENAI_API_KEY: "" }), false);
});
test("OpenAI provider sends bounded audio with server-selected model and returns only text", async () => {
  let calls = 0;
  const provider = speechToTextProvider(env, (async (url, init) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    const form = init!.body as FormData;
    assert.equal(form.get("model"), "gpt-transcribe");
    const file = form.get("file") as File;
    assert.equal(file.name, "dictation.m4a");
    assert.equal(file.type, "audio/mp4");
    assert.equal(file.size, 3);
    return Response.json({ text: "  Test dictation.  ", internal: "ignored" });
  }) as typeof fetch)!;
  assert.equal(
    await provider.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      mimeType: "audio/mp4",
      user: "alice",
      org: "test",
      signal: new AbortController().signal,
    }),
    "Test dictation.",
  );
  await assert.rejects(
    provider.transcribe({
      audio: new Uint8Array(),
      mimeType: "audio/mp4",
      user: "alice",
      org: "test",
      signal: new AbortController().signal,
    }),
  );
  assert.equal(calls, 1);
});
test("invalid provider output and upstream failures are rejected", async () => {
  for (const response of [
    Response.json({ text: 42 }),
    Response.json({ text: "a".repeat(100_001) }),
    new Response("private upstream details", { status: 500 }),
  ]) {
    const provider = speechToTextProvider(env, (async () => response) as typeof fetch)!;
    await assert.rejects(
      provider.transcribe({
        audio: new Uint8Array([1]),
        mimeType: "audio/wav",
        user: "alice",
        org: "test",
        signal: new AbortController().signal,
      }),
    );
  }
});

test("chunked recordings cannot exceed the audio limit", async () => {
  const req = Readable.from([Buffer.alloc(MAX_DICTATION_BYTES), Buffer.from([1])]) as IncomingMessage;
  await assert.rejects(readDictation(req), { name: "PayloadTooLargeError" });
});
