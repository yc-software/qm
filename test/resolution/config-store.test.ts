import "../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import type {
  PersistedInstructions,
  PersistedInstructionsRevision,
  PersistedBaseModel,
} from "../../src/resolution/config-store.ts";
import { CONFIG_TABLES } from "../../src/resolution/config-tables.ts";
import { typedTable } from "../../src/persistence/typed-table.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ApiCtx, respond } from "../../src/api/routes/route.ts";
import { postInstructions } from "../../src/api/routes/surface-config.ts";
import { createServer } from "../../src/api/server.ts";
import { mintPortalIdentity } from "../../src/auth/portal-identity.ts";
import { createPostgresReplayDedupe } from "../../src/auth/replay-dedupe.ts";
import { signRequest } from "../../src/auth/source-auth.ts";
import { resolveTurnFastMode } from "../../src/core/turn-options.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { defaultOrgPolicy } from "../../src/policy/command-policy.ts";
import { InstructionsTooLargeError, MAX_INSTRUCTIONS_CHARS } from "../../src/resolution/config-instructions.ts";
import { scopeId, type ScopeId } from "../../src/types.ts";
import { tenantFor, withTenant } from "../../src/tenant.ts";
import { buildApp as buildProductionApp } from "../../src/wiring.ts";
import { stopAtEnd } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { testConfigStore, testDatabaseUrl, failTableWrites } from "../support/test-database.ts";
import { listenLocal } from "../support/listen-local.ts";

function tables() {
  const databaseUrl = testDatabaseUrl();
  const db = createPgPool(databaseUrl);
  return {
    open: () => testConfigStore({ databaseUrl }),
    instructions: typedTable<PersistedInstructions>(db, CONFIG_TABLES.instructions),
    legacyHistory: typedTable<PersistedInstructionsRevision>(db, CONFIG_TABLES.instructionsHistory),
  };
}

test("SOUL compare-and-set permits only one writer and keeps current plus history in one durable row", async () => {
  const { open, instructions } = tables();
  const left = open();
  const right = open();
  const channel = scopeId("channel", "CAS");

  const results = await Promise.all([
    left.setInstructionsIfVersion(channel, 0, "left", "alice"),
    right.setInstructionsIfVersion(channel, 0, "right", "bob"),
  ]);
  assert.deepEqual(
    results.sort((a, b) => (a ?? 99) - (b ?? 99)),
    [1, null],
  );

  const durable = await instructions.get(channel);
  assert.equal(durable?.history?.length, 1);
  assert.equal(durable?.history?.[0]?.content, durable?.content);
  for (let version = 1; version < 30; version++) {
    assert.equal(
      await left.setInstructionsIfVersion(channel, version, `revision ${version + 1}`, "alice"),
      version + 1,
    );
  }
  assert.equal(
    (await instructions.get(channel))?.history?.length,
    30,
    "the canonical row retains the full durable history",
  );
  assert.equal(left.instructionsHistory(channel).length, 25, "the operator view remains bounded");
  const fresh = open();
  await fresh.hydrate?.();
  assert.equal(fresh.instructionsHistory(channel)[0]?.content, fresh.getInstructions(channel));
  await right.refreshScope(channel);
  assert.equal(
    right.instructionsHistory(channel)[0]?.content,
    right.getInstructions(channel),
    "a cross-instance refresh advances current SOUL and history together",
  );
});

test("SOUL snapshot restore preserves the canonical version and history byte-for-byte across cores", async () => {
  const { open } = tables();
  const left = open();
  const right = open();
  const channel = scopeId("channel", "snapshot");
  await left.setInstructions(channel, "one", "alice");
  await left.setInstructions(channel, "two", "bob");
  const snapshot = await left.captureInstructionsSnapshot(channel);

  await right.refreshScope(channel);
  await right.setInstructions(channel, "attempted import", "importer");
  assert.equal(await left.restoreInstructionsSnapshot(channel, snapshot), true);
  await right.refreshScope(channel);

  assert.deepEqual(await right.captureInstructionsSnapshot(channel), snapshot);
  assert.equal(right.getInstructions(channel), "two");
  assert.equal(right.instructionsVersion(channel), 2);
  assert.deepEqual(right.instructionsHistory(channel), snapshot?.history);
});

test("setInstructions advances the canonical row without trusting a stale instance cache", async () => {
  const { open, instructions } = tables();
  const left = open();
  const right = open();
  const channel = scopeId("channel", "latest");

  assert.equal(await left.setInstructions(channel, "left", "alice"), 1);
  assert.equal(right.instructionsVersion(channel), 0);
  assert.equal(await right.setInstructions(channel, "right", "bob"), 2);

  const durable = await instructions.get(channel);
  assert.equal(durable?.version, 2);
  assert.deepEqual(
    durable?.history?.map(({ version, content }) => ({ version, content })),
    [
      { version: 2, content: "right" },
      { version: 1, content: "left" },
    ],
  );
});

test("the first write after upgrade retains a canonical revision that predates embedded history", async () => {
  const { open, instructions } = tables();
  const channel = scopeId("channel", "pre-history-upgrade");
  await instructions.put(channel, { scopeId: channel, content: "pre-upgrade", version: 8 });
  const store = open();

  assert.equal(await store.setInstructions(channel, "post-upgrade", "alice"), 9);
  assert.deepEqual(
    (await instructions.get(channel))?.history?.map(({ version, content, updatedAt }) => ({
      version,
      content,
      updatedAt,
    })),
    [
      { version: 9, content: "post-upgrade", updatedAt: (await instructions.get(channel))!.updatedAt },
      { version: 8, content: "pre-upgrade", updatedAt: 0 },
    ],
  );
});

test("refreshScope merges legacy SOUL history into a canonical row and migrates it safely", async () => {
  const { open, instructions, legacyHistory } = tables();
  const channel = scopeId("channel", "legacy-refresh");
  const revision: PersistedInstructionsRevision = {
    scopeId: channel,
    content: "legacy current",
    version: 4,
    updatedAt: 40,
    updatedBy: "alice",
  };
  await instructions.put(channel, { ...revision });
  await legacyHistory.put(`${channel}:4`, revision);
  await legacyHistory.put(`${channel}:3`, {
    scopeId: channel,
    content: "legacy prior",
    version: 3,
    updatedAt: 30,
    updatedBy: "bob",
  });
  const store = open();

  await store.hydrate?.();
  await store.refreshScope(channel);
  await store.refreshScope(channel);

  assert.deepEqual(
    store.instructionsHistory(channel).map(({ version, content }) => ({ version, content })),
    [
      { version: 4, content: "legacy current" },
      { version: 3, content: "legacy prior" },
    ],
  );
  assert.deepEqual(
    (await instructions.get(channel))?.history,
    store.instructionsHistory(channel),
    "refresh atomically migrates legacy revisions into the canonical row",
  );
});

test("embedded history prevents a stale core from re-injecting legacy revisions after restore", async () => {
  const { open, instructions, legacyHistory } = tables();
  const restored = scopeId("channel", "legacy-restored");
  await instructions.put(restored, { scopeId: restored, content: "legacy current", version: 4, updatedAt: 40 });
  await legacyHistory.put(`${restored}:4`, { scopeId: restored, content: "legacy current", version: 4, updatedAt: 40 });
  await legacyHistory.put(`${restored}:3`, { scopeId: restored, content: "legacy prior", version: 3, updatedAt: 30 });
  const left = open();
  const stale = open();
  await Promise.all([left.hydrate?.(), stale.hydrate?.()]);

  const restoredSnapshot: PersistedInstructions = {
    scopeId: restored,
    content: "restored canonical",
    version: 1,
    updatedAt: 50,
    history: [],
  };
  assert.equal(await left.restoreInstructionsSnapshot(restored, restoredSnapshot), true);
  await stale.refreshScope(restored);
  assert.deepEqual((await instructions.get(restored))?.history, []);
  assert.equal(await stale.setInstructions(restored, "after restore", "bob"), 2);
  assert.deepEqual(
    (await instructions.get(restored))?.history?.map(({ version, content }) => ({ version, content })),
    [
      { version: 2, content: "after restore" },
      { version: 1, content: "restored canonical" },
    ],
  );
});

test("pg config store: scoped soul/policy/egress/flags survive a restart (write-through + hydrate)", async () => {
  const { open } = tables();
  const ch = scopeId("channel", "C1");
  const policy = defaultOrgPolicy();

  const a = open();
  const version = await a.setInstructions(ch, "a channel-specific soul");
  await a.setSetting("commandPolicy", policy, ch);
  await a.setApprovalGrantModes(ch, { session: false, always: true });
  await a.setSetting("egress", { allowedHosts: ["api.example.com"], deniedHosts: ["evil.example"] }, ch);
  await a.setRuntimeSelection(ch, { modelId: "claude-opus-4-8" });
  await a.setSetting("browseMaxSteps", 120, ch);
  await a.setSetting("browseModel", "claude-sonnet-4-6", ch);

  const b = open();
  assert.equal(b.getInstructions(ch), null, "a cold instance has no scoped soul until it hydrates");
  await b.hydrate?.();

  assert.equal(b.getInstructions(ch), "a channel-specific soul", "the scoped soul survived the restart");
  assert.equal(b.instructionsVersion(ch), version, "the soul version round-trips (monotonic across restart)");
  assert.equal(
    b.instructionsHistory(ch)[0]?.content,
    "a channel-specific soul",
    "the revision history survives a restart",
  );
  assert.deepEqual(b.setting("commandPolicy", ch), policy, "the command policy survived");
  assert.deepEqual(
    b.setting("egress", ch),
    { allowedHosts: ["api.example.com"], deniedHosts: ["evil.example"] },
    "the egress policy survived",
  );
  assert.equal(b.getRuntimeSelection(ch)?.modelId ?? null, "claude-opus-4-8", "the base model survived");
  assert.equal(b.setting("browseMaxSteps", ch), 120, "the browse step limit survived");
  assert.equal(b.setting("browseModel", ch), "claude-sonnet-4-6", "the browse model survived");
});

test("pg config store: rapid overlapping writes to one scope converge to the last value (serialized write-through)", async () => {
  const { open } = tables();
  const ch = scopeId("channel", "C2");
  const a = open();

  let lastVersion = 0;
  for (let i = 1; i <= 8; i++) {
    lastVersion = await a.setInstructions(ch, `soul v${i}`);
    await a.setSetting("egress", { allowedHosts: [`host${i}.example`], deniedHosts: [] }, ch);
  }
  await a.setRuntimeSelection(ch, { modelId: "claude-opus-4-8" });
  await a.setRuntimeSelection(ch, null);
  await a.setSetting("browseMaxSteps", 60, ch);
  await a.setSetting("browseMaxSteps", null, ch);
  await a.setSetting("browseModel", "claude-sonnet-4-6", ch);
  await a.setSetting("browseModel", null, ch);

  const b = open();
  await b.hydrate?.();
  assert.equal(
    b.getInstructions(ch),
    "soul v8",
    "the durable soul ends on the last write, not a reordered earlier one",
  );
  assert.equal(b.instructionsVersion(ch), lastVersion);
  assert.deepEqual(
    b.setting("egress", ch),
    { allowedHosts: ["host8.example"], deniedHosts: [] },
    "the durable egress ends on the last write",
  );
  assert.equal(b.getRuntimeSelection(ch)?.modelId ?? null, null, "a cleared base model stays cleared after restart");
  assert.equal(b.setting("browseMaxSteps", ch), null, "a cleared browse step limit stays cleared after restart");
  assert.equal(b.setting("browseModel", ch), null, "a cleared browse model stays cleared after restart");
});

test("pg config store: settings written on one core reach another core through refreshScope", async () => {
  const { open } = tables();
  const ch = scopeId("channel", "C4");
  const org = scopeId("org", "default-org");
  const a = open();
  const b = open();
  await a.hydrate?.();
  await b.hydrate?.();

  await a.setSetting("webuiModels", ["claude-opus-4-8"], ch);
  await a.setSetting("ackEmoji", ["eyes"], ch);
  await a.setSetting("browseMaxSteps", 77, ch);
  await a.setSetting("browseModel", "claude-sonnet-4-6", ch);
  await a.setSetting("branding", { accent: "#123456" }, ch);
  await a.setSetting("channelHeaderPin", true, ch);
  await a.setApprovalGrantModes(ch, { session: false, always: true });
  await a.setSetting("orgAmbient", false);
  await a.setSetting("autoFlagger", { modelId: "claude-opus-4-8", rubric: "flag it" });
  await b.refreshScope(ch);
  await b.refreshScope(org);

  assert.deepEqual(b.setting("webuiModels", ch), ["claude-opus-4-8"]);
  assert.deepEqual(b.setting("ackEmoji", ch), ["eyes"]);
  assert.equal(b.setting("browseMaxSteps", ch), 77);
  assert.equal(b.setting("browseModel", ch), "claude-sonnet-4-6");
  assert.deepEqual(b.setting("branding", ch), { accent: "#123456" });
  assert.equal(b.setting("channelHeaderPin", ch), true);
  assert.deepEqual(b.getApprovalGrantModes(ch), { session: false, always: true });
  assert.equal(b.setting("orgAmbient"), false);
  assert.equal(b.setting("autoFlagger")?.rubric, "flag it");

  await a.setSetting("webuiModels", null, ch);
  await a.setSetting("ackEmoji", null, ch);
  await a.setSetting("browseMaxSteps", null, ch);
  await a.setSetting("browseModel", null, ch);
  await b.refreshScope(ch);
  await b.refreshScope(org);

  assert.equal(b.setting("webuiModels", ch), null);
  assert.equal(b.setting("ackEmoji", ch), null);
  assert.equal(b.setting("browseMaxSteps", ch), null);
  assert.equal(b.setting("browseModel", ch), null);
});

test("a durable database is pinned to one organization", async () => {
  const databaseUrl = testDatabaseUrl();
  await testConfigStore({ databaseUrl }).hydrate!();
  await assert.rejects(
    withTenant(tenantFor("other"), () => testConfigStore({ databaseUrl }).hydrate!()),
    /database belongs to org default-org/,
  );
});

test("purpose runtimes persist independently without manufacturing a conversation default", async () => {
  const databaseUrl = testDatabaseUrl();
  const store = testConfigStore({ databaseUrl });
  const org = "org:default-org";
  const cron = { modelId: "gpt-5.5", fastMode: false };
  const subagent = { modelId: "claude-opus-5", effortLevel: "low" };
  assert.equal(store.getPurposeRuntime("cron"), undefined);
  await store.setPurposeRuntime("cron", cron);
  await store.setPurposeRuntime("subagent", subagent);
  assert.equal(store.getRuntimeSelection(org)?.modelId ?? null, null);
  assert.equal(await store.getRuntimeSelectionDurable(org), null);
  const reader = testConfigStore({ databaseUrl });
  await reader.hydrate!();
  assert.deepEqual(reader.getPurposeRuntime("cron"), cron);
  assert.deepEqual(await reader.getPurposeRuntimeDurable("subagent"), subagent);
  reader.getPurposeRuntime("cron")!.modelId = "not-persisted";
  assert.deepEqual(reader.getPurposeRuntime("cron"), cron);
  await store.setRuntimeSelection(org, { modelId: "gpt-5.5" });
  await store.setRuntimeSelection(org, null);
  await store.setRuntimeSelection(org, null);
  await store.setRuntimeSelection(org, { modelId: "gpt-5.5" });
  assert.equal(store.getRuntimeSelection(org)?.modelId, "gpt-5.5");
  await store.setRuntimeSelection(org, { modelId: "gpt-5.5" });
  await store.setRuntimeSelection(org, null);
  assert.deepEqual(await reader.getPurposeRuntimeDurable("cron"), cron);
  assert.deepEqual(await reader.getPurposeRuntimeDurable("subagent"), subagent);
  await store.clearPurposeRuntime("cron");
  assert.equal(await reader.getPurposeRuntimeDurable("cron"), undefined);
  assert.deepEqual(await reader.getPurposeRuntimeDurable("subagent"), subagent);
  await store.clearPurposeRuntime("subagent");
  assert.deepEqual(await createPgPool(databaseUrl).q("SELECT scope_id FROM base_model_configs"), []);
});

test("interactive fast mode defaults off and persists across instances", async () => {
  const databaseUrl = testDatabaseUrl();
  const first = testConfigStore({ databaseUrl });
  await first.hydrate!();
  assert.equal(first.setting("interactiveFastMode"), false);
  assert.equal(await first.settingDurable("interactiveFastMode"), false);

  await first.setSetting("interactiveFastMode", true);
  assert.equal(first.setting("interactiveFastMode"), true);

  const second = testConfigStore({ databaseUrl });
  await second.hydrate!();
  assert.equal(second.setting("interactiveFastMode"), true);
  assert.equal(await second.settingDurable("interactiveFastMode"), true);
});

test("the org default reaches only human turns that expressed no preference", () => {
  assert.equal(resolveTurnFastMode(undefined, true, true), true);
  assert.equal(resolveTurnFastMode(undefined, true, false), undefined);
  assert.equal(resolveTurnFastMode(undefined, false, true), undefined);
  assert.equal(resolveTurnFastMode(false, true, true), false);
  assert.equal(resolveTurnFastMode(true, false, false), true);
});

test("refreshScope picks up an interactive fast mode change written elsewhere", async () => {
  const databaseUrl = testDatabaseUrl();
  const store = testConfigStore({ databaseUrl });
  await store.hydrate!();
  const org = scopeId("org", "default-org");
  await createPgPool(databaseUrl).q(`INSERT INTO interactive_fast_mode_flag (scope_id, "on") VALUES ($1, true)`, [org]);
  await store.refreshScope(org);
  assert.equal(store.setting("interactiveFastMode"), true);
});

const buildApp = (...args: Parameters<typeof buildProductionApp>) => stopAtEnd(buildProductionApp(...args));

const SECRET = "personal-account-test-signing-secret";

test("personal account choice persists across instances without changing anyone else's choice", async () => {
  const databaseUrl = testDatabaseUrl();
  const first = testConfigStore({ databaseUrl });
  const second = testConfigStore({ databaseUrl });
  assert.equal(await first.getIndividualModelAuthDurable("alice"), false);
  await first.setPersonalModelAuth("alice", true);
  assert.equal(await second.getIndividualModelAuthDurable("alice"), true);
  assert.equal(await second.getIndividualModelAuthDurable("bob"), false);
  assert.equal(await second.getIndividualModelAuthDurable(), false);
  await second.setPersonalModelAuth("alice", false);
  assert.equal(await first.getIndividualModelAuthDurable("alice"), false);
  await first.setSetting("individualModelAuth", true);
  assert.equal(await second.getIndividualModelAuthDurable("alice"), true);
});

test("account API binds choice to the signed-in person, preserves connections, and fails closed after disconnect", async () => {
  const built = stopAtEnd(buildApp(testConfig()));
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    requireSignedPortalIdentity: true,
    capabilitySecret: SECRET + "capability",
    portalIdentitySecret: SECRET + "portal",
    config: built.config,
    userModelCredentials: built.userModelCredentials,
    auditLog: built.auditLog,
  });
  const base = listenLocal(server);
  async function request(account: unknown, principalId = "alice@default-org", signedIn = "alice@default-org") {
    const path = "/v1/user-model-auth/account";
    const body = JSON.stringify({ account, principalId, nonce: crypto.randomUUID() });
    const ts = Math.floor(Date.now() / 1000);
    return fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `POST\n${path}\n${body}`),
        "x-portal-identity": await mintPortalIdentity({ p: signedIn, exp: Date.now() + 60_000 }, SECRET + "portal"),
      },
      body,
    });
  }
  try {
    assert.equal((await request("personal")).status, 409);
    assert.equal((await request("invalid")).status, 400);
    await built.userModelCredentials.setApiKey("alice@default-org", "anthropic", "test-personal-key");
    assert.equal((await request("personal", "bob@default-org", "alice@default-org")).status, 403);
    const enabled = await request("personal");
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), {
      individualModelAuth: true,
      required: false,
      account: "personal",
      connections: [{ provider: "anthropic", kind: "apikey" }],
    });
    assert.equal(await built.config.getIndividualModelAuthDurable("bob@default-org"), false);
    assert.equal((await request("company")).status, 200);
    assert.equal((await built.userModelCredentials.connections("alice@default-org")).length, 1);
    assert.equal((await request("personal")).status, 200);
    await built.userModelCredentials.delete("alice@default-org", "anthropic");
    assert.equal(await built.config.getIndividualModelAuthDurable("alice@default-org"), true);
    assert.equal((await request("company")).status, 200);
    await built.config.setSetting("individualModelAuth", true);
    assert.equal((await request("company")).status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("personal provider choice is durable and controls the submitted run independently of the company model", async () => {
  const built = stopAtEnd(buildApp(testConfig()));
  await built.userModelCredentials.setApiKey("U1", "anthropic", "test-anthropic-key");
  await built.userModelCredentials.setApiKey("U1", "openai", "test-openai-key");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "personal-provider-choice" },
    text: "hello",
    async: true,
    model: "company-only-custom-model",
    origin: { kind: "human" as const },
  });
  const run = await built.runs.get(submitted.runId!);
  assert.equal(run?.request.modelAccount, "openai");
  assert.equal(run?.request.model, undefined);
  await built.config.setPersonalModelAuth("U1", false);
  assert.equal((await built.runs.get(submitted.runId!))?.request.modelAccount, "openai");
  const steered = await built.app.signalRun(submitted.runId!, { kind: "steer", text: "more work" }, "U1");
  assert.equal(steered.accepted, false);
  assert.match(steered.reason ?? "", /account_changed/);
  assert.equal((await built.app.signalRun(submitted.runId!, { kind: "abort" }, "U1")).accepted, true);
});

test("shared chat messages queue instead of borrowing another person's account", async () => {
  const built = stopAtEnd(buildApp(testConfig()));
  const message = (user: string) => ({
    surface: "slack",
    actor: { externalId: user },
    conversation: { kind: "channel" as const, threadRef: "account-steering", channelRef: "C1" },
    text: "hello",
    origin: { kind: "human" as const },
    async: true,
  });
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  const first = await built.app.turn(message("U1"));
  const other = await built.app.turn(message("U2"));
  assert.notEqual(first.runId, other.runId);
  assert.notEqual(other.steered, true);
  assert.equal((await built.runs.get(other.runId!))?.request.modelAccount, "company");
  assert.equal((await built.signals.takePending(first.runId!)).length, 0);
});

test("every instructions write path refuses content over the limit with payload_too_large", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "instructions-size-")) }));
  const scope = "personal:U1" as const;
  const tooLong = "x".repeat(MAX_INSTRUCTIONS_CHARS + 1);

  await assert.rejects(built.config.setInstructions(scope, tooLong, "U1"), InstructionsTooLargeError);
  await assert.rejects(built.config.setInstructionsIfVersion(scope, 0, tooLong, "U1"), InstructionsTooLargeError);
  await assert.rejects(built.app.updateInstructions(scope, tooLong, "U1"), InstructionsTooLargeError);

  const out: { status?: number; body?: { error?: string; message?: string } } = {};
  const res = {
    getHeader() {},
    writeHead(status: number) {
      out.status = status;
    },
    end(data?: string) {
      out.body = data ? JSON.parse(data) : undefined;
    },
  };
  await respond(postInstructions, {
    res,
    app: built.app,
    body: { content: tooLong },
    capability: { actorId: "U1", scopeId: scope },
  } as unknown as ApiCtx);
  assert.equal(out.status, 413);
  assert.equal(out.body?.error, "payload_too_large");
  assert.equal(out.body?.message, "instructions must be at most 100000 characters");

  assert.equal(
    await built.app.updateInstructions(scope, "x".repeat(MAX_INSTRUCTIONS_CHARS), "U1"),
    1,
    "the limit itself is allowed",
  );
});

const org = scopeId("org", "default-org");
const cron = { modelId: "cron-model" };
const pick = { modelId: "org-model" };

function servers() {
  const databaseUrl = testDatabaseUrl();
  return {
    rows: typedTable<PersistedBaseModel>(createPgPool(databaseUrl), CONFIG_TABLES.baseModels),
    left: testConfigStore({ databaseUrl }),
    right: testConfigStore({ databaseUrl }),
  };
}

test("an org runtime change and a cron runtime saved at once on two servers both persist", async () => {
  const { rows, left, right } = servers();
  await Promise.all([left.setRuntimeSelection(org, pick), right.setPurposeRuntime("cron", cron)]);
  const row = await rows.get(org);
  assert.equal(row?.modelId, "org-model");
  assert.deepEqual(row?.cronRuntime, cron);
});

test("concurrent org runtime changes on two servers get distinct revisions", async () => {
  const { rows, left, right } = servers();
  await rows.put(org, { scopeId: org, modelId: "seed", revision: 1, orgRevision: 1 });
  await Promise.all([left.setRuntimeSelection(org, pick), right.setRuntimeSelection(org, { modelId: "other" })]);
  assert.equal((await rows.get(org))?.revision, 3);
});

test("acknowledging the org runtime on one server keeps a scope runtime another server just chose", async () => {
  const { rows, left, right } = servers();
  const channel = scopeId("channel", "c1");
  await rows.put(channel, { scopeId: channel, modelId: "old", orgRevision: 0 });
  await rows.put(org, { scopeId: org, modelId: "org-model", revision: 4, orgRevision: 4 });
  await Promise.all([
    left.acknowledgeRuntimeSelection(channel),
    right.setRuntimeSelection(channel, { modelId: "new" }),
  ]);
  const row = await rows.get(channel);
  assert.equal(row?.modelId, "new");
  assert.equal(row?.orgRevision, 4);
});

test("clearing the org runtime keeps purpose runtimes and removes an empty row", async () => {
  const { rows, left: store } = servers();
  await store.setRuntimeSelection(org, pick);
  await store.setPurposeRuntime("cron", cron);
  await store.setRuntimeSelection(org, null);
  assert.deepEqual(await rows.get(org), { scopeId: org, cronRuntime: cron });
  await store.clearPurposeRuntime("cron");
  assert.equal(await rows.get(org), null);
  assert.equal(store.getRuntimeSelection(org), null);
});

const channel = scopeId("channel", "C1");

test("a config write resolves only after another instance can read it from the store", async () => {
  const databaseUrl = testDatabaseUrl();
  const writer = testConfigStore({ databaseUrl });
  const reader = testConfigStore({ databaseUrl });

  await writer.setSetting("orgAmbient", false);

  assert.equal(await reader.settingDurable("orgAmbient"), false);
});

test("a failed config write rejects and leaves this instance's cache on the stored value", async () => {
  const databaseUrl = testDatabaseUrl();
  const config = testConfigStore({ databaseUrl });
  await config.hydrate!();
  await failTableWrites(databaseUrl, "egress_policies");

  await assert.rejects(
    config.setSetting("egress", { allowedHosts: ["api.example.com"], deniedHosts: [] }, channel),
    /forced durable write failure/,
  );

  assert.equal(config.setting("egress", channel), null);
  assert.deepEqual(await createPgPool(databaseUrl).q("SELECT scope_id FROM egress_policies"), []);
});

const acmeOrg = scopeId("org", "default-org");
const pinChannel = "channel:C123" as ScopeId;
const otherChannel = "channel:C456" as ScopeId;

async function freshStore() {
  const store = testConfigStore({});
  await store.hydrate!();
  return store;
}

test("channel header pin defaults off with no org setting", async () => {
  const store = await freshStore();
  assert.equal(store.setting("channelHeaderPin", pinChannel), false);
  assert.equal(await store.settingDurable("channelHeaderPin", pinChannel), false);
  assert.equal(await store.settingDurable("channelHeaderPin"), false);
});

test("an org default of on applies to channels without an explicit choice", async () => {
  const store = await freshStore();
  await store.setSetting("channelHeaderPin", true, acmeOrg);
  assert.equal(store.setting("channelHeaderPin", pinChannel), true);
  assert.equal(await store.settingDurable("channelHeaderPin", pinChannel), true);
  assert.equal(await store.settingDurable("channelHeaderPin"), true);
  assert.equal(await store.settingOwnDurable("channelHeaderPin", pinChannel), null);
});

test("an explicit channel off beats an org default of on", async () => {
  const store = await freshStore();
  await store.setSetting("channelHeaderPin", true, acmeOrg);
  await store.setSetting("channelHeaderPin", false, pinChannel);
  assert.equal(store.setting("channelHeaderPin", pinChannel), false);
  assert.equal(await store.settingDurable("channelHeaderPin", pinChannel), false);
  assert.equal(await store.settingOwnDurable("channelHeaderPin", pinChannel), false);
  // other channels still follow the default
  assert.equal(await store.settingDurable("channelHeaderPin", otherChannel), true);
});

test("clearing a channel override reverts it to the org default", async () => {
  const store = await freshStore();
  await store.setSetting("channelHeaderPin", true, acmeOrg);
  await store.setSetting("channelHeaderPin", false, pinChannel);
  await store.setSetting("channelHeaderPin", null, pinChannel);
  assert.equal(await store.settingDurable("channelHeaderPin", pinChannel), true);
  assert.equal(await store.settingOwnDurable("channelHeaderPin", pinChannel), null);
});

test("changing the org default notifies listeners with the org scope", async () => {
  const store = await freshStore();
  const seen: ScopeId[] = [];
  store.onChannelHeaderPinChanged((id) => seen.push(id));
  await store.setSetting("channelHeaderPin", true, acmeOrg);
  await store.setSetting("channelHeaderPin", true, pinChannel);
  assert.deepEqual(seen, [acmeOrg, pinChannel]);
});

test("explicit overrides survive a scope refresh", async () => {
  const store = await freshStore();
  await store.setSetting("channelHeaderPin", true, acmeOrg);
  await store.setSetting("channelHeaderPin", false, pinChannel);
  await store.refreshScope(pinChannel);
  assert.equal(store.setting("channelHeaderPin", pinChannel), false);
  await store.setSetting("channelHeaderPin", null, pinChannel);
  await store.refreshScope(pinChannel);
  assert.equal(store.setting("channelHeaderPin", pinChannel), true);
});
