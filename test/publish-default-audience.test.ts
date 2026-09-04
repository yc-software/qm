import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import { createDeployStore, type DeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService, type DeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore, type AclStore } from "../src/acl/acl-store.ts";
import { createMemoryConfigStore, type ScopedConfigStore } from "../src/resolution/config-store.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId, type ConversationKind, type Principal } from "../src/types.ts";

const ORG = "default-org";
const orgScope = scopeId("org", ORG);
const internal = (id: string): Principal => ({ id, type: "internal" });

function svc() {
  const deployStore: DeployStore = createDeployStore();
  const acl: AclStore = createAclStore();
  const deploy: DeployService = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 20000 }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "pda-")),
  });
  return { deploy, deployStore, acl };
}

const onlyFile: Array<{ path: string; data: Uint8Array }> = [
  { path: "server.js", data: new TextEncoder().encode("listen") },
];

function fileSandbox(): Sandbox {
  return {
    listDir: async (_h: SandboxHandle, dir: string) =>
      onlyFile.filter((f) => !dir || dir === "." || f.path === dir).map((f) => f.path),
    readFileBytes: async (_h: SandboxHandle, p: string) => onlyFile.find((f) => f.path === p)?.data ?? null,
    backupComputer: async (_h: SandboxHandle, opts?: { include?: Array<"workspace" | "home"> }) => {
      if (opts?.include?.includes("home")) return [];
      return onlyFile.map((f) => ({ area: "workspace" as const, path: f.path, data: f.data }));
    },
  } as unknown as Sandbox;
}

function ctxFor(
  deploy: DeployService,
  acl: AclStore,
  config: ScopedConfigStore,
  opts: {
    actor: string;
    contextScope: string;
    kind: ConversationKind;
    channelRef?: string;
    isPrivate?: boolean;
    members?: Principal[];
  },
) {
  const deps: ToolContextDeps = {
    sandbox: fileSandbox(),
    provision: async () => ({}) as SandboxHandle,
    layers: [
      { scopeId: orgScope, mountPath: "global", mode: "ro" },
      { scopeId: opts.contextScope, mountPath: "", mode: "rw" },
    ],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy,
    acl,
    createdBy: opts.actor,
    config,
    publishContext: {
      conversationKind: opts.kind,
      ...(opts.channelRef ? { channelRef: opts.channelRef } : {}),
      ...(opts.isPrivate !== undefined ? { isPrivate: opts.isPrivate } : {}),
      ...(opts.members ? { publishMembers: opts.members } : {}),
    },
  };
  return createToolContext(deps);
}

const channel = (
  deploy: DeployService,
  acl: AclStore,
  config: ScopedConfigStore,
  actor: string,
  ref: string,
  extra: { isPrivate?: boolean; members?: Principal[] } = {},
) =>
  ctxFor(deploy, acl, config, {
    actor,
    contextScope: scopeId("channel", ref),
    kind: "channel",
    channelRef: ref,
    ...extra,
  });

test("D1: a channel publish is owned by personal:<initiator>, channel recorded as origin", async () => {
  const { deploy, deployStore, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  const r = await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  const d = (await deployStore.getByName("site"))!;
  assert.equal(d.ownerScopeId, scopeId("personal", "U1"), "owned by the initiator, not the channel");
  assert.equal(d.createdInScope, scopeId("channel", "C1"), "channel recorded as origin metadata");
  assert.equal(r.audience?.kind, "org");
});

test("D1: owner always reaches their own app; canManage recognizes the owner acting from the channel", async () => {
  const { deploy, deployStore, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  const d = (await deployStore.getByName("site"))!;
  assert.equal((await deploy.reachDeployment("site", "U1")).status, "ok");
  const again = await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  assert.equal(again.version, 2, "owner redeploys from the channel");
  assert.equal((await deployStore.get(d.id))!.currentVersion, 2);
});

test("D1: a member acting in the creation channel may manage the app (recover/re-share)", async () => {
  const { deploy, deployStore, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  const again = await channel(deploy, acl, config, "U2", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  assert.equal(again.version, 2, "channel co-member redeploys the app created in their channel");
  const renamed = await channel(deploy, acl, config, "U2", "C1").publish({ renameFrom: "site", name: "site-v2" });
  assert.equal(renamed.name, "site-v2");
  assert.equal(
    (await deployStore.getByName("site-v2"))!.ownerScopeId,
    scopeId("personal", "U1"),
    "ownership unchanged",
  );
});

test("Defect-2: acting in a different channel than the one the app was created in does not confer manage", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  await assert.rejects(
    () =>
      channel(deploy, acl, config, "U2", "C2", { isPrivate: false }).publish({
        entrypoint: "node server.js",
        name: "site",
      }),
    /name taken/,
  );
  await assert.rejects(
    () => channel(deploy, acl, config, "U2", "C2").publish({ renameFrom: "site", name: "hijacked" }),
    /not authorized/,
  );
});

test("D2: public channel publish is reachable org-wide via an org read grant", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  assert.equal(
    (await deploy.reachDeployment("site", "U-anyone")).status,
    "ok",
    "any verified principal reaches a public-channel app",
  );
});

test("D2: private channel publish grants current internal members by default", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  const r = await channel(deploy, acl, config, "U1", "C2", {
    isPrivate: true,
    members: [internal("U1"), internal("U2")],
  }).publish({ entrypoint: "node server.js", name: "priv" });
  assert.equal(r.audience?.kind, "members");
  assert.equal(r.audience?.memberCount, 1);
  assert.equal((await deploy.reachDeployment("priv", "U1")).status, "ok");
  assert.equal((await deploy.reachDeployment("priv", "U2")).status, "ok");
});

test("D2: private channel grants exclude the owner", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  const r = await channel(deploy, acl, config, "U1", "C2", {
    isPrivate: true,
    members: [internal("U1"), internal("U2"), internal("U3")],
  }).publish({ entrypoint: "node server.js", name: "priv" });
  assert.equal(r.audience?.kind, "members");
  assert.equal(r.audience?.memberCount, 2);
  assert.equal((await deploy.reachDeployment("priv", "U2")).status, "ok");
  assert.equal((await deploy.reachDeployment("priv", "U3")).status, "ok");
  assert.equal((await deploy.reachDeployment("priv", "U9")).status, "denied");
});

test("D3: republish from the originating channel reconciles — joiner added, leaver revoked", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C2", {
    isPrivate: true,
    members: [internal("U1"), internal("U2"), internal("U3")],
  }).publish({ entrypoint: "node server.js", name: "priv" });
  await channel(deploy, acl, config, "U1", "C2", {
    isPrivate: true,
    members: [internal("U1"), internal("U2"), internal("U4")],
  }).publish({ entrypoint: "node server.js", name: "priv" });
  assert.equal((await deploy.reachDeployment("priv", "U2")).status, "ok", "U2 stays");
  assert.equal((await deploy.reachDeployment("priv", "U4")).status, "ok", "U4 added");
  assert.equal((await deploy.reachDeployment("priv", "U3")).status, "denied", "U3 revoked");
});

test("D3: a redeploy from a DM/other context never shrinks or shifts the default audience", async () => {
  const { deploy, deployStore, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C2", {
    isPrivate: true,
    members: [internal("U1"), internal("U2"), internal("U3")],
  }).publish({ entrypoint: "node server.js", name: "priv" });
  const dmCtx = ctxFor(deploy, acl, config, { actor: "U1", contextScope: scopeId("personal", "U1"), kind: "dm" });
  await dmCtx.publish({ entrypoint: "node server.js", name: "priv" });
  assert.equal((await deploy.reachDeployment("priv", "U2")).status, "ok");
  assert.equal((await deploy.reachDeployment("priv", "U3")).status, "ok");
  assert.equal((await deployStore.getByName("priv"))!.currentVersion, 2, "the redeploy still shipped a version");
});

test("D3: an incomplete enumeration leaves the prior audience FROZEN (no silent revoke)", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C2", {
    isPrivate: true,
    members: [internal("U1"), internal("U2")],
  }).publish({ entrypoint: "node server.js", name: "priv" });
  assert.equal((await deploy.reachDeployment("priv", "U2")).status, "ok");
  const r = await channel(deploy, acl, config, "U1", "C2", { isPrivate: true }).publish({
    entrypoint: "node server.js",
    name: "priv",
  });
  assert.equal((await deploy.reachDeployment("priv", "U2")).status, "ok", "U2's reach is left frozen, not revoked");
  assert.equal(r.audience?.kind, "members");
  assert.equal(r.audience?.memberCount, 1);
});

test("D7: a redeploy from a DM reports the FROZEN channel audience, not this turn's owner-only", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C2", {
    isPrivate: true,
    members: [internal("U1"), internal("U2"), internal("U3")],
  }).publish({ entrypoint: "node server.js", name: "priv" });
  const dmCtx = ctxFor(deploy, acl, config, { actor: "U1", contextScope: scopeId("personal", "U1"), kind: "dm" });
  const r = await dmCtx.publish({ entrypoint: "node server.js", name: "priv" });
  assert.equal(r.audience?.kind, "members", "the reply states the real (frozen) channel reach, not owner-only");
  assert.equal(r.audience?.memberCount, 2);
  assert.equal(r.audience?.channelRef, "C2");
});

test("D3: an UNKNOWN privacy signal (e.g. flaky conversations.info) FREEZES — never revokes a public app's org reach", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  assert.equal((await deploy.reachDeployment("site", "U-anyone")).status, "ok");
  const r = await channel(deploy, acl, config, "U1", "C1", { members: [internal("U1"), internal("U2")] }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  assert.equal(
    (await deploy.reachDeployment("site", "U-anyone")).status,
    "ok",
    "org reach frozen, not silently revoked",
  );
  assert.match(r.audience?.note ?? "", /public\/private|leaving reach unchanged/);
});

test("D3: a complete enumeration finding only the owner revokes prior default members", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C2", {
    isPrivate: true,
    members: [internal("U1"), internal("U2"), internal("U3")],
  }).publish({ entrypoint: "node server.js", name: "priv" });
  await channel(deploy, acl, config, "U1", "C2", { isPrivate: true, members: [internal("U1")] }).publish({
    entrypoint: "node server.js",
    name: "priv",
  });
  assert.equal((await deploy.reachDeployment("priv", "U2")).status, "denied");
  assert.equal((await deploy.reachDeployment("priv", "U3")).status, "denied");
});

test("D5: an explicit opt-out (share:[]) issued from a DM still applies — owner directive bypasses source-binding", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  assert.equal((await deploy.reachDeployment("site", "U-anyone")).status, "ok");
  const dmCtx = ctxFor(deploy, acl, config, { actor: "U1", contextScope: scopeId("personal", "U1"), kind: "dm" });
  await dmCtx.publish({ entrypoint: "node server.js", name: "site", share: [] });
  assert.equal(
    (await deploy.reachDeployment("site", "U-anyone")).status,
    "denied",
    "opt-out from a DM dropped the org grant",
  );
  assert.equal((await deploy.reachDeployment("site", "U1")).status, "ok");
});

test("D3/D5: reconcile revoking a departed default member PRESERVES the owner's explicit write co-manager grant", async () => {
  const { deploy, deployStore, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C2", {
    isPrivate: true,
    members: [internal("U1"), internal("U2"), internal("U3")],
  }).publish({
    entrypoint: "node server.js",
    name: "priv",
    share: [{ scope: scopeId("personal", "U2"), permission: "write" }],
  });
  await channel(deploy, acl, config, "U1", "C2", {
    isPrivate: true,
    members: [internal("U1"), internal("U3")],
  }).publish({ entrypoint: "node server.js", name: "priv" });
  const id = (await deployStore.getByName("priv"))!.id;
  const grants = await acl.grantsFor(scopeId("personal", "U1"), `deployment:${id}`);
  const u2 = grants.filter((g) => g.granteeScopeId === scopeId("personal", "U2"));
  assert.ok(
    u2.some((g) => g.permission === "write"),
    "explicit write co-manager grant survives reconcile",
  );
  assert.ok(!u2.some((g) => g.permission === "read"), "the departed member's default read grant is revoked");
  assert.equal(
    (await deploy.reachDeployment("priv", "U2")).status,
    "ok",
    "U2 still reaches via the surviving write grant",
  );
});

test("D4: a first publish whose member enumeration is incomplete reports a user-visible 'share manually' note", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  const r = await channel(deploy, acl, config, "U1", "C2", { isPrivate: true }).publish({
    entrypoint: "node server.js",
    name: "priv",
  });
  assert.equal(r.audience?.kind, "owner");
  assert.match(r.audience?.note ?? "", /enumerate|share manually/);
  assert.equal((await deploy.reachDeployment("priv", "U2")).status, "denied", "no silent partial grant");
});

test("D3: a redeploy from a DIFFERENT channel never shifts reach to the wrong channel's members", async () => {
  const { deploy, deployStore, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C2", {
    isPrivate: true,
    members: [internal("U1"), internal("U2"), internal("U3")],
  }).publish({ entrypoint: "node server.js", name: "priv" });
  await channel(deploy, acl, config, "U1", "C3", {
    isPrivate: true,
    members: [internal("U1"), internal("U7"), internal("U8")],
  }).publish({ entrypoint: "node server.js", name: "priv" });
  assert.equal((await deploy.reachDeployment("priv", "U2")).status, "ok", "origin members frozen");
  assert.equal((await deploy.reachDeployment("priv", "U3")).status, "ok", "origin members frozen");
  assert.equal((await deploy.reachDeployment("priv", "U7")).status, "denied", "wrong-channel members NOT granted");
  assert.equal((await deploy.reachDeployment("priv", "U8")).status, "denied", "wrong-channel members NOT granted");
  const id = (await deployStore.getByName("priv"))!.id;
  const grantees = (await acl.grantsFor(scopeId("personal", "U1"), `deployment:${id}`))
    .map((g) => g.granteeScopeId)
    .sort();
  assert.deepEqual(
    grantees,
    [scopeId("personal", "U2"), scopeId("personal", "U3")].sort(),
    "default set unchanged (not shifted to C3)",
  );
});

test("D3: public → private transition drops the org grant on the next ship", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  assert.equal((await deploy.reachDeployment("site", "U-anyone")).status, "ok");
  await channel(deploy, acl, config, "U1", "C1", {
    isPrivate: true,
    members: [internal("U1"), internal("U2")],
  }).publish({ entrypoint: "node server.js", name: "site" });
  assert.equal((await deploy.reachDeployment("site", "U-anyone")).status, "denied", "org grant dropped");
  assert.equal((await deploy.reachDeployment("site", "U1")).status, "ok", "owner still reaches");
});

test("D5: an explicit share layers on top of the public default (org + the named person)", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
    share: [{ scope: scopeId("personal", "U9"), permission: "write" }],
  });
  assert.equal((await deploy.reachDeployment("site", "U-anyone")).status, "ok");
  const after = await channel(deploy, acl, config, "U9", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  assert.equal(after.version, 2, "an explicit write-grant holder may redeploy");
});

test("D5: an explicit EMPTY share opts out → owner-only, even from a public channel", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  const r = await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
    share: [],
  });
  assert.equal(r.audience?.kind, "owner");
  assert.equal((await deploy.reachDeployment("site", "U-anyone")).status, "denied", "no org grant when opted out");
  assert.equal((await deploy.reachDeployment("site", "U1")).status, "ok");
});

test("D5: only the OWNER may widen — even a write-grant manager cannot re-share (anti-re-share)", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
    share: [{ scope: scopeId("personal", "U9"), permission: "write" }],
  });
  await assert.rejects(
    () =>
      channel(deploy, acl, config, "U9", "C1", { isPrivate: false }).publish({
        entrypoint: "node server.js",
        name: "site",
        share: [{ scope: scopeId("personal", "U7"), permission: "read" }],
      }),
    /only a manager/,
  );
});

test("Alternatives: opt-in collective management — an explicit channel write grant lets any member manage", async () => {
  const { deploy, deployStore, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "team-tool",
    share: [{ scope: scopeId("channel", "C2"), permission: "write" }],
  });
  const r = await channel(deploy, acl, config, "U2", "C2", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "team-tool",
  });
  assert.equal(r.version, 2, "a channel member manages via the opt-in channel write grant");
  assert.equal((await deployStore.getByName("team-tool"))!.ownerScopeId, scopeId("personal", "U1"));
});

test("D5: a member outside the creation channel cannot redeploy-to-share the owner's app", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  await assert.rejects(
    () =>
      channel(deploy, acl, config, "U2", "C2", { isPrivate: false }).publish({
        entrypoint: "node server.js",
        name: "site",
        share: [{ scope: orgScope, permission: "read" }],
      }),
    /name taken/,
  );
});
