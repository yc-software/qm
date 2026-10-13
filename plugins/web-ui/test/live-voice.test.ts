import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveVoice, voiceEnabled, voiceOriginAllowed } from "../server/live-voice.ts";

test("voice requires explicit rollout, key, signing, and account access", () => {
  const env = {
    OPENAI_API_KEY: "test-key",
    CORE_SIGNING_SECRET: "test-secret",
    WEB_UI_VOICE_USERS: "alice",
  };
  assert.equal(voiceEnabled("alice", env), true);
  assert.equal(voiceEnabled("bob", env), false);
  for (const name of Object.keys(env)) assert.equal(voiceEnabled("alice", { ...env, [name]: "" }), false);
  assert.equal(voiceOriginAllowed("https://qm.example.com", "https://qm.example.com/"), true);
  assert.equal(voiceOriginAllowed(undefined, "https://qm.example.com", true), true);
  assert.equal(voiceOriginAllowed("https://evil.test", "https://qm.example.com", true), false);
  for (const origin of [undefined, "null", "https://evil.test", "http://qm.example.com", "https://qm.example.com:8443"])
    assert.equal(voiceOriginAllowed(origin, "https://qm.example.com"), false);
});

test("session creation keeps credentials and authoritative configuration on server", async () => {
  const result = await createLiveVoice(
    "v=0\r\no=offer",
    "private-user",
    "private-org",
    "server-only-key",
    async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/live/sessions");
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer server-only-key");
      assert.match(headers.get("OpenAI-Safety-Identifier")!, /^[a-f0-9]{64}$/);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.session.model, "gpt-live-1");
      assert.equal(body.session.store, false);
      assert.equal(body.session.delegation.type, "responses");
      assert.equal(body.session.delegation.responses.tools[0].name, "ask_qm");
      assert.equal(body.session.delegation.responses.parallel_tool_calls, false);
      assert.equal(body.transport.sdp, "v=0\r\no=offer");
      assert.equal(String(init?.body).includes("private-user"), false);
      return Response.json({
        session: { id: "live_123", secret: "never-forward" },
        transport: { type: "webrtc", sdp: "v=0\r\no=answer" },
        token: "never-forward",
      });
    },
  );
  assert.deepEqual(result, { session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0\r\no=answer" } });
});

test("provider failures and malformed answers are rejected without leaking response bodies", async () => {
  await assert.rejects(
    createLiveVoice("v=0", "u", "o", "key", async () => new Response("private-provider-detail", { status: 401 })),
    { message: "Voice provider returned HTTP 401" },
  );
  await assert.rejects(
    createLiveVoice("v=0", "u", "o", "key", async () =>
      Response.json({ session: { id: "live_1" }, transport: { sdp: "bad" } }),
    ),
    /Invalid voice provider response/,
  );
});
