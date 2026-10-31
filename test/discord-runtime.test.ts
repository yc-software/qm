import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDiscordRuntimeConfig } from "../src/surfaces/discord-installation.ts";
import { createSurfaceRuntimeReconciler } from "../src/surfaces/surface-runtime.ts";

const store = (stored: unknown) => ({ get: async () => stored as never });

test("a stored installation is the only config source", async () => {
  const got = await loadDiscordRuntimeConfig(
    store({
      botToken: "db",
      botUserId: "1",
      botTag: "b",
      applicationId: "1",
      oauthClientSecret: null,
      guildIds: [],
      internalRoleIds: [],
      version: "v7",
    }),
  );
  assert.equal(got!.version, "v7");
  assert.equal(got!.config.botToken, "db");
  assert.equal(await loadDiscordRuntimeConfig(store(null)), null);
});

test("stop with slow plugin stop, then start while stopping, then let stop settle restarts plugin", async () => {
  let starts = 0;
  const stopSlow = Promise.withResolvers<void>();
  const runtime = createSurfaceRuntimeReconciler({
    load: async () => ({ version: "1", config: { botToken: "tok" } }),
    startPlugin: async () => {
      starts++;
      return {
        stop: async () => {
          await stopSlow.promise;
        },
      };
    },
  });

  runtime.start();
  await runtime.reconcile();
  assert.equal(starts, 1);

  const stopping = runtime.stop();
  runtime.start();
  stopSlow.resolve();
  await stopping;
  await runtime.reconcile();
  assert.equal(starts, 2);

  await runtime.stop();
});

test("stop, start, stop while stopping leaves plugin stopped", async () => {
  let starts = 0;
  const stopSlow = Promise.withResolvers<void>();
  const runtime = createSurfaceRuntimeReconciler({
    load: async () => ({ version: "1", config: { botToken: "tok" } }),
    startPlugin: async () => {
      starts++;
      return {
        stop: async () => {
          await stopSlow.promise;
        },
      };
    },
  });

  runtime.start();
  await runtime.reconcile();
  assert.equal(starts, 1);

  const stopping = runtime.stop();
  runtime.start();
  runtime.stop();
  stopSlow.resolve();
  await stopping;
  await runtime.reconcile();
  assert.equal(starts, 1);
});

test("start while stopping restarts plugin immediately when reconcile is called", async () => {
  let starts = 0;
  const stopSlow = Promise.withResolvers<void>();
  const runtime = createSurfaceRuntimeReconciler({
    load: async () => ({ version: "1", config: { botToken: "tok" } }),
    startPlugin: async () => {
      starts++;
      return {
        stop: async () => {
          await stopSlow.promise;
        },
      };
    },
  });

  runtime.start();
  await runtime.reconcile();
  assert.equal(starts, 1);

  const stopping = runtime.stop();
  runtime.start();
  stopSlow.resolve();
  await runtime.reconcile();
  assert.equal(starts, 2);

  await stopping;
  await runtime.stop();
});

test("start while stopping restarts plugin via setImmediate when reconcile is not called", async () => {
  let starts = 0;
  const stopSlow = Promise.withResolvers<void>();
  const runtime = createSurfaceRuntimeReconciler({
    load: async () => ({ version: "1", config: { botToken: "tok" } }),
    startPlugin: async () => {
      starts++;
      return {
        stop: async () => {
          await stopSlow.promise;
        },
      };
    },
  });

  runtime.start();
  await runtime.reconcile();
  assert.equal(starts, 1);

  const stopping = runtime.stop();
  runtime.start();
  stopSlow.resolve();
  await stopping;
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(starts, 2);

  await runtime.stop();
});

test("Discord env vars do not configure the surface when no installation is stored", async () => {
  const keys = ["DISCORD_BOT_TOKEN", "DISCORD_BOT_USER_ID", "DISCORD_APPLICATION_ID", "DISCORD_ENABLED"];
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) process.env[k] = "1";
  try {
    assert.equal(await loadDiscordRuntimeConfig(store(null)), null);
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
});
