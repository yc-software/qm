import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemorableAccounts, type MemorableAccount, type PendingConnect } from "../src/memorable/accounts.ts";

const ORG = "org:acme";
const ME = "personal:U1";

type Call = { url: string; body: unknown };

function harness(responses: Array<{ status?: number; body: unknown } | Error>, opts: { now?: () => number } = {}) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
    const next = queue.shift();
    if (!next) throw new Error("no response queued");
    if (next instanceof Error) throw next;
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      json: async () => next.body,
    } as Response;
  }) as unknown as typeof fetch;

  const accounts = createMemoryMap<MemorableAccount>();
  const pending = createMemoryMap<PendingConnect>();
  const store = createMemorableAccounts(accounts, pending, {
    apiUrl: "https://api.test",
    orgScopeId: ORG,
    keyMaterial: "test-key-material-0123456789abcdef",
    fetchImpl,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { store, calls, accounts, pending };
}

const started = {
  device_code: "d".repeat(64),
  user_code: "ABCD-EFGH",
  verification_uri: "https://dash.test/device",
  verification_uri_complete: "https://dash.test/device?code=ABCD-EFGH",
  expires_in: 600,
  interval: 5,
};

const approved = {
  status: "approved",
  api_key: "mk_secret",
  key_id: "key_1",
  org_id: "org_abc",
  org_name: "Acme",
};

test("start opens a device authorization and remembers it against the scope", async () => {
  const { store, calls, pending } = harness([{ body: started }]);
  const result = await store.start(ME);
  assert.equal(result.status, "started");
  assert.equal(calls[0]?.url, "https://api.test/v1/device/code");
  assert.match(String((calls[0]?.body as { hostname?: string })?.hostname), /^qm personal [0-9a-f]{8}$/);
  assert.equal(JSON.stringify(calls[0]?.body).includes("U1"), false);
  if (result.status !== "started") throw new Error("unreachable");
  assert.equal(result.verificationUriComplete, started.verification_uri_complete);
  const stored = await pending.all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.scopeId, ME);
});

test("start does not re-open an authorization for an already connected scope", async () => {
  const { store, calls } = harness([{ body: started }, { body: approved }, { body: started }]);
  await store.start(ME);
  await store.poll(ME);
  const again = await store.start(ME);
  assert.equal(again.status, "already_connected");
  assert.equal(calls.length, 2);
});

test("start with force re-opens an authorization for a connected scope", async () => {
  const { store, calls } = harness([{ body: started }, { body: approved }, { body: started }]);
  await store.start(ME);
  await store.poll(ME);
  const again = await store.start(ME, { force: true });
  assert.equal(again.status, "started");
  assert.equal(calls.length, 3);
});

test("a sign-in service that cannot be reached stores nothing", async () => {
  const { store, pending } = harness([new Error("getaddrinfo ENOTFOUND")]);
  const result = await store.start(ME);
  assert.equal(result.status, "unavailable");
  assert.deepEqual(await pending.all(), []);
});

test("a response missing the code is refused rather than stored", async () => {
  const { store, pending } = harness([{ body: { user_code: "ABCD-EFGH" } }]);
  const result = await store.start(ME);
  assert.equal(result.status, "unavailable");
  assert.deepEqual(await pending.all(), []);
});

test("polling before approval returns the same code the human was given", async () => {
  const { store } = harness([{ body: started }, { body: { status: "pending" } }]);
  await store.start(ME);
  const result = await store.poll(ME);
  assert.equal(result.status, "pending");
  if (result.status !== "pending") throw new Error("unreachable");
  assert.equal(result.userCode, started.user_code);
});

test("approval stores the key against the scope and clears the pending code", async () => {
  const { store, accounts, pending } = harness([{ body: started }, { body: approved }]);
  await store.start(ME);
  const result = await store.poll(ME);
  assert.equal(result.status, "connected");
  assert.equal(await store.keyFor(ME), "mk_secret");
  assert.deepEqual(await pending.all(), []);
  const stored = await accounts.all();
  assert.equal(stored[0]?.orgName, "Acme");
});

test("a denied sign-in clears the pending code and leaves no key", async () => {
  const { store, pending } = harness([{ body: started }, { body: { status: "denied" } }]);
  await store.start(ME);
  assert.equal((await store.poll(ME)).status, "denied");
  assert.equal(await store.keyFor(ME), null);
  assert.deepEqual(await pending.all(), []);
});

test("a transient error from the token endpoint does not discard an approved code", async () => {
  const { store, pending } = harness([{ body: started }, { status: 502, body: {} }, { body: approved }]);
  await store.start(ME);
  assert.equal((await store.poll(ME)).status, "pending");
  assert.equal((await pending.all()).length, 1);
  assert.equal((await store.poll(ME)).status, "connected");
  assert.equal(await store.keyFor(ME), "mk_secret");
});

test("an expired window is cleared locally without asking the service", async () => {
  let now = 1_000;
  const { store, calls, pending } = harness([{ body: started }], { now: () => now });
  await store.start(ME);
  now += 601_000;
  assert.equal((await store.poll(ME)).status, "expired");
  assert.equal(calls.length, 1);
  assert.deepEqual(await pending.all(), []);
});

test("polling a scope that never started reports nothing rather than an error", async () => {
  const { store } = harness([]);
  assert.equal((await store.poll(ME)).status, "none");
});

test("a scope with no key of its own falls back to the org's", async () => {
  const { store } = harness([{ body: started }, { body: approved }]);
  await store.start(ORG);
  await store.poll(ORG);
  assert.equal(await store.keyFor("personal:U9"), "mk_secret");
  assert.equal(await store.keyFor("channel:C1"), "mk_secret");
});

test("a scope's own key wins over the org's", async () => {
  const { store } = harness([
    { body: started },
    { body: approved },
    { body: started },
    { body: { ...approved, api_key: "mk_mine", org_name: "Mine" } },
  ]);
  await store.start(ORG);
  await store.poll(ORG);
  await store.start(ME);
  await store.poll(ME);
  assert.equal(await store.keyFor(ME), "mk_mine");
  assert.equal(await store.keyFor("personal:U9"), "mk_secret");
});

test("nothing connected anywhere resolves to no key at all", async () => {
  const { store } = harness([]);
  assert.equal(await store.keyFor(ME), null);
  assert.equal(await store.keyFor(ORG), null);
});

test("disconnect removes the key and any authorization still in flight", async () => {
  const { store, pending } = harness([{ body: started }, { body: approved }, { body: started }]);
  await store.start(ME);
  await store.poll(ME);
  await store.start(ME, { force: true });
  assert.equal(await store.disconnect(ME), true);
  assert.equal(await store.keyFor(ME), null);
  assert.deepEqual(await pending.all(), []);
  assert.equal(await store.disconnect(ME), false);
});

test("listing connected accounts never carries a key", async () => {
  const { store } = harness([{ body: started }, { body: approved }]);
  await store.start(ME);
  await store.poll(ME);
  const listed = await store.connected();
  assert.equal(listed.length, 1);
  assert.equal(Object.hasOwn(listed[0] ?? {}, "apiKeyEnc"), false);
  assert.equal(JSON.stringify(listed).includes("mk_secret"), false);
});

test("a scope id that is not storage-safe still round-trips", async () => {
  const odd = "channel:C/1 with spaces";
  const { store } = harness([{ body: started }, { body: approved }]);
  await store.start(odd);
  await store.poll(odd);
  assert.equal(await store.keyFor(odd), "mk_secret");
});

test("the stored row never carries the key in the clear", async () => {
  const { store, accounts } = harness([{ body: started }, { body: approved }]);
  await store.start(ME);
  await store.poll(ME);
  assert.equal(JSON.stringify(await accounts.all()).includes("mk_secret"), false);
});

test("a row written under different key material reads as no key, not a crash", async () => {
  const { store, accounts } = harness([{ body: started }, { body: approved }]);
  await store.start(ME);
  await store.poll(ME);
  const rows = await accounts.entries();
  const [id, row] = rows[0] ?? [];
  assert.ok(id && row);
  await accounts.put(id, { ...row, apiKeyEnc: "v2:aaaa:bbbb:cccc" });
  assert.equal(await store.keyFor(ME), null);
});
