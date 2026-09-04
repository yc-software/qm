import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import {
  runEmojiUpload,
  isValidEmojiName,
  normalizeWorkspace,
  slackCookieHeader,
  EMOJI_UPLOAD_SESSION_EXPIRED,
  type EmojiUploadDeps,
} from "../src/connectors/emoji-upload-service.ts";
import {
  createBrowserSessionStore,
  type BrowserSessionStore,
  type StoredBrowserSession,
} from "../src/connectors/browser-session-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const ACTOR = "U_ACTOR";
const FALLBACK = "U_FALLBACK";
const WORKSPACE = "acme.slack.com";
const TOKEN = "xoxc-1234-abcd";

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");
const GIF_B64 = Buffer.from("GIF89a-data", "utf8").toString("base64");

const STATE = (v: string) =>
  JSON.stringify({
    cookies: [
      { name: "d", value: `d-${v}`, domain: ".slack.com" },
      { name: "d-s", value: `ds-${v}`, domain: ".slack.com" },
      { name: "junk", value: "nope", domain: "example.com" },
    ],
  });

function memSessionStore(): BrowserSessionStore {
  return createBrowserSessionStore({
    sessions: createMemoryMap<StoredBrowserSession>(),
    key: deriveConnectorKey(Buffer.alloc(32, 1)),
  });
}

function memSessionStoreWith(...principals: string[]): BrowserSessionStore {
  const s = memSessionStore();
  for (const p of principals) void s.put(p, STATE(p));
  return s;
}

interface FakeOpts {
  token?: string | null;
  add?: { ok?: boolean; error?: string };
  addStatus?: number;
  addBodyIsJson?: boolean;
}

function fakeFetch(opts: FakeOpts = {}) {
  const calls: Array<{ url: string; cookie: string; body?: FormData; redirect?: RequestInit["redirect"] }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const cookie = String((init?.headers as Record<string, string> | undefined)?.Cookie ?? "");
    if (u.endsWith("/api/emoji.add")) {
      calls.push({ url: u, cookie, body: init?.body as FormData, redirect: init?.redirect });
      const status = opts.addStatus ?? 200;
      const payload = opts.addBodyIsJson === false ? "<html>nope</html>" : JSON.stringify(opts.add ?? { ok: true });
      return new Response(payload, { status });
    }
    calls.push({ url: u, cookie, redirect: init?.redirect });
    const html =
      opts.token === null
        ? "<html>signed out</html>"
        : `<script>window.boot={"api_token":"${opts.token ?? TOKEN}"}</script>`;
    return new Response(html, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function buildDeps(
  sessionStore: BrowserSessionStore | undefined,
  fetchImpl: typeof fetch,
  connectorWorkspace: string | null = WORKSPACE,
): EmojiUploadDeps {
  return {
    principalId: ACTOR,
    fetchImpl,
    timeoutMs: 2_000,
    ...(connectorWorkspace ? { connectorWorkspace } : {}),
    ...(sessionStore ? { sessionStore } : {}),
  };
}

async function withFallback<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.SLACK_EMOJI_FALLBACK_PRINCIPAL;
  if (value === undefined) delete process.env.SLACK_EMOJI_FALLBACK_PRINCIPAL;
  else process.env.SLACK_EMOJI_FALLBACK_PRINCIPAL = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SLACK_EMOJI_FALLBACK_PRINCIPAL;
    else process.env.SLACK_EMOJI_FALLBACK_PRINCIPAL = prev;
  }
}

const REQ = { name: "partyparrot", imageBase64: PNG_B64 };

test("isValidEmojiName accepts the Slack charset and rejects spaces/caps/punctuation", () => {
  for (const ok of ["partyparrot", "thumbs_up", "a", "c-3po", "n+1", "she's"]) {
    assert.equal(isValidEmojiName(ok), true, `expected valid: ${ok}`);
  }
  for (const bad of ["", "Has Space", "UPPER", "bang!", "smile🙂", "a".repeat(101)]) {
    assert.equal(isValidEmojiName(bad), false, `expected invalid: ${bad}`);
  }
});

test("normalizeWorkspace accepts only Slack HTTPS origins", () => {
  assert.equal(normalizeWorkspace("https://acme.slack.com/"), "acme.slack.com");
  assert.equal(normalizeWorkspace("acme.slack.com"), "acme.slack.com");
  for (const bad of [
    "http://acme.slack.com",
    "https://attacker.example",
    "https://acme.slack.com.attacker.example",
    "https://user@acme.slack.com",
    "https://acme.slack.com:444",
    "https://acme.slack.com/path",
    "https://acme.slack.com/?query",
    "https://acme.slack.com/#fragment",
  ]) {
    assert.equal(normalizeWorkspace(bad), null, bad);
  }
  assert.equal(normalizeWorkspace("   "), null);
  assert.equal(normalizeWorkspace(undefined), null);
});

test("slackCookieHeader keeps every *.slack.com cookie, drops others, requires a d cookie", () => {
  const h = slackCookieHeader(STATE("x"));
  assert.equal(h, "d=d-x; d-s=ds-x");
  assert.equal(
    slackCookieHeader(JSON.stringify({ cookies: [{ name: "d-s", value: "1", domain: ".slack.com" }] })),
    null,
    "no d ⇒ null",
  );
  assert.equal(slackCookieHeader("not json"), null);
  assert.equal(slackCookieHeader(JSON.stringify({})), null);
});

test("successful upload: mints a token from the cookie, POSTs emoji.add with mode/name/token/image", async () => {
  await withFallback(undefined, async () => {
    const store = memSessionStoreWith(ACTOR);
    const fake = fakeFetch({ add: { ok: true } });
    const res = await runEmojiUpload(buildDeps(store, fake.impl), REQ);
    assert.deepEqual(res, { ok: true, name: "partyparrot", workspace: WORKSPACE });
    assert.equal(fake.calls[0]!.url, `https://${WORKSPACE}/`);
    assert.match(fake.calls[0]!.cookie, /^d=d-U_ACTOR; d-s=ds-U_ACTOR$/);
    const add = fake.calls[1]!;
    assert.equal(add.url, `https://${WORKSPACE}/api/emoji.add`);
    assert.deepEqual(
      fake.calls.map((call) => call.redirect),
      ["manual", "manual"],
    );
    assert.equal(add.body!.get("mode"), "data");
    assert.equal(add.body!.get("name"), "partyparrot");
    assert.equal(add.body!.get("token"), TOKEN);
    const img = add.body!.get("image") as File;
    assert.equal(img.name, "partyparrot.png");
    assert.equal(img.type, "image/png");
  });
});

test("a GIF image is sent with a .gif filename and image/gif type", async () => {
  await withFallback(undefined, async () => {
    const fake = fakeFetch({ add: { ok: true } });
    const res = await runEmojiUpload(buildDeps(memSessionStoreWith(ACTOR), fake.impl), {
      name: "wave",
      imageBase64: GIF_B64,
    });
    assert.equal(res.ok, true);
    const img = fake.calls[1]!.body!.get("image") as File;
    assert.equal(img.name, "wave.gif");
    assert.equal(img.type, "image/gif");
  });
});

test("an explicit workspace overrides the connector workspace", async () => {
  await withFallback(undefined, async () => {
    const fake = fakeFetch({ add: { ok: true } });
    const res = await runEmojiUpload(buildDeps(memSessionStoreWith(ACTOR), fake.impl), {
      ...REQ,
      workspace: "https://other.slack.com/",
    });
    assert.deepEqual(res, { ok: true, name: "partyparrot", workspace: "other.slack.com" });
    assert.equal(fake.calls[0]!.url, "https://other.slack.com/");
    assert.equal(fake.calls[1]!.url, "https://other.slack.com/api/emoji.add");
  });
});

test("principal selection (a): actor has a session → uploads under the ACTOR's cookie", async () => {
  await withFallback(FALLBACK, async () => {
    const store = memSessionStoreWith(ACTOR, FALLBACK);
    const fake = fakeFetch({ add: { ok: true } });
    const res = await runEmojiUpload(buildDeps(store, fake.impl), REQ);
    assert.equal(res.ok, true);
    assert.match(fake.calls[0]!.cookie, /d=d-U_ACTOR/);
    assert.doesNotMatch(fake.calls[0]!.cookie, /FALLBACK/);
  });
});

test("principal selection (b): actor has no session but fallback seeded → uploads under the FALLBACK", async () => {
  await withFallback(FALLBACK, async () => {
    const store = memSessionStoreWith(FALLBACK);
    const fake = fakeFetch({ add: { ok: true } });
    const res = await runEmojiUpload(buildDeps(store, fake.impl), REQ);
    assert.equal(res.ok, true);
    assert.match(fake.calls[0]!.cookie, /d=d-U_FALLBACK/);
  });
});

test("principal selection (c): neither actor nor fallback → clear unavailable error, no network call", async () => {
  await withFallback(FALLBACK, async () => {
    const fake = fakeFetch({ add: { ok: true } });
    const res = await runEmojiUpload(buildDeps(memSessionStore(), fake.impl), REQ);
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /no Slack session for you/i);
    assert.equal(fake.calls.length, 0);
  });
});

test("no fallback configured + actor has no session → unavailable (does not borrow anyone)", async () => {
  await withFallback(undefined, async () => {
    const fake = fakeFetch({ add: { ok: true } });
    const res = await runEmojiUpload(buildDeps(memSessionStoreWith(FALLBACK), fake.impl), REQ);
    assert.equal(res.ok, false);
    assert.equal(fake.calls.length, 0);
  });
});

test("no workspace flag and no connector workspace → clear error, no network call", async () => {
  await withFallback(undefined, async () => {
    const fake = fakeFetch({ add: { ok: true } });
    const res = await runEmojiUpload(buildDeps(memSessionStoreWith(ACTOR), fake.impl, null), REQ);
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /no connected Slack workspace/i);
    assert.equal(fake.calls.length, 0);
  });
});

test("a stored session that can't mint a token (signed out) → session-expired, no emoji.add", async () => {
  await withFallback(undefined, async () => {
    const fake = fakeFetch({ token: null });
    const res = await runEmojiUpload(buildDeps(memSessionStoreWith(ACTOR), fake.impl), REQ);
    assert.equal(res.ok, false);
    assert.equal((res as { error: string }).error, EMOJI_UPLOAD_SESSION_EXPIRED);
    assert.equal(fake.calls.length, 1, "minted (and failed) but never called emoji.add");
  });
});

test("a stored session with no d cookie → session-expired before any network call", async () => {
  await withFallback(undefined, async () => {
    const store = memSessionStore();
    await store.put(ACTOR, JSON.stringify({ cookies: [{ name: "d-s", value: "x", domain: ".slack.com" }] }));
    const fake = fakeFetch({ add: { ok: true } });
    const res = await runEmojiUpload(buildDeps(store, fake.impl), REQ);
    assert.equal(res.ok, false);
    assert.equal((res as { error: string }).error, EMOJI_UPLOAD_SESSION_EXPIRED);
    assert.equal(fake.calls.length, 0);
  });
});

test("Slack auth error from emoji.add maps to session-expired", async () => {
  await withFallback(undefined, async () => {
    const fake = fakeFetch({ add: { ok: false, error: "token_expired" } });
    const res = await runEmojiUpload(buildDeps(memSessionStoreWith(ACTOR), fake.impl), REQ);
    assert.equal(res.ok, false);
    assert.equal((res as { error: string }).error, EMOJI_UPLOAD_SESSION_EXPIRED);
  });
});

test("error_name_taken is treated as success — the emoji already exists and is ready to use", async () => {
  await withFallback(undefined, async () => {
    const fake = fakeFetch({ add: { ok: false, error: "error_name_taken" } });
    const res = await runEmojiUpload(buildDeps(memSessionStoreWith(ACTOR), fake.impl), REQ);
    assert.deepEqual(res, { ok: true, name: "partyparrot", workspace: WORKSPACE });
  });
});

test("a too-large image error is surfaced with sizing guidance", async () => {
  await withFallback(undefined, async () => {
    const fake = fakeFetch({ add: { ok: false, error: "resized_but_still_too_large" } });
    const res = await runEmojiUpload(buildDeps(memSessionStoreWith(ACTOR), fake.impl), REQ);
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /too large|128/i);
  });
});

test("an invalid emoji name is rejected before any session lookup or network call", async () => {
  await withFallback(FALLBACK, async () => {
    const fake = fakeFetch({ add: { ok: true } });
    const res = await runEmojiUpload(buildDeps(memSessionStoreWith(ACTOR), fake.impl), {
      name: "Bad Name",
      imageBase64: PNG_B64,
    });
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /isn't a valid emoji name/);
    assert.equal(fake.calls.length, 0);
  });
});

test("an empty / non-base64 image is rejected before any network call", async () => {
  await withFallback(undefined, async () => {
    const fake = fakeFetch({ add: { ok: true } });
    const res = await runEmojiUpload(buildDeps(memSessionStoreWith(ACTOR), fake.impl), { name: "x", imageBase64: "" });
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /base64/i);
    assert.equal(fake.calls.length, 0);
  });
});

test("a network failure while minting the token is surfaced as a real result, not a throw", async () => {
  await withFallback(undefined, async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await runEmojiUpload(buildDeps(memSessionStoreWith(ACTOR), impl), REQ);
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /couldn't reach|ECONNREFUSED/i);
  });
});
