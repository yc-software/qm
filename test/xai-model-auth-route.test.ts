import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";

const SECRET = "xai-model-auth-route-secret".repeat(3);

function headers(method: string, path: string, body: string, principal = "alice"): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(timestamp),
    "x-signature": signRequest(SECRET, timestamp, `${method}\n${path}\n${body}`),
    [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: principal, exp: Date.now() + 60_000 }, SECRET),
  };
}

test("Grok device routes bind pending state to the caller and never return token material", async () => {
  const responses = [
    Response.json({
      device_code: "device-secret",
      user_code: "ABCD-EFGH",
      verification_uri: "https://accounts.x.ai/oauth2/device",
      expires_in: 600,
      interval: 0.001,
    }),
    Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 1 }),
    Response.json({ access_token: "refreshed-access", refresh_token: "rotated-refresh", expires_in: 3600 }),
  ];
  const oauthRequests: Array<{ url: string; body: string }> = [];
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "xai-model-auth-route-")) }), {
    xaiOAuthFetch: (async (input: string | URL | Request, init?: RequestInit) => {
      oauthRequests.push({ url: String(input), body: String(init?.body ?? "") });
      return responses.shift()!;
    }) as typeof fetch,
  });
  const server = createServer(built.app, {
    signingSecret: SECRET,
    portalIdentitySecret: SECRET,
    identity: built.identity,
    userModelCredentials: built.userModelCredentials,
    xaiDeviceLogins: built.xaiDeviceLogins,
    advisoryLock: built.advisoryLock,
    config: built.config,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const startPath = "/v1/user-model-auth/grok/start";
    const startBody = JSON.stringify({ principalId: "alice" });
    const started = await fetch(base + startPath, {
      method: "POST",
      headers: headers("POST", startPath, startBody),
      body: startBody,
    });
    assert.equal(started.status, 200);
    const startedText = await started.text();
    assert.doesNotMatch(startedText, /device-secret|access-secret|refresh-secret/);
    const prompt = JSON.parse(startedText) as { deviceAuthId: string; verificationUrl: string };
    assert.equal(prompt.verificationUrl, "https://accounts.x.ai/oauth2/device");

    const pollPath = "/v1/user-model-auth/grok/poll";
    const strangerBody = JSON.stringify({ principalId: "mallory", deviceAuthId: prompt.deviceAuthId });
    const stranger = await fetch(base + pollPath, {
      method: "POST",
      headers: headers("POST", pollPath, strangerBody, "mallory"),
      body: strangerBody,
    });
    assert.deepEqual(await stranger.json(), { status: "expired" });

    await new Promise((resolve) => setTimeout(resolve, 1_005));
    const pollBody = JSON.stringify({ principalId: "alice", deviceAuthId: prompt.deviceAuthId });
    const connected = await fetch(base + pollPath, {
      method: "POST",
      headers: headers("POST", pollPath, pollBody),
      body: pollBody,
    });
    assert.equal(connected.status, 200);
    assert.deepEqual(await connected.json(), { status: "connected" });
    const derived = await built.userModelCredentials.derivedOAuth("alice", "xai");
    assert.equal(derived?.accessToken, "refreshed-access");
    assert.ok(!("refreshToken" in (derived ?? {})));
    assert.equal(oauthRequests[2]?.url, "https://auth.x.ai/oauth2/token");
    assert.equal(new URLSearchParams(oauthRequests[2]?.body).get("refresh_token"), "refresh-secret");
    assert.deepEqual(await built.userModelCredentials.connections("alice"), [{ provider: "xai", kind: "oauth" }]);

    const statusPath = "/v1/user-model-auth/status?principalId=alice";
    const status = await fetch(base + statusPath, { headers: headers("GET", statusPath, "") });
    const statusText = await status.text();
    assert.doesNotMatch(statusText, /access-secret|refresh-secret|device-secret/);
    assert.match(statusText, /"provider":"xai"/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("disconnect wins when a Grok device token response is in flight", async () => {
  let pollStarted!: () => void;
  let finishPoll!: () => void;
  const started = new Promise<void>((resolve) => {
    pollStarted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishPoll = resolve;
  });
  let calls = 0;
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "xai-model-auth-race-")) }), {
    xaiOAuthFetch: (async () => {
      calls++;
      if (calls === 1)
        return Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://accounts.x.ai/oauth2/device",
          expires_in: 600,
          interval: 0.001,
        });
      pollStarted();
      await finish;
      return Response.json({ access_token: "late-access", refresh_token: "late-refresh", expires_in: 3600 });
    }) as typeof fetch,
  });
  const deps = {
    signingSecret: SECRET,
    portalIdentitySecret: SECRET,
    identity: built.identity,
    userModelCredentials: built.userModelCredentials,
    xaiDeviceLogins: built.xaiDeviceLogins,
    advisoryLock: built.advisoryLock,
    config: built.config,
    auditLog: built.auditLog,
  };
  const server = createServer(built.app, deps);
  const otherServer = createServer(built.app, deps);
  server.listen(0);
  otherServer.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const otherBase = `http://localhost:${(otherServer.address() as AddressInfo).port}`;
  try {
    const startPath = "/v1/user-model-auth/grok/start";
    const startBody = "{}";
    const start = await fetch(base + startPath, {
      method: "POST",
      headers: headers("POST", startPath, startBody),
      body: startBody,
    });
    const prompt = (await start.json()) as { deviceAuthId: string };
    await new Promise((resolve) => setTimeout(resolve, 1_005));

    const pollPath = "/v1/user-model-auth/grok/poll";
    const pollBody = JSON.stringify({ deviceAuthId: prompt.deviceAuthId });
    const polling = fetch(base + pollPath, {
      method: "POST",
      headers: headers("POST", pollPath, pollBody),
      body: pollBody,
    });
    await started;

    const disconnectPath = "/v1/user-model-auth/disconnect";
    const disconnectBody = JSON.stringify({ provider: "grok" });
    const disconnected = await fetch(otherBase + disconnectPath, {
      method: "POST",
      headers: headers("POST", disconnectPath, disconnectBody),
      body: disconnectBody,
    });
    assert.equal(disconnected.status, 200);
    finishPoll();

    assert.deepEqual(await (await polling).json(), { status: "expired" });
    assert.equal(await built.userModelCredentials.derivedOAuth("alice", "xai"), null);
    assert.deepEqual(await built.userModelCredentials.connections("alice"), []);
  } finally {
    finishPoll();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => otherServer.close(() => resolve())),
    ]);
  }
});

test("a fleet lock orders Grok start before a cross-instance disconnect", async () => {
  let startReached!: () => void;
  const atStart = new Promise<void>((resolve) => {
    startReached = resolve;
  });
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "xai-model-auth-start-race-")) }), {
    xaiOAuthFetch: (async () => {
      startReached();
      await startGate;
      return Response.json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.x.ai/oauth2/device",
        expires_in: 600,
        interval: 1,
      });
    }) as typeof fetch,
  });
  let lockCalls = 0;
  let secondLockReached!: () => void;
  const atSecondLock = new Promise<void>((resolve) => {
    secondLockReached = resolve;
  });
  const advisoryLock = {
    withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      lockCalls++;
      if (lockCalls === 2) secondLockReached();
      return built.advisoryLock.withLock(key, fn);
    },
  };
  const deps = {
    signingSecret: SECRET,
    portalIdentitySecret: SECRET,
    identity: built.identity,
    userModelCredentials: built.userModelCredentials,
    xaiDeviceLogins: built.xaiDeviceLogins,
    advisoryLock,
    config: built.config,
    auditLog: built.auditLog,
  };
  const startServer = createServer(built.app, deps);
  const disconnectServer = createServer(built.app, deps);
  startServer.listen(0);
  disconnectServer.listen(0);
  const startBase = `http://localhost:${(startServer.address() as AddressInfo).port}`;
  const disconnectBase = `http://localhost:${(disconnectServer.address() as AddressInfo).port}`;
  try {
    const startPath = "/v1/user-model-auth/grok/start";
    const startBody = "{}";
    const starting = fetch(startBase + startPath, {
      method: "POST",
      headers: headers("POST", startPath, startBody),
      body: startBody,
    });
    await atStart;

    const disconnectPath = "/v1/user-model-auth/disconnect";
    const disconnectBody = JSON.stringify({ provider: "grok" });
    let disconnected = false;
    const disconnecting = fetch(disconnectBase + disconnectPath, {
      method: "POST",
      headers: headers("POST", disconnectPath, disconnectBody),
      body: disconnectBody,
    }).then((response) => {
      disconnected = true;
      return response;
    });
    await atSecondLock;
    assert.equal(disconnected, false);

    releaseStart();
    const startResponse = await starting;
    const prompt = (await startResponse.json()) as { deviceAuthId: string };
    assert.equal(startResponse.status, 200);
    assert.equal((await disconnecting).status, 200);

    const pollPath = "/v1/user-model-auth/grok/poll";
    const pollBody = JSON.stringify({ deviceAuthId: prompt.deviceAuthId });
    const poll = await fetch(startBase + pollPath, {
      method: "POST",
      headers: headers("POST", pollPath, pollBody),
      body: pollBody,
    });
    assert.deepEqual(await poll.json(), { status: "expired" });
    assert.deepEqual(await built.userModelCredentials.connections("alice"), []);
  } finally {
    releaseStart();
    await Promise.all([
      new Promise<void>((resolve) => startServer.close(() => resolve())),
      new Promise<void>((resolve) => disconnectServer.close(() => resolve())),
    ]);
  }
});

test("a fleet lock keeps concurrent Grok attempts aligned across stores", async () => {
  let firstStartReached!: () => void;
  const atFirstStart = new Promise<void>((resolve) => {
    firstStartReached = resolve;
  });
  let releaseFirstStart!: () => void;
  const firstStartGate = new Promise<void>((resolve) => {
    releaseFirstStart = resolve;
  });
  let providerCalls = 0;
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "xai-model-auth-concurrent-")) }), {
    xaiOAuthFetch: (async () => {
      providerCalls++;
      if (providerCalls === 1) {
        firstStartReached();
        await firstStartGate;
      }
      return Response.json({
        device_code: `device-${providerCalls}`,
        user_code: providerCalls === 1 ? "ABCD-EFGH" : "IJKL-MNOP",
        verification_uri: "https://accounts.x.ai/oauth2/device",
        expires_in: 600,
        interval: 1,
      });
    }) as typeof fetch,
  });
  let lockCalls = 0;
  let secondLockReached!: () => void;
  const atSecondLock = new Promise<void>((resolve) => {
    secondLockReached = resolve;
  });
  const advisoryLock = {
    withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      lockCalls++;
      if (lockCalls === 2) secondLockReached();
      return built.advisoryLock.withLock(key, fn);
    },
  };
  const deps = {
    signingSecret: SECRET,
    portalIdentitySecret: SECRET,
    identity: built.identity,
    userModelCredentials: built.userModelCredentials,
    xaiDeviceLogins: built.xaiDeviceLogins,
    advisoryLock,
    config: built.config,
    auditLog: built.auditLog,
  };
  const firstServer = createServer(built.app, deps);
  const secondServer = createServer(built.app, deps);
  firstServer.listen(0);
  secondServer.listen(0);
  const firstBase = `http://localhost:${(firstServer.address() as AddressInfo).port}`;
  const secondBase = `http://localhost:${(secondServer.address() as AddressInfo).port}`;
  try {
    const path = "/v1/user-model-auth/grok/start";
    const body = "{}";
    const first = fetch(firstBase + path, { method: "POST", headers: headers("POST", path, body), body });
    await atFirstStart;
    const second = fetch(secondBase + path, { method: "POST", headers: headers("POST", path, body), body });
    await atSecondLock;
    assert.equal(providerCalls, 1);

    releaseFirstStart();
    const firstPrompt = (await (await first).json()) as { deviceAuthId: string };
    const secondPrompt = (await (await second).json()) as { deviceAuthId: string };
    assert.equal(providerCalls, 2);
    assert.notEqual(firstPrompt.deviceAuthId, secondPrompt.deviceAuthId);

    const pollPath = "/v1/user-model-auth/grok/poll";
    const firstPollBody = JSON.stringify({ deviceAuthId: firstPrompt.deviceAuthId });
    const firstPoll = await fetch(firstBase + pollPath, {
      method: "POST",
      headers: headers("POST", pollPath, firstPollBody),
      body: firstPollBody,
    });
    assert.deepEqual(await firstPoll.json(), { status: "expired" });
    const secondPollBody = JSON.stringify({ deviceAuthId: secondPrompt.deviceAuthId });
    const secondPoll = await fetch(secondBase + pollPath, {
      method: "POST",
      headers: headers("POST", pollPath, secondPollBody),
      body: secondPollBody,
    });
    const secondStatus = (await secondPoll.json()) as { status: string };
    assert.equal(secondStatus.status, "pending");
  } finally {
    releaseFirstStart();
    await Promise.all([
      new Promise<void>((resolve) => firstServer.close(() => resolve())),
      new Promise<void>((resolve) => secondServer.close(() => resolve())),
    ]);
  }
});

test("a cross-instance xAI API key replacement waits for OAuth finalization and wins", async () => {
  let finishFinalization!: () => void;
  const finalizationGate = new Promise<void>((resolve) => {
    finishFinalization = resolve;
  });
  let finalizationReached!: () => void;
  const atFinalization = new Promise<void>((resolve) => {
    finalizationReached = resolve;
  });
  let oauthCalls = 0;
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "xai-model-auth-api-race-")) }), {
    xaiOAuthFetch: (async () => {
      oauthCalls++;
      if (oauthCalls === 1)
        return Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://accounts.x.ai/oauth2/device",
          expires_in: 600,
          interval: 0.001,
        });
      return Response.json({ access_token: "oauth-access", refresh_token: "oauth-refresh", expires_in: 3_600 });
    }) as typeof fetch,
  });
  const originalSetOAuthIfPending = built.userModelCredentials.setOAuthIfPending.bind(built.userModelCredentials);
  const gatedCredentials = {
    ...built.userModelCredentials,
    async setOAuthIfPending(...args: Parameters<typeof originalSetOAuthIfPending>) {
      finalizationReached();
      await finalizationGate;
      return originalSetOAuthIfPending(...args);
    },
  };
  let lockCalls = 0;
  let thirdLockReached!: () => void;
  const atThirdLock = new Promise<void>((resolve) => {
    thirdLockReached = resolve;
  });
  const advisoryLock = {
    withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      lockCalls++;
      if (lockCalls === 3) thirdLockReached();
      return built.advisoryLock.withLock(key, fn);
    },
  };
  const common = {
    signingSecret: SECRET,
    portalIdentitySecret: SECRET,
    identity: built.identity,
    xaiDeviceLogins: built.xaiDeviceLogins,
    advisoryLock,
    config: built.config,
    auditLog: built.auditLog,
    modelCredentialFetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
  };
  const pollServer = createServer(built.app, { ...common, userModelCredentials: gatedCredentials });
  const apiServer = createServer(built.app, { ...common, userModelCredentials: built.userModelCredentials });
  pollServer.listen(0);
  apiServer.listen(0);
  const pollBase = `http://localhost:${(pollServer.address() as AddressInfo).port}`;
  const apiBase = `http://localhost:${(apiServer.address() as AddressInfo).port}`;
  try {
    const startPath = "/v1/user-model-auth/grok/start";
    const startBody = "{}";
    const start = await fetch(pollBase + startPath, {
      method: "POST",
      headers: headers("POST", startPath, startBody),
      body: startBody,
    });
    const prompt = (await start.json()) as { deviceAuthId: string };
    await new Promise((resolve) => setTimeout(resolve, 1_005));

    const pollPath = "/v1/user-model-auth/grok/poll";
    const pollBody = JSON.stringify({ deviceAuthId: prompt.deviceAuthId });
    const polling = fetch(pollBase + pollPath, {
      method: "POST",
      headers: headers("POST", pollPath, pollBody),
      body: pollBody,
    });
    await atFinalization;

    const apiPath = "/v1/user-model-auth/api-key";
    const apiBody = JSON.stringify({ provider: "grok", apiKey: "xai-api-key" });
    let apiCompleted = false;
    const replacing = fetch(apiBase + apiPath, {
      method: "POST",
      headers: headers("POST", apiPath, apiBody),
      body: apiBody,
    }).then((response) => {
      apiCompleted = true;
      return response;
    });
    await atThirdLock;
    assert.equal(apiCompleted, false);

    finishFinalization();
    assert.deepEqual(await (await polling).json(), { status: "connected" });
    assert.equal((await replacing).status, 200);
    const credential = await built.userModelCredentials.get("alice", "xai");
    assert.equal(credential?.kind, "apikey");
    assert.equal(credential?.apiKey, "xai-api-key");
    assert.equal(await built.userModelCredentials.derivedOAuth("alice", "xai"), null);
  } finally {
    finishFinalization();
    await Promise.all([
      new Promise<void>((resolve) => pollServer.close(() => resolve())),
      new Promise<void>((resolve) => apiServer.close(() => resolve())),
    ]);
  }
});
