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
    exportFiles: async (_h: SandboxHandle, opts?: { include?: Array<"workspace" | "home"> }) => {
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
  assert.equal(r.audience?.kind, "owner", "a new app is private to its owner");
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

test("first publish is owner-only in every conversation kind", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  const cases = [
    channel(deploy, acl, config, "U1", "C1", { isPrivate: false }),
    channel(deploy, acl, config, "U1", "C2", { isPrivate: true, members: [internal("U1"), internal("U2")] }),
    ctxFor(deploy, acl, config, {
      actor: "U1",
      contextScope: scopeId("group", "G1"),
      kind: "group",
      members: [internal("U1"), internal("U2")],
    }),
  ];
  for (const [i, ctx] of cases.entries()) {
    const r = await ctx.publish({ entrypoint: "node server.js", name: `app-${i}` });
    assert.equal(r.audience?.kind, "owner");
    assert.deepEqual(await deploy.deploymentGrantees(`app-${i}`), []);
    assert.equal((await deploy.getDeployment(`app-${i}`))?.public, undefined);
    assert.notEqual((await deploy.reachDeployment(`app-${i}`, "U2")).status, "ok");
  }
});

test("publish refuses visibility inputs and points to the share action", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  const ctx = channel(deploy, acl, config, "U1", "C1", { isPrivate: false });
  for (const extra of [
    { public: true },
    { public: false },
    { share: [] },
    { share: [{ scope: orgScope, permission: "read" as const }] },
  ]) {
    await assert.rejects(
      () => ctx.publish({ entrypoint: "node server.js", name: "site", ...extra }),
      /apps action share/,
    );
  }
  assert.equal(await deploy.getDeployment("site"), null);
});

test("sharing after publish grants access separately", async () => {
  const { deploy, acl } = svc();
  const config = createMemoryConfigStore(ORG);
  await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  await deploy.shareDeployment("site", scopeId("personal", "U2"), "read", { createdBy: "U1" });
  assert.equal((await deploy.reachDeployment("site", "U2")).status, "ok");
  const again = await channel(deploy, acl, config, "U1", "C1", { isPrivate: false }).publish({
    entrypoint: "node server.js",
    name: "site",
  });
  assert.equal(again.version, 2);
  assert.deepEqual(await deploy.deploymentGrantees("site"), [{ scope: scopeId("personal", "U2"), permission: "read" }]);
});
