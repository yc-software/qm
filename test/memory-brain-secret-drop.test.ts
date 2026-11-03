import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { CAPABILITY_TTL_MS, mintCapabilityToken, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { orgId } from "../src/config.ts";
import { putBinding, putBrain, type MemoryRegistry } from "../src/memory/registry.ts";
import { scopeId } from "../src/types.ts";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const SECRET = "memory-brain-drop-test-secret".repeat(2);
const change = { actor: "admin-alice", now: 1_762_128_000_000, overlayIds: new Set<string>() };
const BRAIN = {
  preset: "gbrain-v1",
  url: "https://brain.acme.example/mcp",
  clientId: "qm-personal",
  label: "Acme personal memory",
};

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const built = buildApp(testConfig({ signingSecret: SECRET }));
  await built.memoryRegistry.update((record) =>
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
    auditLog: built.auditLog,
    admin: built.admin,
    memoryRegistry: built.memoryRegistry,
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
      form: () => signed("GET", `/v1/keychain/drops/${json!.dropId}/form?t=${encodeURIComponent(t)}`, "", actorId),
      redeem: (secret: string) =>
        signed(
          "POST",
          `/v1/keychain/drops/${json!.dropId}?t=${encodeURIComponent(t)}`,
          JSON.stringify({ secret }),
          actorId,
        ),
    };
  };
  const stored = async () => ((await built.memoryRegistry.current()).record as MemoryRegistry).brains[0]!;
  return { built, mint, stored };
}

test("an org admin's brain link saves the client secret core-only, from a project and from a DM", async (t) => {
  const { built, mint, stored } = await setup(t);
  await built.app.upsertDirectory([{ principalId: "admin-alice", displayName: "Alice", type: "internal" }]);
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
  assert.match(form.text, /Acme personal memory at https:\/\/brain\.acme\.example/);
  assert.match(form.text, /every member&#39;s personal memory/);
  const saved = await fromProject.redeem("brain-secret-one");
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(saved.text), { ok: true, brain: "acme-personal" });
  assert.equal((await stored()).auth.clientSecret, "brain-secret-one");

  const fromDm = await mint("admin-alice", { memoryBrain: "acme-personal", purpose: "rotate it" });
  assert.equal(fromDm.status, 200);
  assert.equal((await fromDm.redeem("brain-secret-two")).status, 200);
  assert.equal((await stored()).auth.clientSecret, "brain-secret-two");
  assert.equal((await fromDm.redeem("brain-secret-three")).status, 404, "a link works once");

  assert.deepEqual(await built.keychain!.listByOwner("admin-alice"), [], "nothing enters a keychain");
  assert.deepEqual(await built.keychain!.listGrants({ ownerId: "admin-alice" }), [], "nothing is granted");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rows = JSON.stringify(await built.auditLog.events());
  assert.match(rows, /memory-registry\.brain\.secret/);
  assert.doesNotMatch(rows, /brain-secret-/);
});

test("a brain link refuses non-admins, other drop fields, unknown and moved brains, and a demoted admin", async (t) => {
  const { built, mint, stored } = await setup(t);
  const brainDrop = { memoryBrain: "acme-personal", purpose: "connect it" };
  assert.equal((await mint("U-member", brainDrop)).status, 403);
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
  const moved = await beforeMove.redeem("for-the-old-url");
  assert.equal(moved.status, 409);
  assert.doesNotMatch(moved.text, /for-the-old-url/);
  assert.equal((await stored()).auth.clientSecret, undefined);

  const alice = { id: "admin-alice", type: "internal" as const };
  await built.admin.createGrant(alice, {
    principalId: "admin-carol",
    role: "org_admin",
    scopeId: scopeId("org", orgId()),
  });
  const carols = await mint("admin-carol", brainDrop);
  assert.equal(carols.status, 200);
  await built.admin.revokeGrant(alice, "admin-carol", scopeId("org", orgId()), "org_admin");
  assert.equal((await carols.redeem("from-a-former-admin")).status, 403);
  assert.equal((await stored()).auth.clientSecret, undefined);
});
