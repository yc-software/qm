import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, type App, type AppDeps } from "../src/api/app.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createWebhookStore } from "../src/webhooks/webhook-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createSkillStore } from "../src/skills/skill-store.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";

const ORG = "default-org";
const U1 = "U1";
const C1 = "C1";
const channelScope = scopeId("channel", C1);
const orgScope = scopeId("org", ORG);

function makeDeps() {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const crons = createCronStore();
  const webhooks = createWebhookStore();
  const acl = createAclStore();
  const identity = {
    classify: (id: string) => ({ id, type: "internal" }),
    isInternal: (p: { type: string }) => p.type === "internal",
  };
  const directory = {
    listChannelsFor: async (principalId: string) =>
      principalId === U1 ? [{ channelId: C1, name: "general", isPrivate: true }] : [],
    channelMember: async (channelId: string, principalId: string) => principalId === U1 && channelId === C1,
    channelPrivacy: async (channelId: string): Promise<boolean | undefined> => (channelId === C1 ? true : undefined),
  };
  const sessions: { listByParticipant: (principalId: string) => Promise<unknown[]> } = {
    listByParticipant: async (_p: string) => [],
  };
  const skills = createSkillStore();
  const deployRows: Deployment[] = [];
  const deploy = { listDeployments: async () => deployRows };
  return { files, crons, webhooks, acl, identity, directory, sessions, skills, deploy, deployRows };
}

async function setup(): Promise<{ app: App; deps: ReturnType<typeof makeDeps> }> {
  const deps = makeDeps();
  await deps.files.put({
    id: "f-channel",
    ownerScopeId: scopeId("personal", "U2"),
    createdBy: "U2",
    name: "report.pdf",
    path: "report.pdf",
    mimetype: "application/pdf",
    data: Buffer.from("pdf"),
    direction: "out",
    createdInScope: channelScope,
    createdAt: 5,
  });
  await deps.acl.grant({
    ownerScopeId: scopeId("personal", "U2"),
    ref: "report.pdf",
    granteeScopeId: orgScope,
    permission: "read",
    grantedBy: "U2",
  });
  await deps.files.put({
    id: "f-other",
    ownerScopeId: scopeId("personal", U1),
    createdBy: U1,
    name: "elsewhere.txt",
    path: "elsewhere.txt",
    mimetype: "text/plain",
    data: Buffer.from("txt"),
    direction: "out",
    createdInScope: scopeId("channel", "C2"),
    createdAt: 6,
  });
  await deps.crons.create({
    schedule: { everyMs: 60_000 },
    action: "summarize",
    owner: "U2",
    createdBy: "U2",
    ownerScopeId: channelScope,
  });
  await deps.webhooks.create({
    action: "triage",
    verification: { scheme: "github", secret: "scope-secret" },
    owner: "U2",
    createdBy: "U2",
    ownerScopeId: channelScope,
  });
  await deps.crons.create({
    schedule: { everyMs: 60_000 },
    action: "elsewhere",
    owner: "U3",
    createdBy: "U3",
    ownerScopeId: scopeId("channel", "C2"),
  });
  await deps.skills.create({
    scopeId: channelScope,
    manifest: { name: "triage", description: "label inbound mail", requiredCapabilities: [], body: "# Triage" },
    createdBy: "U2",
  });
  await deps.skills.create({
    scopeId: scopeId("channel", "C2"),
    manifest: { name: "other", description: "elsewhere", requiredCapabilities: [], body: "# Other" },
    createdBy: "U3",
  });
  deps.deployRows.push(
    {
      id: "d-c1",
      ownerScopeId: scopeId("personal", "U2"),
      createdBy: "U2",
      createdInScope: channelScope,
      displayName: "C1 dashboard",
      currentVersion: 2,
      status: "running",
      endpoint: null,
      versions: [],
    },
    {
      id: "d-c2",
      ownerScopeId: scopeId("personal", "U3"),
      createdBy: "U3",
      createdInScope: scopeId("channel", "C2"),
      currentVersion: 1,
      status: "running",
      endpoint: null,
      versions: [],
    },
  );
  await deps.crons.create({
    schedule: { everyMs: 60_000 },
    action: "mine",
    owner: U1,
    createdBy: U1,
    ownerScopeId: scopeId("personal", U1),
  });
  await deps.files.put({
    id: "f-personal",
    ownerScopeId: scopeId("personal", U1),
    createdBy: U1,
    name: "notes.md",
    path: "notes.md",
    mimetype: "text/markdown",
    data: Buffer.from("md"),
    direction: "out",
    createdInScope: scopeId("personal", U1),
    createdAt: 7,
  });
  return { app: createApp(deps as unknown as AppDeps), deps };
}

test("a member sees a channel's files (incl. personally-owned deliverables), webhooks, crons, deployments and skills", async () => {
  const { app } = await setup();
  const out = await app.listScopeResources(U1, channelScope);
  assert.ok(out, "U1 is a member of C1");
  assert.deepEqual(
    out!.files.map((f) => f.name),
    ["report.pdf"],
  );
  assert.equal(out!.crons.length, 1, "only C1's cron, not C2's");
  assert.equal(out!.crons[0]!.action, "summarize");
  assert.equal(out!.webhooks.length, 1);
  assert.equal(out!.webhooks[0]!.action, "triage");
  assert.deepEqual(
    out!.deployments.map((d) => d.name),
    ["C1 dashboard"],
  );
  assert.equal(out!.deployments[0]!.permission, "write");
  assert.deepEqual(
    out!.skills.map((s) => s.name),
    ["triage"],
  );
  assert.equal(out!.skills[0]!.description, "label inbound mail");
  assert.equal(out!.manageable, true);
});

test("a member of a PUBLIC channel may read its resources but NOT manage them", async () => {
  const deps = makeDeps();
  const PUB = "PUB";
  const pubScope = scopeId("channel", PUB);
  deps.directory.listChannelsFor = async (p: string) =>
    p === U1 ? [{ channelId: PUB, name: "town-square", isPrivate: false }] : [];
  deps.directory.channelMember = async (c: string, p: string) => p === U1 && c === PUB;
  deps.directory.channelPrivacy = async (c: string): Promise<boolean | undefined> => (c === PUB ? false : undefined);
  await deps.crons.create({
    schedule: { everyMs: 60_000 },
    action: "pub",
    owner: "U2",
    createdBy: "U2",
    ownerScopeId: pubScope,
  });
  const app = createApp(deps as unknown as AppDeps);
  const out = await app.listScopeResources(U1, pubScope);
  assert.ok(out, "U1 can read the public channel's resources");
  assert.equal(out!.crons.length, 1);
  assert.equal(out!.manageable, false, "a public channel stays owner-only");
});

test("owning a resource in a scope does NOT grant access to that scope's context", async () => {
  const { app } = await setup();
  assert.equal(await app.listScopeResources("U2", channelScope), null);
});

test("historical participation grants neither context listing nor current scope resources", async () => {
  const deps = makeDeps();
  deps.sessions.listByParticipant = async (principalId: string) =>
    principalId === "U2"
      ? [
          {
            id: "old",
            threadRef: "old",
            type: "channel",
            scopeId: channelScope,
            channelName: "general",
            createdAt: 1,
            lastActivityAt: 2,
            hasEntries: true,
          },
        ]
      : [];
  await deps.skills.create({
    scopeId: channelScope,
    manifest: { name: "private", description: "private", requiredCapabilities: [], body: "# Private" },
    createdBy: U1,
  });
  const app = createApp(deps as unknown as AppDeps);

  assert.ok(!(await app.listContexts("U2")).some((context) => context.scopeId === channelScope));
  assert.equal(await app.listScopeResources("U2", channelScope), null);
  assert.equal(await app.belongsToScope("U2", channelScope), false);
  assert.ok(!(await app.listVisibleSkills("U2")).some((result) => result.skill?.scopeId === channelScope));
});

test("a context view never leaks another scope's files or crons", async () => {
  const { app } = await setup();
  const out = await app.listScopeResources(U1, channelScope);
  assert.ok(out);
  assert.ok(
    out!.files.every((f) => f.createdInScope === channelScope),
    "no file created in C2 (which U1 owns) appears",
  );
  assert.ok(
    out!.crons.every((c) => c.ownerScopeId === channelScope),
    "no cron from C2 appears",
  );
  assert.ok(
    out!.deployments.every((d) => d.id === "d-c1"),
    "no deployment created in C2 appears",
  );
  assert.ok(
    out!.skills.every((s) => s.name === "triage"),
    "no skill from C2 appears",
  );
});

test("personal contexts are isolated: a viewer sees their own, never a teammate's", async () => {
  const { app } = await setup();
  const mine = await app.listScopeResources(U1, scopeId("personal", U1));
  assert.ok(mine, "U1 can read their own personal context");
  assert.deepEqual(
    mine!.crons.map((c) => c.action),
    ["mine"],
  );
  assert.deepEqual(
    mine!.files.map((f) => f.name),
    ["notes.md"],
  );
  assert.equal(
    await app.listScopeResources(U1, scopeId("personal", "U2")),
    null,
    "U1 cannot read U2's personal context",
  );
});

test("every file a context lists is one the viewer is authorized to open", async () => {
  const { app, deps } = await setup();
  const out = await app.listScopeResources(U1, channelScope);
  assert.ok(out);
  for (const f of out!.files) {
    const art = await deps.files.get(f.id);
    assert.ok(art, "the listed file exists");
    const myScopes = [scopeId("personal", U1), orgScope];
    const ownedByViewer = myScopes.includes(art!.ownerScopeId);
    const grants = await deps.acl.grantsFor(art!.ownerScopeId, art!.path);
    const sharedToViewer = grants.some((g) => myScopes.includes(g.granteeScopeId));
    assert.ok(ownedByViewer || sharedToViewer, `${f.name} is openable by U1 (owned or ACL-granted)`);
  }
});

test("webhook secrets are redacted by the route, not the app layer", async () => {
  // The app returns the raw webhook (the route redacts). A C1 webhook created with a secret
  // still carries it here — proving redaction is the route's job, mirroring the flat list.
  const deps = makeDeps();
  await deps.webhooks.create({
    action: "signed",
    verification: { scheme: "hmac-sha256", secret: "topsecret" },
    owner: U1,
    createdBy: U1,
    ownerScopeId: channelScope,
  });
  const app = createApp(deps as unknown as AppDeps);
  const out = await app.listScopeResources(U1, channelScope);
  assert.equal(out!.webhooks[0]!.verification.secret, "topsecret");
});
