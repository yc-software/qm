import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDiscordInstallationStore,
  discordLinkRedirectUri,
  discordPluginConfigFromInstallation,
  DiscordInstallationError,
  parseDiscordSettings,
  type StoredDiscordInstallation,
  validateDiscordToken,
} from "../src/surfaces/discord-installation.ts";
import { testMap } from "./support/test-database.ts";

const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.SECRET.TOKENVALUE";
const CLIENT_SECRET = "oauth-client-SECRET-value";
const BOT = { token: TOKEN, userId: "123456789012345678", tag: "qm#1", applicationId: "123456789012345678" };
const settings = {
  guildIds: [],
  internalRoleIds: [],
};

test("the token and the OAuth client secret are encrypted at rest and absent from status", async () => {
  const map = testMap<unknown>();
  const store = createDiscordInstallationStore("acme", map as never, "k");
  const status = await store.set({ ...settings, bot: BOT, oauthClientSecret: CLIENT_SECRET, updatedBy: "admin" });
  for (const secret of [TOKEN, CLIENT_SECRET]) {
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.equal(JSON.stringify(await map.entries()).includes(secret), false);
  }
  assert.equal(status.oauthConfigured, true);
  const got = (await store.get())!;
  assert.equal(got.botToken, TOKEN);
  assert.equal(got.oauthClientSecret, CLIENT_SECRET);
});

test("parseDiscordSettings carries no per-delivery toggle", () => {
  assert.equal("principalDeliveries" in parseDiscordSettings({ principalDeliveries: false }), false);
});

test("parseDiscordSettings rejects when internalRoleIds contains a guild id", () => {
  assert.throws(
    () =>
      parseDiscordSettings({
        guildIds: ["123456789012345678"],
        internalRoleIds: ["123456789012345678"],
      }),
    (err: Error) => {
      assert.ok(err instanceof DiscordInstallationError);
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test("updating settings without a token keeps the stored token", async () => {
  const store = createDiscordInstallationStore("acme", testMap() as never, "k");
  await store.set({ ...settings, bot: BOT, updatedBy: "a" });
  await store.set({ ...settings, guildIds: ["900000000000000000"], updatedBy: "a" });
  const got = (await store.get())!;
  assert.equal(got.botToken, TOKEN);
  assert.deepEqual(got.guildIds, ["900000000000000000"]);
});

test("a first save without a token is refused", async () => {
  const store = createDiscordInstallationStore("acme", testMap() as never, "k");
  await assert.rejects(store.set({ ...settings, updatedBy: "a" }), /bot token is required/);
});

test("delete removes the installation", async () => {
  const store = createDiscordInstallationStore("acme", testMap() as never, "k");
  await store.set({ ...settings, bot: BOT, updatedBy: "a" });
  await store.delete();
  assert.equal(await store.get(), null);
  assert.equal((await store.status()).configured, false);
});

test("settings-only set fails if the record vanished before the update", async () => {
  const map = testMap<StoredDiscordInstallation>();
  const store = createDiscordInstallationStore("acme", map, "k");
  await store.set({ ...settings, bot: BOT, updatedBy: "a" });
  const realUpdate = map.update!.bind(map);
  map.update = (async (id: string, fn: (v: StoredDiscordInstallation | null) => StoredDiscordInstallation) => {
    await map.delete(id);
    return realUpdate(id, fn as never);
  }) as never;
  await assert.rejects(store.set({ ...settings, updatedBy: "a" }), /disappeared during update/);
});

test("a first set where update rejects leaves the record in place", async () => {
  const map = testMap<StoredDiscordInstallation>();
  map.update = (async () => {
    throw new Error("db failure during update");
  }) as never;
  const store = createDiscordInstallationStore("acme", map, "k");
  await assert.rejects(store.set({ ...settings, bot: BOT, updatedBy: "a" }), /db failure during update/);
  assert.equal((await store.status()).configured, true);
});

test("a set without client secret reports oauthConfigured false", async () => {
  const store = createDiscordInstallationStore("acme", testMap() as never, "k");
  const status = await store.set({ ...settings, bot: BOT, updatedBy: "a" });
  assert.equal(status.oauthConfigured, false);
});

test("changing application id drops stored oauth client secret", async () => {
  const store = createDiscordInstallationStore("acme", testMap() as never, "k");
  await store.set({ ...settings, bot: BOT, oauthClientSecret: CLIENT_SECRET, updatedBy: "a" });
  assert.equal((await store.status()).oauthConfigured, true);
  const bot2 = { ...BOT, applicationId: "different-app-id" };
  const status = await store.set({ ...settings, bot: bot2, updatedBy: "a" });
  assert.equal(status.oauthConfigured, false);
  const got = await store.get();
  assert.equal(got?.oauthClientSecret, null);
});

test("keeping application id keeps stored oauth client secret", async () => {
  const store = createDiscordInstallationStore("acme", testMap() as never, "k");
  await store.set({ ...settings, bot: BOT, oauthClientSecret: CLIENT_SECRET, updatedBy: "a" });
  assert.equal((await store.status()).oauthConfigured, true);
  const botSameApp = { ...BOT, tag: "qm#2" };
  const status = await store.set({ ...settings, bot: botSameApp, updatedBy: "a" });
  assert.equal(status.oauthConfigured, true);
  const got = await store.get();
  assert.equal(got?.oauthClientSecret, CLIENT_SECRET);
});

test("settings reject non-snowflake ids", () => {
  assert.throws(() => parseDiscordSettings({ ...settings, guildIds: ["abc"] }), /Discord id/);
});

test("settings reject numeric ids with 400", () => {
  const parsed = JSON.parse('{"guildIds": [123456789012345678]}') as { guildIds: unknown[] };
  assert.throws(
    () => parseDiscordSettings({ ...settings, guildIds: parsed.guildIds }),
    (err: unknown) => err instanceof DiscordInstallationError && err.status === 400,
  );
});

test("validateDiscordToken maps 401 and 403 to 400 with fixed message without leaking token", async () => {
  for (const status of [401, 403]) {
    const fetchImpl = (async () => new Response("{}", { status })) as typeof fetch;
    await assert.rejects(validateDiscordToken(TOKEN, fetchImpl), (err: Error) => {
      assert.ok(err instanceof DiscordInstallationError);
      assert.equal(err.status, 400);
      assert.equal(err.message, "Discord rejected the bot token");
      assert.equal(err.message.includes(TOKEN), false);
      return true;
    });
  }
});

test("validateDiscordToken maps 429 and 5xx to 502 without leaking token", async () => {
  for (const status of [429, 500, 502, 503]) {
    const fetchImpl = (async () => new Response("{}", { status })) as typeof fetch;
    await assert.rejects(validateDiscordToken(TOKEN, fetchImpl), (err: Error) => {
      assert.ok(err instanceof DiscordInstallationError);
      assert.equal(err.status, 502);
      assert.equal(err.message, "Discord did not answer. Try again in a minute.");
      assert.equal(err.message.includes(TOKEN), false);
      return true;
    });
  }
});

test("validateDiscordToken maps 200 with non-JSON body to 502 without leaking token", async () => {
  const fetchImpl = (async () => new Response("<html>Bad Gateway</html>", { status: 200 })) as typeof fetch;
  await assert.rejects(validateDiscordToken(TOKEN, fetchImpl), (err: Error) => {
    assert.ok(err instanceof DiscordInstallationError);
    assert.equal(err.status, 502);
    assert.equal(err.message.includes(TOKEN), false);
    return true;
  });
});

test("validateDiscordToken maps 200 with malformed body to 502 without leaking token", async () => {
  const fetchImpl = (async (u: string) => {
    return new URL(u).pathname.endsWith("/applications/@me")
      ? Response.json({ id: null })
      : Response.json({ id: "42", username: "qm" });
  }) as unknown as typeof fetch;
  await assert.rejects(validateDiscordToken(TOKEN, fetchImpl), (err: Error) => {
    assert.ok(err instanceof DiscordInstallationError);
    assert.equal(err.status, 502);
    assert.equal(err.message.includes(TOKEN), false);
    return true;
  });
});

test("a valid token returns the bot identity and the application id", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (u: string, init: RequestInit) => {
    seen.push(`${new URL(u).pathname} ${String((init.headers as Record<string, string>).Authorization)}`);
    return new URL(u).pathname.endsWith("/applications/@me")
      ? Response.json({ id: "4242" })
      : Response.json({ id: "42", username: "qm", discriminator: "0" });
  }) as unknown as typeof fetch;
  assert.deepEqual(await validateDiscordToken(TOKEN, fetchImpl), { userId: "42", tag: "qm", applicationId: "4242" });
  assert.deepEqual(seen, [`/api/v10/users/@me Bot ${TOKEN}`, `/api/v10/oauth2/applications/@me Bot ${TOKEN}`]);
});

test("validateDiscordToken fails closed on timeout or network error without leaking token", async () => {
  let seenSignal: unknown;
  let seenRedirect: unknown;
  const timeoutFetch = (async (_u: string, init?: RequestInit) => {
    seenSignal = init?.signal;
    seenRedirect = init?.redirect;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }) as unknown as typeof fetch;
  await assert.rejects(validateDiscordToken(TOKEN, timeoutFetch), (err: Error) => {
    assert.ok(err instanceof DiscordInstallationError);
    assert.equal(err.status, 502);
    assert.equal(err.message.includes(TOKEN), false);
    return true;
  });
  assert.ok(seenSignal instanceof AbortSignal);
  assert.equal(seenRedirect, "error");
});

test("discordLinkRedirectUri formats portal redirect URL", () => {
  assert.equal(discordLinkRedirectUri("https://portal.example.com"), "https://portal.example.com/settings");
  assert.equal(discordLinkRedirectUri("https://portal.example.com///"), "https://portal.example.com/settings");
});

test("discordPluginConfigFromInstallation maps installation fields", () => {
  const cfg = discordPluginConfigFromInstallation({
    botToken: TOKEN,
    botUserId: "123456789012345678",
    botTag: "qm#0",
    applicationId: "123456789012345678",
    oauthClientSecret: CLIENT_SECRET,
    guildIds: ["987654321098765432"],
    internalRoleIds: ["111222333444555666"],
    version: "v1",
  });
  assert.equal(cfg.botToken, TOKEN);
  assert.deepEqual([...cfg.guildIds], ["987654321098765432"]);
  assert.deepEqual([...cfg.internalRoleIds], ["111222333444555666"]);
});

test("settings carry guild and role ids only: a user allow list is neither parsed, stored nor reported", async () => {
  const parsed = parseDiscordSettings({ allowUserIds: ["123456789012345678"], guildIds: [], internalRoleIds: [] });
  assert.deepEqual(Object.keys(parsed).sort(), ["guildIds", "internalRoleIds"]);
  const store = createDiscordInstallationStore("org", testMap<StoredDiscordInstallation>(), "key-material");
  const status = await store.set({ ...parsed, bot: BOT, updatedBy: "admin" });
  assert.equal("allowUserIds" in status, false);
});
