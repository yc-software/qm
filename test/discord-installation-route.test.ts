import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  deleteDiscordInstallation,
  getDiscordInstallation,
  putDiscordInstallation,
} from "../src/api/routes/admin/discord-installation.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { createDiscordInstallationStore } from "../src/surfaces/discord-installation.ts";
import { testMap } from "./support/test-database.ts";

const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.SECRET.TOKENVALUE";
const CLIENT_SECRET = "oauth-client-SECRET-value";

async function fixture(t: test.TestContext, options: { omitStore?: boolean } = {}) {
  const map = testMap();
  const store = options.omitStore
    ? undefined
    : createDiscordInstallationStore("test", map as Parameters<typeof createDiscordInstallationStore>[1], "test-key");
  const auditEntries: Array<{ action: string; resource: string; principalId: string }> = [];
  const deps = {
    discordInstallation: store,
    portalUrl: "https://agent.example",
    discordInstallationFetch: (async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/applications/@me")) {
        return Response.json({ id: "4242" });
      }
      return Response.json({ id: "42", username: "qm", discriminator: "0" });
    }) as typeof fetch,
    config: { orgId: "test" },
    auditLog: {
      record: (entry: { action: string; resource: string; principalId: string }) => {
        auditEntries.push(entry);
      },
    },
    admin: {
      listGrants: async () => [{ principalId: "admin", role: "org_admin", scopeId: "org:test" }],
      resolveActor: (id: string) => ({ id, type: "internal" }),
    },
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? JSON.parse(raw) : {};
    const ctx = {
      req,
      res,
      deps,
      body,
      method: req.method,
      url: new URL(req.url ?? "/", "http://127.0.0.1"),
      actor: null,
      capability: null,
    } as unknown as ApiCtx;

    if (req.method === "GET") await getDiscordInstallation(ctx);
    else if (req.method === "PUT") await putDiscordInstallation(ctx);
    else if (req.method === "DELETE") await deleteDiscordInstallation(ctx);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address();
  assert(address && typeof address === "object");
  const call = async (method: string, body?: unknown, actor = "admin") => {
    const res = await fetch(`http://127.0.0.1:${address.port}/`, {
      method,
      headers: { "x-admin-actor": actor, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await res.text();
    return { status: res.status, raw };
  };

  return { store, deps, call, auditEntries };
}

test("no admin response contains the token or the OAuth client secret", async (t) => {
  const { call } = await fixture(t);
  const put = await call("PUT", {
    botToken: TOKEN,
    oauthClientSecret: CLIENT_SECRET,
    guildIds: [],
    internalRoleIds: [],
  });
  const get = await call("GET");
  const del = await call("DELETE");
  for (const r of [put, get, del]) {
    assert.equal(r.raw.includes(TOKEN), false);
    assert.equal(r.raw.includes(CLIENT_SECRET), false);
  }
  assert.equal(put.status, 200);
  const body = JSON.parse(get.raw);
  assert.equal(body.configured, true);
  assert.equal(body.oauthConfigured, true);
  assert.equal("principalDeliveries" in body, false);
  assert.equal(body.redirectUri, "https://agent.example/settings");
  assert.equal(JSON.parse((await call("GET")).raw).configured, false);
});

test("non-admin caller is refused on every route", async (t) => {
  const { call } = await fixture(t);
  const get = await call("GET", undefined, "non-admin");
  const put = await call("PUT", { guildIds: [] }, "non-admin");
  const del = await call("DELETE", undefined, "non-admin");
  assert.equal(get.status, 403);
  assert.equal(put.status, 403);
  assert.equal(del.status, 403);
});

test("returns 404 on every route if store is not configured in deps", async (t) => {
  const { call } = await fixture(t, { omitStore: true });
  const get = await call("GET");
  const put = await call("PUT", { guildIds: [] });
  const del = await call("DELETE");
  assert.equal(get.status, 404);
  assert.equal(put.status, 404);
  assert.equal(del.status, 404);
  assert.deepEqual(JSON.parse(get.raw), { error: "not_configured" });
  assert.deepEqual(JSON.parse(put.raw), { error: "not_configured" });
  assert.deepEqual(JSON.parse(del.raw), { error: "not_configured" });
});

test("audit entries are recorded for GET, PUT, and DELETE", async (t) => {
  const { call, auditEntries } = await fixture(t);
  await call("PUT", {
    botToken: TOKEN,
    guildIds: [],
    internalRoleIds: [],
  });
  await call("GET");
  await call("DELETE");
  const actions = auditEntries.map((e) => e.action);
  assert.ok(actions.includes("discord-installation.update"));
  assert.ok(actions.includes("discord-installation.read"));
  assert.ok(actions.includes("discord-installation.delete"));
  for (const entry of auditEntries) {
    assert.equal(entry.resource, "discord-installation");
  }
});

test("invalid input produces 400 and does not echo secrets", async (t) => {
  const { call } = await fixture(t);
  const res = await call("PUT", {
    botToken: TOKEN,
    guildIds: ["invalid-id"],
    internalRoleIds: [],
  });
  assert.equal(res.status, 400);
  assert.equal(res.raw.includes(TOKEN), false);
  const parsed = JSON.parse(res.raw);
  assert.equal(parsed.error, "invalid_discord_installation");
});
