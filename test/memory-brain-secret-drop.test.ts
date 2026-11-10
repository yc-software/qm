import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import {
  CAPABILITY_TTL_MS,
  mintCapabilityToken,
  SECRET_DROP_AUD,
  verifyCapabilityToken,
  type CapabilityClaims,
} from "../src/auth/capability-token.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { orgId } from "../src/config.ts";
import {
  memberBrainId,
  putBinding,
  putBrain,
  readRegistry,
  resolveMemoryRegistry,
  setMemberBrains,
} from "../src/memory/registry.ts";
import type { DropResolution } from "../src/triggers/keychain-ask.ts";
import { scopeId } from "../src/types.ts";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";
import { TEST_TENANT } from "./support/test-tenant.ts";
import { withTenant } from "../src/tenants/context.ts";

const tenant = withTenant(TEST_TENANT, (t) => t);

const SECRET = "memory-brain-drop-test-secret".repeat(2);
const BRAIN = {
  preset: "gbrain-v1",
  url: "https://brain.acme.example/mcp",
  clientId: "qm-personal",
  label: "Acme personal memory",
};

interface OwnBrain {
  principalId: string;
  memberBrains: boolean;
  brain: { id: string; auth: { clientId: string; hasClientSecret: boolean } } | null;
  binding: { scope: string } | null;
  disabled: Array<{ code: string }>;
  message: string;
}

async function setup(
  t: { after(fn: () => Promise<void>): void },
  opts: { fireDropResolution?: (drop: DropResolution) => Promise<void> } = {},
) {
  const built = buildApp(testConfig({ signingSecret: SECRET }));
  const registry = built.memoryRegistry;
  const change = { actor: "admin-alice", now: 1_762_128_000_000, overlayIds: registry.overlayIds, key: registry.key };
  await registry.update((record) =>
    putBinding(
      putBrain(record, "acme-personal", BRAIN, change),
      "everyone",
      { brain: "acme-personal", scope: "personal" },
      change,
    ),
  );
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    keychain: built.keychain,
    secretDrops: built.secretDrops,
    deliveries: built.deliveries,
    auditLog: built.auditLog,
    admin: built.admin,
    memoryRegistry: registry,
    ...browserSessionDeps,
    ...(opts.fireDropResolution ? { fireDropResolution: opts.fireDropResolution } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  let nonce = 0;
  const signed = async (method: string, rawPath: string, body: string, owner: string) => {
    const path = `${rawPath}${rawPath.includes("?") ? "&" : "?"}_n=${nonce++}`;
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...signedRequestHeaders(SECRET, method, path, body),
        "x-drop-owner": owner,
        "x-drop-owner-org": orgId(),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
    });
    return { status: res.status, text: await res.text() };
  };
  const mint = async (
    actorId: string,
    body: unknown,
    scope = scopeId("personal", actorId),
    extra: Partial<CapabilityClaims> = {},
  ) => {
    const cap = await mintCapabilityToken(
      { actorId, scopeId: scope, exp: Date.now() + CAPABILITY_TTL_MS, ...extra },
      SECRET,
    );
    const res = await fetch(`${base}/v1/keychain/drops`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": cap },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const json = res.ok ? (JSON.parse(text) as { dropId: string; formPath: string }) : undefined;
    const t = json ? new URL(json.formPath, "http://x").searchParams.get("t")! : "";
    return {
      status: res.status,
      text,
      token: t,
      form: () => signed("GET", `/v1/keychain/drops/${json!.dropId}/form?t=${encodeURIComponent(t)}`, "", actorId),
      redeem: (secret: string, token = t) =>
        signed(
          "POST",
          `/v1/keychain/drops/${json!.dropId}?t=${encodeURIComponent(token)}`,
          JSON.stringify({ secret }),
          actorId,
        ),
    };
  };
  const servedSecret = async (id = "acme-personal") => {
    const provider = resolveMemoryRegistry(
      readRegistry((await registry.current()).record),
      registry,
    ).config.providers.find((entry) => entry.id === id);
    return provider?.type === "mcp" ? provider.read.auth.clientSecret : undefined;
  };
  const self = async (
    actorId: string,
    method: string,
    body?: unknown,
    extra: Partial<CapabilityClaims> = {},
  ): Promise<{ status: number; text: string; json: OwnBrain }> => {
    const cap = await mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("personal", actorId),
        liveActor: true,
        exp: Date.now() + CAPABILITY_TTL_MS,
        ...extra,
      },
      SECRET,
    );
    const res = await fetch(`${base}/v1/memory/brain`, {
      method,
      headers: { "x-agent-capability": cap, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  };
  const browserMint = async (principalId: string, body: unknown) => {
    const res = await fetch(`${base}/api/keychain/drops`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: browserSessionCookie(principalId),
        origin: browserSessionDeps.portalUrl,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };
  return { base, built, change, mint, self, browserMint, servedSecret };
}

test("an org admin's brain link saves the client secret core-only, from a project whose members change and from a DM", async (t) => {
  const { built, mint, servedSecret } = await setup(t);
  await built.app.upsertDirectory([
    { principalId: "admin-alice", displayName: "Alice", type: "internal" },
    { principalId: "member-bob", displayName: "Bob", type: "internal" },
  ]);
  const project = await built.app.createProject("admin-alice", "Brain setup");
  assert.ok(project);
  const scopeVersion = await built.projects.version(project.scopeId.slice("group:".length));
  const fromProject = await mint(
    "admin-alice",
    { memoryBrain: "acme-personal", purpose: "connect Acme personal memory" },
    project.scopeId,
    scopeVersion ? { scopeVersion } : {},
  );
  assert.equal(fromProject.status, 200);
  const form = await fromProject.form();
  assert.equal(form.status, 200);
  assert.match(form.text, /Acme personal memory at https:\/\/brain\.acme\.example\/mcp<\/strong>/);
  assert.match(form.text, /every member&#39;s personal memory/);
  assert.equal((await built.app.addProjectMember(project.id, "admin-alice", "member-bob")).status, "ok");
  const saved = await fromProject.redeem("brain-secret-one");
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(saved.text), { ok: true, brain: "acme-personal" });
  assert.equal(await servedSecret(), "brain-secret-one");

  const fromDm = await mint("admin-alice", { memoryBrain: "acme-personal", purpose: "rotate it" });
  assert.equal(fromDm.status, 200);
  assert.equal((await fromDm.redeem("brain-secret-two")).status, 200);
  assert.equal(await servedSecret(), "brain-secret-two");
  assert.equal((await fromDm.redeem("brain-secret-three")).status, 404, "a link works once");

  assert.doesNotMatch(JSON.stringify((await built.memoryRegistry.current()).record), /brain-secret-/);
  assert.deepEqual(await built.keychain!.listByOwner("admin-alice"), [], "nothing enters a keychain");
  assert.deepEqual(await built.keychain!.listGrants({ ownerId: "admin-alice" }), [], "nothing is granted");
  const rows = JSON.stringify(await built.auditLog.events());
  assert.match(rows, /memory-registry\.brain\.secret/);
  assert.doesNotMatch(rows, /brain-secret-/);
});

test("a brain link has its own link audience, so a core without brain links refuses it instead of saving the secret into a keychain", async (t) => {
  const { built, mint, servedSecret } = await setup(t);
  await built.app.upsertDirectory([{ principalId: "admin-alice", displayName: "Alice", type: "internal" }]);
  const link = await mint("admin-alice", { memoryBrain: "acme-personal", purpose: "connect Acme personal memory" });
  assert.equal(link.status, 200);
  const claims = await verifyCapabilityToken(link.token, SECRET);
  assert.ok(claims);
  assert.notEqual(claims.aud, SECRET_DROP_AUD, "a core without brain links accepts only keychain drop links");
  const asKeychainDrop = await mintCapabilityToken({ ...claims, aud: SECRET_DROP_AUD }, SECRET);
  assert.equal((await link.redeem("brain-secret-swapped", asKeychainDrop)).status, 404);
  assert.equal(await servedSecret(), undefined);
  assert.equal((await link.redeem("brain-secret-own")).status, 200);
  assert.equal(await servedSecret(), "brain-secret-own");
  assert.deepEqual(await built.keychain!.listByOwner("admin-alice"), []);
});

test("a brain link refuses non-admins, other drop fields, unknown and moved brains, and a demoted admin, and stays usable after a refused save", async (t) => {
  const { built, change, mint, servedSecret } = await setup(t);
  const brainDrop = { memoryBrain: "acme-personal", purpose: "connect it" };
  assert.equal((await mint("U-member", brainDrop)).status, 403);
  assert.equal((await mint("U-member", { memoryBrain: "nope", purpose: "p" })).status, 403);
  const extra = await mint("admin-alice", { ...brainDrop, service: "stripe", envKey: "STRIPE_KEY" });
  assert.equal(extra.status, 400);
  assert.match(extra.text, /only purpose, not service, envKey/);
  assert.equal((await mint("admin-alice", { memoryBrain: "nope", purpose: "p" })).status, 404);
  assert.equal(
    (await mint("admin-alice", brainDrop, scopeId("personal", "admin-alice"), { triggered: true })).status,
    403,
  );

  const beforeMove = await mint("admin-alice", brainDrop);
  await built.memoryRegistry.update((record) =>
    putBrain(record, "acme-personal", { url: "https://brain2.acme.example/mcp" }, change),
  );
  const movedForm = await beforeMove.form();
  assert.equal(movedForm.status, 409, "a moved brain's link shows no form");
  assert.match(movedForm.text, /removed or moved to another address/);
  const moved = await beforeMove.redeem("for-the-old-url");
  assert.equal(moved.status, 409);
  assert.match(JSON.parse(moved.text).message, /changed after this link was made/);
  assert.doesNotMatch(moved.text, /for-the-old-url/);
  assert.equal(await servedSecret(), undefined);
  await built.memoryRegistry.update((record) => putBrain(record, "acme-personal", { url: BRAIN.url }, change));
  assert.equal((await beforeMove.form()).status, 200);
  assert.equal((await beforeMove.redeem("after-the-move-back")).status, 200);
  assert.equal(await servedSecret(), "after-the-move-back");

  const alice = { id: "admin-alice", type: "internal" as const };
  await built.admin.createGrant(tenant, alice, {
    principalId: "admin-carol",
    role: "org_admin",
    scopeId: scopeId("org", orgId()),
  });
  const carols = await mint("admin-carol", brainDrop);
  assert.equal(carols.status, 200);
  await built.admin.revokeGrant(tenant, alice, "admin-carol", scopeId("org", orgId()), "org_admin");
  const demotedForm = await carols.form();
  assert.equal(demotedForm.status, 403, "a former admin's link shows no form");
  assert.match(demotedForm.text, /You can no longer set this brain's secret/);
  assert.doesNotMatch(demotedForm.text, /brain\.acme\.example|personal memory/);
  const demoted = await carols.redeem("from-a-former-admin");
  assert.equal(demoted.status, 403);
  assert.match(JSON.parse(demoted.text).message, /no longer set this brain's secret/);
  assert.equal(await servedSecret(), "after-the-move-back");
  await built.memoryRegistry.update((record) =>
    putBrain(record, "acme-personal", { url: "https://brain2.acme.example/mcp" }, change),
  );
  assert.equal((await carols.form()).status, 403, "a former admin's link stays refused after the brain moves");
  const rows = JSON.stringify(await built.auditLog.events());
  assert.match(rows, /memory-registry\.brain\.secret\.refused/);
  assert.equal(rows.match(/acme-personal: brain acme-personal changed after this link was made/g)?.length, 2);
  assert.equal(rows.match(/acme-personal: you can no longer set this brain's secret: only an org admin/g)?.length, 3);
  assert.doesNotMatch(rows, /for-the-old-url|from-a-former-admin/);
});

test("an unfilled brain link is never a pending sibling of a keychain drop in the same conversation", async (t) => {
  const fires: DropResolution[] = [];
  let fired: (() => void) | undefined;
  const { built, mint } = await setup(t, {
    fireDropResolution: async (drop) => {
      fires.push(drop);
      fired?.();
    },
  });
  await built.directory.replaceChannels(
    [{ channelId: "C1", name: "drops", isPrivate: false }],
    [{ channelId: "C1", principalId: "admin-alice" }],
  );
  const channel = scopeId("channel", "C1");
  const brainLink = await mint("admin-alice", { memoryBrain: "acme-personal", purpose: "p" }, channel);
  assert.equal(brainLink.status, 200);
  const stripe = await mint("admin-alice", { service: "stripe", purpose: "p" }, channel);
  const waited = new Promise<void>((resolve) => {
    fired = resolve;
  });
  assert.equal((await stripe.redeem("sk-stripe")).status, 200);
  await waited;
  assert.equal(fires[0]!.pendingSiblings, undefined);
});

test("a member connects their own brain from chat and sets its secret through their own link only", async (t) => {
  const { base, built, mint, self, servedSecret } = await setup(t);
  const own = { url: "https://brain.member.example/mcp", clientId: "member-qm" };
  const id = memberBrainId("U-member");
  assert.equal((await fetch(`${base}/v1/memory/brain`)).status, 401);
  assert.equal((await self("U-member", "PUT", own, { triggered: true })).status, 403);
  assert.equal((await self("U-member", "PUT", own, { liveActor: false })).status, 403);

  const put = await self("U-member", "PUT", own);
  assert.equal(put.status, 200);
  assert.equal(put.json.principalId, "U-member");
  assert.deepEqual(
    [put.json.brain?.id, put.json.brain?.auth, put.json.binding?.scope, put.json.disabled.map(({ code }) => code)],
    [id, { clientId: "member-qm", hasClientSecret: false }, "personal:U-member", ["secret_missing"]],
  );
  assert.deepEqual((await self("U-member", "GET")).json.brain, put.json.brain);

  const notTheirs = await mint("U-bob", { memoryBrain: id, purpose: "connect it" });
  assert.equal(notTheirs.status, 403);
  assert.match(JSON.parse(notTheirs.text).message, /only an org admin or the brain's owner/);
  const link = await mint("U-member", { memoryBrain: id, purpose: "connect my brain" });
  assert.equal(link.status, 200);
  assert.match((await link.form()).text, /your personal memory/);
  assert.equal((await link.redeem("member-secret-one")).status, 200);
  assert.equal(await servedSecret(id), "member-secret-one");
  const served = (await self("U-member", "GET")).json;
  assert.deepEqual([served.brain?.auth.hasClientSecret, served.disabled], [true, []]);

  const early = await mint("U-member", { memoryBrain: id, purpose: "rotate it" });
  await built.memoryRegistry.update((record) => setMemberBrains(record, { enabled: false }));
  const off = (await self("U-member", "GET")).json;
  assert.deepEqual([off.memberBrains, off.disabled.map(({ code }) => code)], [false, ["member_brains_off"]]);
  assert.equal((await mint("U-member", { memoryBrain: id, purpose: "p" })).status, 403);
  const refused = await early.redeem("member-secret-two");
  assert.equal(refused.status, 403);
  assert.match(JSON.parse(refused.text).message, /turned off/);

  const gone = await self("U-member", "DELETE");
  assert.deepEqual([gone.status, gone.json.brain, gone.json.binding], [200, null, null]);
  assert.equal(
    readRegistry((await built.memoryRegistry.current()).record).brains.some((brain) => brain.id === id),
    false,
  );
  const actions = ["member-brain.update", "member-brain.delete", "brain.secret.refused"].map(
    (action) => `memory-registry.${action}`,
  );
  let rows = "";
  for (let waited = 0; waited < 2_000; waited += 20) {
    rows = JSON.stringify(await built.auditLog.events());
    if (actions.every((action) => rows.includes(action))) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  for (const action of actions) assert.ok(rows.includes(action), action);
  assert.doesNotMatch(rows, /member-secret-/);
});

test("a member's brain fields are bounded, a repeated save writes nothing, and the record is schema 2 while it holds one", async (t) => {
  const { built, mint, self } = await setup(t);
  const own = { url: "https://brain.member.example/mcp", clientId: "member-qm" };
  const stored = async () => {
    const { version, record } = await built.memoryRegistry.current();
    return { version, schema: readRegistry(record).schema };
  };
  const long = "x".repeat(8_001);
  for (const body of [
    { ...own, url: `${own.url}?${long}` },
    { ...own, clientId: long },
    { ...own, label: long },
  ]) {
    const refused = await self("U-member", "PUT", body);
    assert.equal(refused.status, 400);
    assert.match(refused.json.message, /together can be at most 8000 characters/);
  }
  assert.equal((await stored()).schema, 1);

  assert.equal((await self("U-member", "PUT", own)).status, 200);
  const saved = await stored();
  assert.equal(saved.schema, 2);
  const repeated = await self("U-member", "PUT", own);
  assert.deepEqual(
    [repeated.status, repeated.json.brain?.auth.clientId, (await stored()).version],
    [200, "member-qm", saved.version],
  );
  assert.equal((await self("U-member", "PUT", { label: "Mine" })).status, 200);
  assert.notEqual((await stored()).version, saved.version);

  const link = await mint("U-member", { memoryBrain: memberBrainId("U-member"), purpose: "connect my brain" });
  const before = await stored();
  const oversized = await link.redeem(long);
  assert.equal(oversized.status, 400, oversized.text);
  assert.match(JSON.parse(oversized.text).message, /client secret can be at most 8000 characters/);
  assert.deepEqual(await stored(), before);

  assert.equal((await self("U-member", "DELETE")).status, 200);
  assert.equal((await stored()).schema, 1);
});

test("a signed-in admin mints a brain link from the browser, and a signed-in member is refused", async (t) => {
  const { browserMint } = await setup(t);
  const brainDrop = { memoryBrain: "acme-personal", purpose: "connect it" };
  const member = await browserMint("U-member", brainDrop);
  assert.equal(member.status, 403, member.text);
  const admin = await browserMint("admin-alice", brainDrop);
  assert.equal(admin.status, 200, admin.text);
  assert.match((JSON.parse(admin.text) as { formPath: string }).formPath, /^\/drop\//);
});
