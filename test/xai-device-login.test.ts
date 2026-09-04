import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createXaiDeviceLoginStore,
  refreshXaiTokens,
  type StoredXaiDeviceLogin,
} from "../src/model/xai-device-login.ts";

const KEY = deriveConnectorKey("xai-device-login-test-material", "xai-device-login");

function deviceResponse(code = "device-secret", overrides: Record<string, unknown> = {}) {
  return Response.json({
    device_code: code,
    user_code: "ABCD-EFGH",
    verification_uri: "https://accounts.x.ai/oauth2/device",
    expires_in: 600,
    interval: 5,
    ...overrides,
  });
}

test("xAI device login is durable, encrypted, principal-bound, and interval-bound", async () => {
  let now = 1_000;
  const backing = createMemoryMap<StoredXaiDeviceLogin>();
  const requests: Array<{ url: string; body: URLSearchParams; init?: RequestInit }> = [];
  const responses = [
    deviceResponse(),
    Response.json({ error: "authorization_pending" }, { status: 400 }),
    Response.json({ error: "slow_down" }, { status: 400 }),
    Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
  ];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")), init });
    return responses.shift()!;
  }) as typeof fetch;
  const first = createXaiDeviceLoginStore({ backing, key: KEY, fetcher, now: () => now, id: () => "attempt-1" });
  const prompt = await first.start("alice");
  assert.deepEqual(prompt, {
    deviceAuthId: "attempt-1",
    userCode: "ABCD-EFGH",
    verificationUrl: "https://accounts.x.ai/oauth2/device",
    intervalMs: 5_000,
    expiresAt: 601_000,
  });
  const stored = await backing.get("alice");
  assert.equal(stored?.deviceAuthId, "attempt-1");
  assert.doesNotMatch(JSON.stringify(stored), /device-secret/);
  assert.equal((await first.poll("mallory", "attempt-1")).status, "expired");

  const restarted = createXaiDeviceLoginStore({ backing, key: KEY, fetcher, now: () => now });
  assert.deepEqual(await restarted.poll("alice", "attempt-1"), { status: "pending", intervalMs: 5_000 });
  assert.equal(requests.length, 1);
  now = 6_000;
  assert.deepEqual(await restarted.poll("alice", "attempt-1"), { status: "pending", intervalMs: 5_000 });
  now = 11_000;
  assert.deepEqual(await restarted.poll("alice", "attempt-1"), { status: "slow_down", intervalMs: 10_000 });
  now = 21_000;
  assert.deepEqual(await restarted.poll("alice", "attempt-1"), {
    status: "connected",
    tokens: { accessToken: "access", refreshToken: "refresh", expiresAt: 3_621_000 },
  });
  assert.equal(await backing.get("alice"), null);
  assert.equal(requests[0]?.url, "https://auth.x.ai/oauth2/device/code");
  assert.equal(requests[0]?.body.get("client_id"), "b1a00492-073a-47ea-816f-4c329264a828");
  assert.match(requests[0]?.body.get("scope") ?? "", /grok-cli:access/);
  assert.equal(requests[0]?.body.get("referrer"), "grok-build");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(requests[0]?.init?.redirect, "error");
  assert.equal(new Headers(requests[0]?.init?.headers).get("x-grok-client-version"), "1.0.13");
  assert.equal(new Headers(requests[0]?.init?.headers).get("x-grok-client-surface"), "ui");
  assert.equal(requests[1]?.url, "https://auth.x.ai/oauth2/token");
  assert.equal(requests[1]?.body.get("device_code"), "device-secret");
  assert.equal(requests[1]?.body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(requests[1]?.init?.redirect, "error");
  assert.equal(new Headers(requests[1]?.init?.headers).get("x-grok-client-version"), "1.0.13");
  assert.equal(new Headers(requests[1]?.init?.headers).get("x-grok-client-surface"), "ui");
});

test("xAI device login rejects unsafe verification URLs and bounds provider timing", async () => {
  const backing = createMemoryMap<StoredXaiDeviceLogin>();
  const responses = [
    deviceResponse("javascript", { verification_uri: "javascript:alert(1)" }),
    deviceResponse("cross-origin", { verification_uri_complete: "https://example.com/activate?code=ABCD" }),
    deviceResponse("legacy-origin", { verification_uri: "https://auth.x.ai/oauth2/device" }),
    deviceResponse("wrong-path", { verification_uri: "https://accounts.x.ai/activate" }),
    deviceResponse("wrong-query", {
      verification_uri_complete: "https://accounts.x.ai/oauth2/device?redirect=https%3A%2F%2Fevil.example",
    }),
    new Response("x".repeat(65_537)),
    deviceResponse("invalid-code", { user_code: "ABCD EFGH" }),
    deviceResponse("bounded", {
      verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
      expires_in: Number.MAX_VALUE,
      interval: Number.MAX_VALUE,
    }),
    deviceResponse("minimum", { interval: 0.001 }),
  ];
  const store = createXaiDeviceLoginStore({
    backing,
    key: KEY,
    fetcher: (async () => responses.shift()!) as typeof fetch,
    now: () => 1_000,
    id: () => "bounded",
  });

  await assert.rejects(store.start("alice"), /invalid verification URL/);
  await assert.rejects(store.start("alice"), /invalid verification URL/);
  await assert.rejects(store.start("alice"), /invalid verification URL/);
  await assert.rejects(store.start("alice"), /invalid verification URL/);
  await assert.rejects(store.start("alice"), /invalid verification URL/);
  await assert.rejects(store.start("alice"), /exceeds 65536 bytes/);
  await assert.rejects(store.start("alice"), /invalid user code/);
  assert.deepEqual(await store.start("alice"), {
    deviceAuthId: "bounded",
    userCode: "ABCD-EFGH",
    verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
    intervalMs: 60_000,
    expiresAt: 3_601_000,
  });
  assert.equal((await store.start("alice")).intervalMs, 1_000);
});

test("overlapping slow_down responses only increase the durable poll interval", async () => {
  let now = 0;
  let firstSlowDown!: (response: Response) => void;
  let secondSlowDown!: (response: Response) => void;
  const firstResponse = new Promise<Response>((resolve) => {
    firstSlowDown = resolve;
  });
  const secondResponse = new Promise<Response>((resolve) => {
    secondSlowDown = resolve;
  });
  let calls = 0;
  const backing = createMemoryMap<StoredXaiDeviceLogin>();
  const store = createXaiDeviceLoginStore({
    backing,
    key: KEY,
    fetcher: (async () => {
      calls++;
      if (calls === 1) return deviceResponse("overlap", { interval: 0.001 });
      return calls === 2 ? firstResponse : secondResponse;
    }) as typeof fetch,
    now: () => now,
    id: () => "attempt-overlap",
  });
  await store.start("alice");
  now = 1_000;
  const first = store.poll("alice", "attempt-overlap");
  while (calls < 2) await new Promise((resolve) => setImmediate(resolve));
  now = 2_000;
  const second = store.poll("alice", "attempt-overlap");
  while (calls < 3) await new Promise((resolve) => setImmediate(resolve));

  secondSlowDown(Response.json({ error: "slow_down" }, { status: 400 }));
  assert.deepEqual(await second, { status: "slow_down", intervalMs: 6_000 });
  firstSlowDown(Response.json({ error: "slow_down" }, { status: 400 }));
  assert.deepEqual(await first, { status: "slow_down", intervalMs: 11_000 });
  assert.deepEqual(await backing.get("alice"), {
    deviceAuthId: "attempt-overlap",
    deviceCodeEnc: (await backing.get("alice"))!.deviceCodeEnc,
    expiresAt: 600_000,
    intervalMs: 11_000,
    nextPollAt: 13_000,
  });
});

test("xAI device login handles denial and local/provider expiry without retaining state", async () => {
  let now = 0;
  const backing = createMemoryMap<StoredXaiDeviceLogin>();
  const responses = [
    deviceResponse("denied-secret"),
    Response.json({ error: "access_denied" }, { status: 400 }),
    deviceResponse("expired-secret"),
    Response.json({ error: "expired_token" }, { status: 400 }),
    Response.json({ ...((await deviceResponse("local-expiry").json()) as object), expires_in: 1 }),
  ];
  const store = createXaiDeviceLoginStore({
    backing,
    key: KEY,
    fetcher: (async () => responses.shift()!) as typeof fetch,
    now: () => now,
    id: (() => {
      let value = 0;
      return () => `attempt-${++value}`;
    })(),
  });

  await store.start("alice");
  now = 5_000;
  assert.deepEqual(await store.poll("alice", "attempt-1"), { status: "denied" });
  assert.equal(await backing.get("alice"), null);

  await store.start("alice");
  now = 10_000;
  assert.deepEqual(await store.poll("alice", "attempt-2"), { status: "expired" });
  assert.equal(await backing.get("alice"), null);

  await store.start("alice");
  now = 11_001;
  assert.deepEqual(await store.poll("alice", "attempt-3"), { status: "expired" });
  assert.equal(await backing.get("alice"), null);
});

test("xAI device login replaces one principal's attempt without affecting another principal", async () => {
  const backing = createMemoryMap<StoredXaiDeviceLogin>();
  const responses = [deviceResponse("alice-old"), deviceResponse("bob"), deviceResponse("alice-new")];
  const store = createXaiDeviceLoginStore({
    backing,
    key: KEY,
    fetcher: (async () => responses.shift()!) as typeof fetch,
    now: () => 0,
    id: (() => {
      let value = 0;
      return () => `attempt-${++value}`;
    })(),
  });

  const aliceOld = await store.start("alice");
  const bob = await store.start("bob");
  const aliceNew = await store.start("alice");

  assert.deepEqual(
    (await backing.entries()).map(([principal, login]) => [principal, login.deviceAuthId]),
    [
      ["alice", "attempt-3"],
      ["bob", "attempt-2"],
    ],
  );
  assert.deepEqual(await store.poll("alice", aliceOld.deviceAuthId), { status: "expired" });
  assert.deepEqual(await store.poll("bob", aliceNew.deviceAuthId), { status: "expired" });
  assert.deepEqual(await store.poll("alice", bob.deviceAuthId), { status: "expired" });
  assert.deepEqual(await store.poll("alice", aliceNew.deviceAuthId), { status: "pending", intervalMs: 5_000 });
  assert.deepEqual(await store.poll("bob", bob.deviceAuthId), { status: "pending", intervalMs: 5_000 });
  await store.cancel("alice", aliceNew.deviceAuthId);
  assert.equal(await backing.get("alice"), null);
  assert.equal((await backing.get("bob"))?.deviceAuthId, bob.deviceAuthId);
});

test("xAI refresh preserves or rotates refresh tokens and reports expiry", async () => {
  let response = Response.json({ access_token: "access-1", expires_in: 120 });
  let body = new URLSearchParams();
  let requestInit: RequestInit | undefined;
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = new URLSearchParams(String(init?.body ?? ""));
    requestInit = init;
    return response;
  }) as typeof fetch;
  assert.deepEqual(await refreshXaiTokens("refresh-0", fetcher, () => 10_000), {
    accessToken: "access-1",
    refreshToken: "refresh-0",
    expiresAt: 130_000,
  });
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "refresh-0");
  assert.equal(requestInit?.redirect, "error");
  assert.equal(new Headers(requestInit?.headers).get("x-grok-client-version"), "1.0.13");
  assert.equal(new Headers(requestInit?.headers).get("x-grok-client-surface"), "ui");
  response = Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 120 });
  assert.equal((await refreshXaiTokens("refresh-0", fetcher, () => 20_000)).refreshToken, "refresh-2");
  response = Response.json({ access_token: "access-3", expires_at: "2030-01-01T00:00:00.000Z" });
  assert.equal((await refreshXaiTokens("refresh-2", fetcher, () => 30_000)).expiresAt, 2_592_030_000);
  response = Response.json({ access_token: "access-4" });
  assert.equal((await refreshXaiTokens("refresh-2", fetcher, () => 40_000)).expiresAt, 2_592_040_000);
  response = Response.json({ access_token: "access-5", expires_in: Number.MAX_VALUE });
  assert.equal((await refreshXaiTokens("refresh-2", fetcher, () => 50_000)).expiresAt, 2_592_050_000);
  response = Response.json({ access_token: "access-6", expires_at: "1e308" });
  assert.equal((await refreshXaiTokens("refresh-2", fetcher, () => 60_000)).expiresAt, 2_592_060_000);
  response = new Response("x".repeat(65_537));
  await assert.rejects(
    refreshXaiTokens("refresh-2", fetcher, () => 70_000),
    /exceeds 65536 bytes/,
  );
});
