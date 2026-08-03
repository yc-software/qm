import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";
import {
  mintCapabilityToken,
  CAPABILITY_TTL_MS,
  CONTROL_PLANE_AUD,
  EGRESS_PROXY_AUD,
} from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "agent-admin-test-secret".repeat(3);
const ORG = scopeId("org", "default-org");

function start() {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "admin-agent-cap-")),
      signingSecret: SECRET,
    }),
  );
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("admin-agent-capability-keychain"),
  });
  const server = createServer(built.app, {
    admin: built.admin,
    memory: built.memory,
    config: built.config,
    auditLog: built.auditLog,
    sessions: built.sessions,
    runs: built.runs,
    errors: built.errors,
    keychain,
    signingSecret: SECRET,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, keychain, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const capFor = async (
  actorId: string,
  opts: { aud?: string | null; live?: boolean; scope?: string; grants?: string[] } = {},
) => {
  const aud = opts.aud === undefined ? CONTROL_PLANE_AUD : opts.aud;
  return await mintCapabilityToken(
    {
      actorId,
      scopeId: opts.scope ?? scopeId("personal", actorId),
      ...(aud === null ? {} : { aud }),
      ...(opts.live === false ? {} : { liveActor: true }),
      ...(opts.grants ? { grants: opts.grants } : {}),
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    SECRET,
  );
};

test("an org admin's capability token can read and rewrite a scope's notebook via the admin API", async () => {
  const s = start();
  try {
    const cap = await capFor("admin-alice");
    const putRes = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      method: "PUT",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ content: "# Memory\n\n- standup is 9:30 every day." }),
    });
    assert.equal(putRes.status, 200);

    const getRes = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      headers: { "x-agent-capability": cap },
    });
    assert.equal(getRes.status, 200);
    assert.match(((await getRes.json()) as any).content, /standup is 9:30/);

    const updates = (await s.built.auditLog.events()).filter((e) => e.action === "memory.update");
    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.principalId, "admin-alice", "the admin action is attributed to the acting admin");
  } finally {
    await s.close();
  }
});

test("whoami answers an agent capability token for admins and non-admins alike", async () => {
  const s = start();
  try {
    const admin = await fetch(`${s.base}/v1/admin/whoami`, {
      headers: { "x-agent-capability": await capFor("admin-alice") },
    });
    assert.deepEqual(await admin.json(), { isAdmin: true, role: "org_admin", scopeId: ORG, permissions: ["admin"] });

    const user = await fetch(`${s.base}/v1/admin/whoami`, { headers: { "x-agent-capability": await capFor("U1") } });
    assert.deepEqual(await user.json(), { isAdmin: false, permissions: [] });
  } finally {
    await s.close();
  }
});

test("a non-admin's capability token gets 403 from admin routes (gate routes, the grant store decides)", async () => {
  const s = start();
  try {
    const cap = await capFor("U1");
    const res = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      method: "PUT",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ content: "poisoned" }),
    });
    assert.equal(res.status, 403);
    assert.equal((await fetch(`${s.base}/v1/admin/users`, { headers: { "x-agent-capability": cap } })).status, 403);
    assert.doesNotMatch(await s.built.memory.read(ORG), /poisoned/);
  } finally {
    await s.close();
  }
});

test("x-admin-actor cannot escalate a capability token — the header is the portal's source-authed door", async () => {
  const s = start();
  try {
    const cap = await capFor("U1");
    const spoof = { "x-agent-capability": cap, "x-admin-actor": "admin-alice@default-org" };

    const whoami = await fetch(`${s.base}/v1/admin/whoami`, { headers: spoof });
    assert.equal(
      ((await whoami.json()) as any).isAdmin,
      false,
      "the header must not turn a non-admin token into an admin",
    );

    const write = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      method: "PUT",
      headers: { ...spoof, "content-type": "application/json" },
      body: JSON.stringify({ content: "escalated via x-admin-actor" }),
    });
    assert.equal(write.status, 403);
    assert.doesNotMatch(await s.built.memory.read(ORG), /escalated/);
  } finally {
    await s.close();
  }
});

test("a wrong-audience token never reaches the admin plane", async () => {
  const s = start();
  try {
    const res = await fetch(`${s.base}/v1/admin/whoami`, {
      headers: { "x-agent-capability": await capFor("admin-alice", { aud: EGRESS_PROXY_AUD }) },
    });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("an autonomous turn's token cannot act as an admin, even when its actor holds the grant", async () => {
  const s = start();
  try {
    const cap = await capFor("admin-alice", { live: false });

    const whoami = await fetch(`${s.base}/v1/admin/whoami`, { headers: { "x-agent-capability": cap } });
    assert.equal(((await whoami.json()) as any).isAdmin, true, "whoami stays answerable — introspection, not reach");

    const write = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      method: "PUT",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ content: "planted by a 3am cron" }),
    });
    assert.equal(write.status, 403);
    assert.match(((await write.json()) as any).message, /turn the admin started themselves/);
    assert.doesNotMatch(await s.built.memory.read(ORG), /planted/);
  } finally {
    await s.close();
  }
});

test("an unattended admin-read grant opens only the five read-only routes and keeps the DM gate", async () => {
  const s = start();
  try {
    const granted = await capFor("admin-alice", { live: false, grants: ["admin.sessions.read"] });
    const scopeQ = `scope=${encodeURIComponent(ORG)}`;
    const allowed: Array<[string, number]> = [
      [`/v1/admin/sessions?${scopeQ}`, 200],
      [`/v1/admin/sessions/missing-session?${scopeQ}`, 404],
      ["/v1/admin/scopes", 200],
      [`/v1/admin/errors?${scopeQ}`, 200],
      [`/v1/admin/runs?${scopeQ}`, 200],
    ];
    for (const [path, expected] of allowed) {
      const response = await fetch(`${s.base}${path}`, { headers: { "x-agent-capability": granted } });
      assert.equal(response.status, expected, `${path} is usable under the grant (got ${response.status})`);
    }

    const denied = [
      ["GET", "/v1/admin/sessions/missing-session/llm"],
      ["GET", "/v1/admin/memory"],
      ["GET", `/v1/admin/scopes/${encodeURIComponent(ORG)}`],
      ["POST", "/v1/admin/sessions"],
      ["PUT", "/v1/admin/scopes"],
      ["DELETE", "/v1/admin/errors"],
    ] as const;
    for (const [method, path] of denied) {
      const response = await fetch(`${s.base}${path}`, {
        method,
        headers: { "x-agent-capability": granted, "content-type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });
      assert.equal(response.status, 403, `${method} ${path} stays attended-only`);
    }

    const ungranted = await capFor("admin-alice", { live: false });
    assert.equal(
      (await fetch(`${s.base}/v1/admin/sessions`, { headers: { "x-agent-capability": ungranted } })).status,
      403,
    );
    const channelGrant = await capFor("admin-alice", {
      live: false,
      grants: ["admin.sessions.read"],
      scope: scopeId("channel", "C1"),
    });
    const channelRead = await fetch(`${s.base}/v1/admin/sessions`, {
      headers: { "x-agent-capability": channelGrant },
    });
    assert.equal(channelRead.status, 403);
    assert.match(((await channelRead.json()) as { message: string }).message, /ask the agent in a DM/);
  } finally {
    await s.close();
  }
});

test("an aud-less token never opens the admin door", async () => {
  const s = start();
  try {
    const res = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      headers: { "x-agent-capability": await capFor("admin-alice", { aud: null }) },
    });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as any).message, /per-turn agent token/);
  } finally {
    await s.close();
  }
});

test("grant management refuses agent tokens outright — promote/revoke stays in the portal", async () => {
  const s = start();
  try {
    const cap = await capFor("admin-alice");
    const promote = await fetch(`${s.base}/v1/admin/grants`, {
      method: "POST",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U9", role: "org_admin", scopeId: ORG }),
    });
    assert.equal(promote.status, 403);
    assert.match(((await promote.json()) as any).message, /portal-only/);

    const revoke = await fetch(`${s.base}/v1/admin/grants/admin-bob?scope=${encodeURIComponent(ORG)}&role=org_admin`, {
      method: "DELETE",
      headers: { "x-agent-capability": cap },
    });
    assert.equal(revoke.status, 403);

    const u9 = await fetch(`${s.base}/v1/admin/whoami`, { headers: { "x-agent-capability": await capFor("U9") } });
    assert.equal(((await u9.json()) as any).isAdmin, false, "the refused promote really didn't land");
  } finally {
    await s.close();
  }
});

test("impersonation refuses agent tokens outright — acting as another user stays in the portal", async () => {
  const s = start();
  try {
    const cap = await capFor("admin-alice");
    const start1 = await fetch(`${s.base}/v1/admin/impersonate`, {
      method: "POST",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ target: "U9" }),
    });
    assert.equal(start1.status, 403);
    assert.match(((await start1.json()) as any).message, /portal-only/);

    const stop1 = await fetch(`${s.base}/v1/admin/impersonate/stop`, {
      method: "POST",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ target: "U9" }),
    });
    assert.equal(stop1.status, 403);
  } finally {
    await s.close();
  }
});

test("content reads need a DM-scoped token", async () => {
  const s = start();
  try {
    const fromChannel = await capFor("admin-alice", { scope: scopeId("channel", "C1") });

    const sessions = await fetch(`${s.base}/v1/admin/sessions?scope=${encodeURIComponent(ORG)}`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(sessions.status, 403);
    assert.match(((await sessions.json()) as any).message, /ask the agent in a DM/);
    const personalNotebook = await fetch(
      `${s.base}/v1/admin/memory?scope=${encodeURIComponent(scopeId("personal", "U1"))}`,
      {
        headers: { "x-agent-capability": fromChannel },
      },
    );
    assert.equal(personalNotebook.status, 403);

    const put = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      method: "PUT",
      headers: { "x-agent-capability": fromChannel, "content-type": "application/json" },
      body: JSON.stringify({ content: "# Memory\n\n- launch day is June 24." }),
    });
    assert.equal(put.status, 200);
    const orgNotebook = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(orgNotebook.status, 200);

    const userFromChannel = await fetch(`${s.base}/v1/admin/users/${encodeURIComponent("U1")}`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(userFromChannel.status, 403);
    assert.match(((await userFromChannel.json()) as any).message, /ask the agent in a DM/);
    const keychainFromChannel = await fetch(`${s.base}/v1/admin/keychain`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(keychainFromChannel.status, 403);
    assert.match(((await keychainFromChannel.json()) as any).message, /ask the agent in a DM/);
    const mirrorFromChannel = await fetch(`${s.base}/v1/admin/slack-mirror`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(mirrorFromChannel.status, 403);
    assert.match(((await mirrorFromChannel.json()) as any).message, /ask the agent in a DM/);
    const judgmentsFromChannel = await fetch(`${s.base}/v1/admin/ambient-judgments`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(judgmentsFromChannel.status, 403);
    assert.match(((await judgmentsFromChannel.json()) as any).message, /ask the agent in a DM/);
    const importFromChannel = await fetch(`${s.base}/v1/admin/scopes/${encodeURIComponent(ORG)}/import`, {
      method: "PUT",
      headers: { "x-agent-capability": fromChannel, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(importFromChannel.status, 403);
    assert.match(((await importFromChannel.json()) as any).message, /credentials/);
    const ackPicksFromChannel = await fetch(`${s.base}/v1/admin/ack-emoji-picks`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(ackPicksFromChannel.status, 403);
    assert.match(((await ackPicksFromChannel.json()) as any).message, /ask the agent in a DM/);
    const rosterFromChannel = await fetch(`${s.base}/v1/admin/users`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(rosterFromChannel.status, 200);

    const fromDm = await capFor("admin-alice");
    const dmSessions = await fetch(`${s.base}/v1/admin/sessions?scope=${encodeURIComponent(ORG)}`, {
      headers: { "x-agent-capability": fromDm },
    });
    assert.equal(dmSessions.status, 200);
    const dmUser = await fetch(`${s.base}/v1/admin/users/${encodeURIComponent("U1")}`, {
      headers: { "x-agent-capability": fromDm },
    });
    assert.equal(dmUser.status, 200);
    const dmKeychain = await fetch(`${s.base}/v1/admin/keychain`, { headers: { "x-agent-capability": fromDm } });
    assert.equal(dmKeychain.status, 200);
  } finally {
    await s.close();
  }
});

test("revoking the admin grant cuts off an already-minted token immediately", async () => {
  const s = start();
  try {
    const cap = await capFor("admin-alice");
    const before = await fetch(`${s.base}/v1/admin/whoami`, { headers: { "x-agent-capability": cap } });
    assert.equal(((await before.json()) as any).isAdmin, true);

    await s.built.admin.revokeGrant({ id: "admin-bob", type: "internal" }, "admin-alice", ORG, "org_admin");

    const after = await fetch(`${s.base}/v1/admin/whoami`, { headers: { "x-agent-capability": cap } });
    assert.equal(((await after.json()) as any).isAdmin, false);
    const write = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      method: "PUT",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ content: "stale admin" }),
    });
    assert.equal(write.status, 403, "the live grant store, not the token, is the authority");
  } finally {
    await s.close();
  }
});
