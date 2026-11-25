import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { scopeId, type ScopeId, personalScope } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const SECRET = "discovery-test-secret".repeat(3);
const ORG = scopeId("org", "default-org");

async function start(swarmsEnabled = true) {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "agent-apis-")),
      signingSecret: SECRET,
      swarmsEnabled,
    }),
  );
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    admin: built.admin,
    memory: built.memory,
    sessions: built.sessions,
    connectorTokens: built.connectorTokens,
    auditLog: built.auditLog,
    signingSecret: SECRET,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const capFor = (
  actorId: string,
  opts: {
    scopeId?: ScopeId;
    audienceScopeId?: ScopeId;
    destination?: { type: "slack"; target: string; audienceScopeId: ScopeId };
    memory?: { write?: ScopeId; orgWrite?: ScopeId; read: ScopeId[] };
    personAuthority?: boolean;
    origin?: "cron";
    botActor?: boolean;
  } = {},
) =>
  mintCapabilityToken(
    {
      actorId,
      scopeId: opts.scopeId ?? scopeId("personal", actorId),
      exp: Date.now() + CAPABILITY_TTL_MS,
      ...(opts.audienceScopeId ? { audienceScopeId: opts.audienceScopeId } : {}),
      ...(opts.destination ? { destination: opts.destination } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.personAuthority ? { internalAudience: true, personAuthority: true } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.botActor ? { botActor: true } : {}),
    },
    SECRET,
  );

const listApis = async (base: string, cap: string) => {
  const res = await fetch(`${base}/v1/apis`, { headers: { "x-agent-capability": cap } });
  return { status: res.status, body: (await res.json()) as any };
};
const paths = (body: any): string[] => body.endpoints.map((e: any) => e.path);

test("discovery for a regular user: base surface + whoami, no admin rows, no memory rows without claims", async () => {
  const s = await start();
  try {
    const { status, body } = await listApis(s.base, await capFor("U1"));
    assert.equal(status, 200);
    assert.deepEqual(body.admin, { isAdmin: false });
    const p = paths(body);
    assert.ok(p.includes("/v1/apis"));
    assert.ok(!p.includes("/v1/crons"), "cron is a typed tool now, not a discovery row");
    assert.ok(!p.includes("/v1/webhooks"), "webhook is a typed tool now, not a discovery row");
    assert.ok(!p.includes("/v1/soul"), "soul is a typed tool now, not a discovery row");
    assert.ok(p.includes("/v1/skills"), "saving a personal skill is a discoverable self-API endpoint");
    assert.ok(p.includes("/v1/keychain/overview"), "the keychain overview gate is represented in discovery");
    assert.ok(p.includes("/v1/admin/whoami"), "everyone can ask whether the user is an admin");
    assert.ok(!p.includes("/v1/admin/scopes"), "admin rows must not render for a non-admin");
    assert.ok(!p.some((x: string) => x.startsWith("/v1/memory")), "no memory rows without memory claims");
    assert.doesNotMatch(JSON.stringify(body), /auto-grant/i);
    assert.match(
      body.endpoints.find((endpoint: any) => endpoint.path === "/v1/connectors/oauth/consent/mint")?.summary ?? "",
      /stays private.*explicit credential grant/i,
    );
    assert.match(
      body.endpoints.find((endpoint: any) => endpoint.path === "/v1/loops")?.summary ?? "",
      /governor.*staleFireMs/,
    );
  } finally {
    await s.close();
  }
});

test("discovery follows the token's memory claims, including the org selector", async () => {
  const s = await start();
  try {
    const U1 = scopeId("personal", "U1");
    const hasOrgSelector = (body: any) => body.endpoints.some((e: any) => e.summary.includes('"scope":"org"'));
    const plain = await listApis(s.base, await capFor("U1", { memory: { write: U1, read: [U1] } }));
    assert.ok(paths(plain.body).includes("/v1/memory/self"));
    assert.ok(!hasOrgSelector(plain.body), "no org selector without orgWrite");

    const org = await listApis(
      s.base,
      await capFor("admin-alice", {
        memory: { write: scopeId("personal", "admin-alice"), orgWrite: ORG, read: [ORG] },
      }),
    );
    assert.ok(hasOrgSelector(org.body), "orgWrite tokens see the org selector row");
  } finally {
    await s.close();
  }
});

test("discovery for an org admin's turn with person authority includes the admin plane (current grant check), with guidance", async () => {
  const s = await start();
  try {
    const { body } = await listApis(s.base, await capFor("admin-alice", { personAuthority: true }));
    assert.deepEqual(body.admin, { isAdmin: true, role: "org_admin" });
    const p = paths(body);
    assert.ok(p.includes("/v1/admin/scopes"));
    assert.ok(p.includes("/v1/admin/users"));
    assert.ok(!p.includes("/v1/admin/grants"), "grant management is portal-only and must not be advertised");
    assert.ok(body.guidance.some((g: string) => g.includes("confirm before any mutation")));
    assert.doesNotMatch(JSON.stringify(body), /DM only|only from a DM|bulk config imports require/);
    assert.equal(p.filter((x: string) => x === "/v1/admin/whoami").length, 1, "whoami listed once, not duplicated");
  } finally {
    await s.close();
  }
});

test("an admin's token carrying no person's authority is shown no admin plane — matching what the gate enforces", async () => {
  const s = await start();
  try {
    for (const opts of [{}, { personAuthority: true, botActor: true }]) {
      const { body } = await listApis(s.base, await capFor("admin-alice", opts));
      assert.equal(body.admin.isAdmin, true, "status is still reported truthfully");
      const p = paths(body);
      assert.ok(
        !p.includes("/v1/admin/scopes"),
        `no admin rows without a person's authority (${JSON.stringify(opts)})`,
      );
      assert.ok(p.includes("/v1/admin/whoami"), "introspection stays available");
    }
  } finally {
    await s.close();
  }
});

test("discovery requires a capability token", async () => {
  const s = await start();
  try {
    assert.equal((await fetch(`${s.base}/v1/apis`)).status, 401);
  } finally {
    await s.close();
  }
});

test("discovery advertises the deployment share endpoint, with guidance", async () => {
  const s = await start();
  try {
    const { body } = await listApis(s.base, await capFor("U1"));
    const p = paths(body);
    assert.ok(p.includes("/v1/shares/:type/:id"), "the share endpoint is discoverable");
    assert.ok(p.includes("/v1/apps/:id/git-url"), "git-url stays discoverable");
    assert.ok(p.includes("/v1/apps/:id"), "deployment detail is discoverable");
    assert.ok(p.includes("/v1/apps/:id/restore"), "restore is discoverable");
    assert.ok(
      body.guidance.some((g: string) => g.includes("POST /v1/shares/deploy/:id") && g.includes('scope:"org"')),
      "share guidance is present",
    );
  } finally {
    await s.close();
  }
});

test("discovery includes admin routes for a verified human thread reply", async () => {
  const s = await start();
  try {
    const { body } = await listApis(s.base, await capFor("admin-alice", { personAuthority: true }));
    const p = paths(body);
    assert.ok(p.includes("/v1/admin/scopes/:scopeId/:resource"));
    assert.equal(p.filter((path) => path === "/v1/admin/whoami").length, 1);
    assert.equal(p.filter((path) => path === "/v1/admin/scopes").length, 1);
    assert.ok(body.guidance.some((g: string) => g.includes("confirm before any mutation")));
    assert.doesNotMatch(JSON.stringify(body), /DM only|only from a DM|bulk config imports require/);
    const member = await listApis(s.base, await capFor("U1", { personAuthority: true }));
    assert.ok(!paths(member.body).includes("/v1/admin/scopes"));
  } finally {
    await s.close();
  }
});

test("disabled swarms are absent from discovery and reject direct API calls", async () => {
  const { base, built, close } = await start(false);
  try {
    assert.equal(built.app.swarms, undefined);
    const token = await capFor("U1");
    const { status, body } = await listApis(base, token);
    assert.equal(status, 200);
    assert.ok(!paths(body).includes("/v1/swarm"));
    assert.ok(body.guidance.every((line: string) => !line.includes("Swarm")));
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${base}/v1/swarm`, {
        method,
        headers: { "x-agent-capability": token, "content-type": "application/json" },
        ...(method === "POST"
          ? { body: JSON.stringify({ action: "spawn", requestId: "disabled", text: "work" }) }
          : {}),
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "swarm service unavailable" });
    }
  } finally {
    await close();
  }
});

test("swarm routes are listed for internal people and hidden from callers the swarm API refuses", async () => {
  const { base, built, close } = await start();
  try {
    const internal = await listApis(base, await capFor("U1"));
    assert.ok(paths(internal.body).includes("/v1/swarm"));
    await built.identity.deactivate("U2");
    const refused = await listApis(base, await capFor("U2"));
    assert.equal(refused.status, 200);
    assert.ok(!paths(refused.body).includes("/v1/swarm"));
    assert.ok(refused.body.guidance.every((line: string) => !line.includes("Swarm")));
  } finally {
    await close();
  }
});

test("personal-scope parity routes: capability access, shared-room isolation, bot gating, and /v1/apis discovery", async () => {
  const { base, built, close } = await start();
  try {
    await built.app.upsertDirectory([
      { principalId: "U1", displayName: "Alice", type: "internal" },
      { principalId: "U2", displayName: "Bob", type: "internal" },
    ]);
    await built.app.upsertChannels(
      [
        { channelId: "C1", name: "general", isPrivate: false },
        { channelId: "P1", name: "secret-alice", isPrivate: true },
      ],
      [
        { channelId: "C1", principalId: "U1" },
        { channelId: "P1", principalId: "U1" },
      ],
    );
    const created = new Map<string, string>();
    for (const [scope, name] of [
      [scopeId("personal", "U1"), "my-personal-skill"],
      [scopeId("personal", "U1"), "room-skill"],
      [scopeId("channel", "C1"), "room-skill"],
    ] as const) {
      const sk = await built.skills.create({
        scopeId: scope,
        createdBy: "U1",
        manifest: { name, description: name, body: "b", requiredCapabilities: [] },
      });
      await built.skills.review(sk.id, "r1", []);
      await built.skills.publish(sk.id);
      created.set(`${scope}:${name}`, sk.id);
    }
    const [cronTok, roomTok, crossTok, noAudienceTok, botTok] = await Promise.all([
      capFor("U1", { audienceScopeId: scopeId("personal", "U1"), personAuthority: true, origin: "cron" as const }),
      capFor("U1", {
        scopeId: scopeId("channel", "C1"),
        audienceScopeId: scopeId("channel", "C1"),
        personAuthority: true,
      }),
      capFor("U1", {
        personAuthority: true,
        origin: "cron" as const,
        destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
      }),
      capFor("U1", { personAuthority: true, origin: "cron" as const }),
      capFor("U1", { scopeId: scopeId("channel", "C1"), botActor: true }),
    ]);
    const get = (p: string, tok: string) => fetch(`${base}${p}`, { headers: { "x-agent-capability": tok } });
    const j = async (p: string, tok: string) => (await get(p, tok)).json() as Promise<any>;
    const [cronApis, roomApis, noAudienceApis, botApis] = [
      paths((await listApis(base, cronTok)).body),
      paths((await listApis(base, roomTok)).body),
      paths((await listApis(base, noAudienceTok)).body),
      paths((await listApis(base, botTok)).body),
    ];
    for (const r of [
      "/v1/spend",
      "/v1/skills",
      "/v1/contexts",
      "/v1/directory/channels",
      "/v1/connectors/oauth/status",
    ])
      assert.ok(cronApis.includes(r), r);
    assert.ok(!roomApis.includes("/v1/connectors/oauth/status"));
    assert.ok(!noAudienceApis.includes("/v1/spend"));
    assert.ok(!noAudienceApis.includes("/v1/connectors/oauth/status"));
    for (const r of ["/v1/spend", "/v1/contexts", "/v1/directory/channels", "/v1/connectors/oauth/status"]) {
      assert.ok(!botApis.includes(r), r);
      assert.equal((await get(r, botTok)).status, 403);
    }
    assert.ok(
      (await j("/v1/skills?principalId=U2", cronTok)).skills.some((sk: any) => sk.name === "my-personal-skill"),
    );
    assert.ok(
      (await j("/v1/contexts?principalId=U2", cronTok)).contexts.some((c: any) => c.scopeId === personalScope("U1")),
    );
    assert.deepEqual(
      (await j("/v1/directory/channels?principalId=U2", cronTok)).channels.map((c: any) => c.channelId).sort(),
      ["C1", "P1"],
    );
    assert.equal((await j("/v1/connectors/oauth/status?principalId=U2", cronTok)).principalId, "U1");
    for (const tok of [roomTok, crossTok]) {
      const sk = (await j("/v1/skills", tok)).skills;
      assert.deepEqual(
        sk.filter((s: any) => !s.scopeId.startsWith("org:")).map((s: any) => [s.scopeId, s.name]),
        [["channel:C1", "room-skill"]],
      );
      assert.equal((await get(`/v1/skills/${created.get("personal:U1:my-personal-skill")}`, tok)).status, 404);
      assert.equal((await get(`/v1/skills/${created.get("channel:C1:room-skill")}`, tok)).status, 200);
      assert.deepEqual(
        (await j("/v1/contexts", tok)).contexts.map((c: any) => c.scopeId),
        ["channel:C1"],
      );
      assert.deepEqual(
        (await j("/v1/directory/channels", tok)).channels.map((c: any) => c.channelId),
        ["C1"],
      );
      assert.equal((await get("/v1/connectors/oauth/status", tok)).status, 403);
    }
  } finally {
    await close();
  }
});
