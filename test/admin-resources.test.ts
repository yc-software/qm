import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { ADMIN_RESOURCES } from "../src/api/routes/admin-resources.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const NOBODY = { ...ADMIN, "x-admin-actor": "nobody@default-org" };
const ORG = "org:default-org";

function credentialLayer(): string {
  const dir = mkdtempSync(join(tmpdir(), "admin-res-layer-"));
  mkdirSync(join(dir, "tools/acmecli"), { recursive: true });
  writeFileSync(
    join(dir, "tools/acmecli/tool.json"),
    JSON.stringify({
      id: "acmecli",
      auth: {
        check: "acmecli me",
        reauth: "acmecli login --use-device-code",
        credentialPaths: [{ path: ".acmecli", kind: "directory" }],
      },
    }),
  );
  return dir;
}

function start(harnessId = "pi", withLayer = true) {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "admin-res-")),
      ...(withLayer ? { deploymentLayerDir: credentialLayer() } : {}),
    }),
  );
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    sessions: built.sessions,
    acl: built.acl,
    serviceCreds: built.serviceCreds,
    deviceFlowCutover: built.deviceFlowCutover,
    featureFlags: built.featureFlags,
    credentialServices: () => built.credentialTools.map((tool) => tool.service),
    channelPolicy: built.channelPolicy,
    harnessId,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const put = (scope: string, resource: string, body: unknown, headers: Record<string, string> = ADMIN) =>
    fetch(`${base}/v1/admin/scopes/${scope}/${resource}`, {
      method: "PUT",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const status = async (...args: Parameters<typeof put>) => (await put(...args)).status;
  const message = async (...args: Parameters<typeof put>) => {
    const response = await put(...args);
    assert.equal(response.status, 400);
    return ((await response.json()) as { message: string }).message;
  };
  const read = async (scope: string, query = ""): Promise<any> => {
    const response = await fetch(`${base}/v1/admin/scopes/${scope}${query}`, { headers: ADMIN });
    assert.equal(response.status, 200);
    return response.json();
  };
  const surface = async (): Promise<any> => (await fetch(`${base}/v1/surface-config`)).json();
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { base, built, put, status, message, read, surface, close };
}

function serverTest(
  name: string,
  fn: (srv: ReturnType<typeof start>) => Promise<void>,
  harnessId?: string,
  withLayer?: boolean,
) {
  test(name, async () => {
    const srv = start(harnessId, withLayer);
    try {
      await fn(srv);
    } finally {
      await srv.close();
    }
  });
}

serverTest("security flags are visible and legacy session taint can be released by an org admin", async (srv) => {
  srv.built.auditLog.record({
    at: 123,
    principalId: "U1",
    action: "security_posture.flagged",
    resource: "slack",
    scopeLabel: "channel:C1",
    status: "pending_approval",
    detail: JSON.stringify({ cause: "strict-verdict", source: ["overheard"] }),
  });
  const flags = await fetch(`${srv.base}/v1/admin/security/flags?limit=1`, { headers: ADMIN });
  assert.equal(flags.status, 200);
  assert.deepEqual((await flags.json()) as unknown, {
    flags: [
      {
        at: 123,
        principal: "U1",
        scope: "channel:C1",
        surface: "slack",
        detail: '{"cause":"strict-verdict","source":["overheard"]}',
      },
    ],
  });

  const session = await srv.built.sessions.getOrCreateByThread("legacy-taint", "dm", "personal:U1");
  const lease = (await srv.built.sessions.acquireLease(session.id)).lease!;
  await srv.built.sessions.append(lease, {
    type: "user",
    payload: { text: "legacy", securityTainted: true },
    scopeLabel: "personal:U1",
  });
  await srv.built.sessions.releaseLease(lease);
  const release = (headers: Record<string, string>) =>
    fetch(`${srv.base}/v1/admin/security/release`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: session.id }),
    });
  assert.equal((await release(NOBODY)).status, 403);
  assert.equal((await release(ADMIN)).status, 200);
  const payload = (await srv.built.sessions.getEntries(session.id))[0]!.payload as Record<string, unknown>;
  assert.equal(payload.securityTainted, undefined);
});

serverTest("GET /v1/admin/resources returns a manifest entry for every registered resource", async (srv) => {
  const r = await fetch(`${srv.base}/v1/admin/resources`, { headers: ADMIN });
  assert.equal(r.status, 200);
  const body = (await r.json()) as {
    resources: { id: string; kind: string; target?: string; secret?: boolean; enumValues?: unknown[] }[];
  };
  const ids = body.resources.map((x) => x.id).sort();
  assert.deepEqual(ids, ADMIN_RESOURCES.map((x) => x.id).sort());

  const byId = new Map(body.resources.map((x) => [x.id, x]));
  assert.equal(byId.get("base-model")?.kind, "enum");
  assert.equal(byId.get("base-model")?.target, "any");
  assert.ok((byId.get("base-model")?.enumValues?.length ?? 0) > 0);
  assert.deepEqual(byId.get("security-posture")?.enumValues, ["dangerous", "auto", "strict"]);
  assert.deepEqual(byId.get("sharing-posture")?.enumValues, ["isolated", "open"]);
  assert.equal(byId.get("service-credentials")?.target, "org");
  assert.equal(byId.get("service-credentials")?.secret, true);
  assert.equal(byId.has("import"), false);
  assert.equal(await srv.status(ORG, "not-a-resource", "{}"), 404);
});

serverTest("turn wall-clock governance validates, round-trips, clears, and is org-admin-only", async (srv) => {
  const put = (sec: unknown, scope = ORG, headers = ADMIN) => srv.status(scope, "turn-wall-clock", { sec }, headers);
  const current = async () => (await srv.read(ORG)).turnWallClockSec;
  assert.equal(await put(60, ORG, NOBODY), 403);
  assert.equal(await put(60, "channel:C1"), 400);
  for (const sec of [59, 86_401, 60.5, "nope"]) assert.equal(await put(sec), 400);
  assert.equal(await put("120"), 200);
  assert.equal(await current(), 120);
  assert.equal(await put(0), 200);
  assert.equal(await current(), 0);
  assert.equal(await put(""), 200);
  assert.equal(await current(), null);
  assert.equal(await put(120), 200);
  assert.equal(await put("  "), 200);
  assert.equal(await current(), null);
});

serverTest(
  "branding governance validates, round-trips through surface-config, clears, and is org-admin-only",
  async (srv) => {
    const put = (body: unknown, scope = ORG, headers = ADMIN) => srv.status(scope, "branding", body, headers);
    assert.equal(await put({ accent: "#6366f1" }, ORG, NOBODY), 403);
    assert.equal(await put({ accent: "#6366f1" }, "channel:C1"), 400);
    assert.equal(await put({ accent: "#abcde" }), 400);
    assert.equal(await put({ accent: "#aabbccddee" }), 400);
    assert.equal(await put({ accent: "#6366f1", mark: "Q", selfLabel: "{{qm}}", orgName: "Acme Corp" }), 200);
    const readBack = await srv.read(ORG);
    assert.equal(readBack.branding?.accent, "#6366f1");
    assert.equal(readBack.branding?.orgName, "Acme Corp");
    assert.deepEqual((await srv.surface()).branding, {
      orgName: "Acme Corp",
      accent: "#6366f1",
      mark: "Q",
      selfLabel: "qm",
    });
    assert.equal(await put({ mark: "<b>xy" }), 200);
    assert.equal((await srv.surface()).branding?.mark, "bx");
    assert.equal(await put({ accent: "", mark: "", selfLabel: "" }), 200);
    assert.equal((await srv.surface()).branding, undefined);
  },
);

serverTest(
  "surface-config filters persisted model choices to the active native harness",
  async (srv) => {
    srv.built.config.setBaseModel(ORG, "claude-opus-4-8");
    srv.built.config.setWebuiModels(ORG, ["claude-opus-4-8", "gpt-5.6-sol"]);
    const config = await srv.surface();
    assert.equal(config.harnessId, "codex");
    assert.equal(config.baseModel, "gpt-5.6-sol");
    assert.deepEqual(config.webuiModels, ["gpt-5.6-sol"]);
  },
  "codex",
);

serverTest("runtime-config lets a person set, keep, and inherit an approved personal runtime", async (srv) => {
  srv.built.config.setApprovedHarnesses(["pi", "codex", "claude"]);
  srv.built.config.setWebuiModels(ORG, ["claude-sonnet-4-6", "claude-opus-4-8", "gpt-5.5"]);
  srv.built.config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
  await srv.built.config.flushScope(ORG);
  const url = `${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal:alice`;
  const get = async (): Promise<any> => (await fetch(url)).json();
  const put = async (body: Record<string, unknown>): Promise<any> => {
    const response = await fetch(`${srv.base}/v1/runtime-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "alice", scopeId: "personal:alice", ...body }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const initial = await get();
  assert.equal(initial.effective.harnessId, "pi");
  assert.equal(initial.scopeOverride, null);
  assert.deepEqual(initial.modelsByHarness.claude, ["claude-sonnet-4-6", "claude-opus-4-8"]);
  assert.deepEqual(initial.modelsByHarness.codex, ["gpt-5.5"]);

  const selected = await put({ harnessId: "codex", modelId: "gpt-5.5", effortLevel: "low", fastMode: true });
  assert.deepEqual(selected.effective, { harnessId: "codex", modelId: "gpt-5.5", effortLevel: "low", fastMode: false });

  srv.built.config.setRuntimeSelection(ORG, { harnessId: "claude", modelId: "claude-opus-4-8" });
  await srv.built.config.flushScope(ORG);
  assert.equal((await get()).upgradeAvailable, true);
  assert.equal((await put({ keep: true })).upgradeAvailable, false);

  const inherited = await put({ inherit: true });
  assert.equal(inherited.effective.harnessId, "claude");
  assert.equal(inherited.scopeOverride, null);

  srv.built.config.setBaseModel("personal:alice", "claude-sonnet-4-6");
  await srv.built.config.flushScope("personal:alice");
  assert.equal((await get()).upgradeAvailable, true);
  const keptLegacy = await put({ keep: true });
  assert.equal(keptLegacy.upgradeAvailable, false);
  assert.deepEqual(keptLegacy.scopeOverride, { harnessId: "pi", modelId: "claude-sonnet-4-6", orgRevision: 2 });
});

serverTest("a generic resource round-trips through the registry dispatch + read loop", async (srv) => {
  assert.equal(await srv.status(ORG, "soul", { content: "be excellent", expectedVersion: 1 }), 200);
  const body = await srv.read(ORG);
  assert.equal(body.soul, "be excellent");
  assert.equal(body.soulVersion, 2);
  assert.equal(body.soulHistory[0]?.content, "be excellent");
  assert.equal(body.soulHistory[0]?.updatedBy, "admin-alice");
  assert.ok(body.soulHistory[0]?.updatedAt);

  const stale = await srv.put(ORG, "soul", { content: "overwrite", expectedVersion: 1 });
  assert.equal(stale.status, 409);
  assert.match(await stale.text(), /changed after this draft was loaded/);
});

serverTest("feature flag table changes one scope live without restart", async (srv) => {
  assert.equal(await srv.built.featureFlags.enabled("inbox_loops", "channel:C1"), false);
  assert.equal(
    await srv.status(ORG, "feature-flags", { featureName: "inbox_loops", scopeId: "channel:C1", on: true }),
    200,
  );
  assert.equal(await srv.built.featureFlags.enabled("inbox_loops", "channel:C1"), true);
  assert.equal(await srv.built.featureFlags.enabled("inbox_loops", "channel:C2"), false);
  assert.deepEqual((await srv.read(ORG)).featureFlags[0]?.enabledScopes, ["channel:C1"]);
});

serverTest("device-flow cutover is scope-specific, audited, and reverses without deleting records", async (srv) => {
  const scope = "channel:C1";
  const put = (service: string, mode: string) =>
    srv.put(encodeURIComponent(scope), "device-flow-cutover", { service, mode });
  assert.equal((await put("acmecli", "prefer_ephemeral")).status, 200);
  assert.equal(await srv.built.deviceFlowCutover.resolve(scope, "acmecli"), "prefer_ephemeral");

  const body = await srv.read(encodeURIComponent(scope));
  assert.equal(body.deviceFlowCutover.acmecli.effective, "prefer_ephemeral");
  assert.equal(body.deviceFlowCutover.acmecli.configured.updatedBy, "admin-alice");

  const unsupported = await put("aws", "ephemeral_only");
  assert.equal(unsupported.status, 400);
  assert.match(await unsupported.text(), /no credential paths/);

  assert.equal((await put("acmecli", "legacy")).status, 200);
  assert.equal(await srv.built.deviceFlowCutover.resolve(scope, "acmecli"), "legacy");

  await srv.built.deviceFlowCutover.set(ORG, "acmecli", "prefer_ephemeral", "admin-alice");
  assert.equal((await put("acmecli", "inherit")).status, 200);
  assert.equal(await srv.built.deviceFlowCutover.get(scope, "acmecli"), null);
  assert.equal(await srv.built.deviceFlowCutover.resolve(scope, "acmecli"), "prefer_ephemeral");
  const events = await srv.built.auditLog.events();
  assert.ok(events.some((event) => event.action === "device-flow-cutover.update"));
  assert.ok(
    events.some(
      (event) =>
        event.action === "credential.cutover.update" &&
        event.resource === "acmecli:legacy/legacy->inherit/prefer_ephemeral",
    ),
  );
});

serverTest(
  "historical cutover policies remain visible and clearable without layer tools",
  async (srv) => {
    const scope = "channel:C1";
    await srv.built.deviceFlowCutover.set(ORG, "retired", "ephemeral_only", "admin");
    assert.equal((await srv.read(encodeURIComponent(scope))).deviceFlowCutover.retired.effective, "ephemeral_only");
    for (const mode of ["legacy", "inherit"])
      assert.equal(
        await srv.status(encodeURIComponent(scope), "device-flow-cutover", { service: "retired", mode }),
        200,
      );
    assert.equal(await srv.built.deviceFlowCutover.resolve(scope, "retired"), "ephemeral_only");
  },
  "pi",
  false,
);

serverTest("security posture round-trips through durable scoped governance", async (srv) => {
  assert.equal((await srv.read(ORG)).securityPosture, "auto");
  assert.equal(await srv.status(ORG, "security-posture", { posture: "strict" }), 200);
  assert.equal((await srv.read(ORG)).securityPosture, "strict");
  assert.equal(await srv.status(ORG, "security-posture", { posture: "YOLO" }), 400);
});

serverTest("sharing posture round-trips through scoped governance with organization and room vetoes", async (srv) => {
  const personal = "personal:U1";
  const room = "channel:C1";
  const read = async (scope: string) => (await srv.read(scope)).sharingPosture;
  const put = (scope: string, posture: string) => srv.status(scope, "sharing-posture", { posture });

  assert.equal(await read(ORG), "isolated");
  assert.equal(await put(ORG, "open"), 200);
  assert.equal(await read(room), "open");
  assert.equal(await put(personal, "isolated"), 200);
  assert.equal(await read(personal), "isolated");
  assert.equal(await put(room, "isolated"), 200);
  assert.equal(await read(room), "isolated");
  assert.equal(await put(ORG, "isolated"), 200);
  assert.equal(await put(room, "open"), 200);
  assert.equal(await read(room), "isolated");
  assert.equal(await put(ORG, "invalid"), 400);
  assert.equal(await srv.status(room, "sharing-posture", { inherit: true }), 200);
  assert.equal(await srv.built.config.getSharingPostureOwnDurable(room), null);
  assert.equal(await put(ORG, "open"), 200);
  assert.equal(await read(room), "open");
});

serverTest("approval grant modes round-trip, validate, and compose tighten-only across scopes", async (srv) => {
  assert.deepEqual((await srv.read(ORG)).approvalGrantModes, { session: true, always: true });
  assert.equal(await srv.status(ORG, "approval-grant-modes", { session: true, always: false }), 200);
  assert.deepEqual((await srv.read(ORG)).approvalGrantModes, { session: true, always: false });
  assert.equal(await srv.status("channel:C1", "approval-grant-modes", { session: false, always: true }), 200);
  assert.deepEqual((await srv.read("channel:C1")).approvalGrantModes, { session: false, always: false });
  assert.equal(await srv.status(ORG, "approval-grant-modes", { session: "yes" }), 400);
});

serverTest(
  "base-model is a sparse per-scope override: a channel pins its own model, empty clears back to inherit",
  async (srv) => {
    const room = "channel:C1";
    assert.equal((await srv.read(room)).baseModel, null);
    assert.match(await srv.message(room, "base-model", { modelId: "not-a-model" }), /unknown model id/);
    assert.equal(await srv.status(room, "base-model", { modelId: "claude-opus-4-8" }), 200);
    assert.equal((await srv.read(room)).baseModel, "claude-opus-4-8");
    assert.equal(await srv.status(room, "base-model", { modelId: "" }), 200);
    assert.equal((await srv.read(room)).baseModel, null);
  },
);

serverTest("admin runtime saves reasoning level and fast mode with the default model", async (srv) => {
  const put = (body: unknown) => srv.status(ORG, "runtime", body);
  const saved = () => srv.built.config.getRuntimeSelectionDurable(ORG);
  srv.built.config.setApprovedHarnesses(["pi", "opencode", "codex"]);
  await srv.built.config.flushScope(ORG);
  assert.equal(await put({ harnessId: "pi", modelId: "claude-opus-5", effortLevel: "high", fastMode: true }), 200);
  assert.deepEqual(await saved(), {
    harnessId: "pi",
    modelId: "claude-opus-5",
    effortLevel: "high",
    fastMode: true,
    orgRevision: 1,
    revision: 1,
  });

  assert.equal(await srv.status(ORG, "base-model", { modelId: "claude-fable-5" }), 200);
  assert.deepEqual(await saved(), {
    harnessId: "pi",
    modelId: "claude-fable-5",
    effortLevel: "high",
    fastMode: false,
    orgRevision: 2,
    revision: 2,
  });

  assert.equal(await put({ harnessId: "pi", modelId: "claude-fable-5", effortLevel: "low", fastMode: true }), 200);
  assert.equal((await saved())?.fastMode, false);
  assert.equal(
    await put({ harnessId: "opencode", modelId: "claude-opus-5", effortLevel: "auto", fastMode: true }),
    200,
  );
  assert.equal((await saved())?.fastMode, true);

  for (const body of [
    { harnessId: "pi", modelId: "claude-opus-5", effortLevel: "extreme", fastMode: true },
    { harnessId: "codex", modelId: "gpt-5.5", effortLevel: "max", fastMode: false },
    { harnessId: "pi", modelId: "claude-opus-5", effortLevel: "high", fastMode: "yes" },
  ])
    assert.equal(await put(body), 400);
});

serverTest("ambient-policy edits a channel's standing order and bot ledger through the registry", async (srv) => {
  const room = "channel:C1";
  const put = (body: unknown, scope = room) => srv.put(scope, "ambient-policy", body);
  assert.equal("ambientPolicy" in (await srv.read(ORG)), false);
  assert.deepEqual((await srv.read(room)).ambientPolicy, { orders: "", bots: {}, ambientEnabled: null, updatedAt: 0 });

  assert.equal((await put({ orders: "x", bots: {} }, ORG)).status, 400);
  assert.match(
    await srv.message(room, "ambient-policy", { orders: "", bots: { GitHub: { mode: "mute" } } }),
    /mode must be one of/,
  );
  assert.equal((await put({ orders: "", bots: { GitHub: { mode: "rollup", rollupHours: -2 } } })).status, 400);
  assert.match(
    await srv.message(room, "ambient-policy", {
      orders: "",
      bots: { GitHub: { mode: "action" }, github: { mode: "ignore" } },
    }),
    /duplicate bot/i,
  );

  const saved = await put(
    '{"orders":"flag anything about the Q3 launch","bots":{"GitHub":{"mode":"rollup","rollupHours":24},"Linear":{"mode":"ignore"},"__proto__":{"mode":"ignore"}}}',
  );
  assert.equal(saved.status, 200);
  const got = (await srv.read(room)).ambientPolicy;
  const stored = await srv.built.channelPolicy.get("C1");
  assert.equal(got.orders, "flag anything about the Q3 launch");
  assert.deepEqual(Object.keys(got.bots).sort(), ["GitHub", "Linear", "__proto__"]);
  assert.equal(got.updatedAt, stored?.updatedAt);
  assert.equal(stored?.setBy, "admin-alice");
  const revs = await srv.built.channelPolicy.history("C1");
  assert.deepEqual(Object.keys(revs[0]?.bots ?? {}).sort(), ["GitHub", "Linear", "__proto__"]);

  assert.equal((await put({ orders: "overwrite", bots: {}, baseUpdatedAt: 1 })).status, 409);
  assert.equal((await srv.built.channelPolicy.get("C1"))?.orders, "flag anything about the Q3 launch");
  assert.equal((await put({ orders: "updated", bots: {}, baseUpdatedAt: stored?.updatedAt })).status, 200);
  assert.equal((await srv.built.channelPolicy.get("C1"))?.orders, "updated");
});

serverTest("webui-models is an org-wide string-list read back via admin GET and surface-config", async (srv) => {
  assert.match(await srv.message("personal:U1", "webui-models", { ids: ["claude-opus-4-8"] }), /org-wide/);
  assert.match(await srv.message(ORG, "webui-models", { ids: ["not-a-model"] }), /unknown model id/);
  assert.equal(
    await srv.status(ORG, "webui-models", { ids: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-sonnet-4-6"] }),
    200,
  );
  assert.deepEqual((await srv.read(ORG)).webuiModels, ["claude-sonnet-4-6", "claude-opus-4-8"]);
  assert.deepEqual((await srv.surface()).webuiModels, ["claude-sonnet-4-6", "claude-opus-4-8"]);

  assert.equal((await srv.surface()).baseModel, "claude-opus-5");
  assert.equal(await srv.status(ORG, "base-model", { modelId: "claude-sonnet-4-6" }), 200);
  assert.equal((await srv.surface()).baseModel, "claude-sonnet-4-6");

  assert.equal(await srv.status(ORG, "webui-models", { ids: [] }), 200);
  assert.equal((await srv.read(ORG)).webuiModels, null);
});

serverTest("internal-member-overrides is org-only, validates entries, audits, and round-trips", async (srv) => {
  const resource = "internal-member-overrides";
  assert.match(await srv.message("personal:U1", resource, { members: ["u1"] }), /org-wide/);
  assert.match(await srv.message(ORG, resource, { members: "u1" }), /requires/);
  assert.match(await srv.message(ORG, resource, { members: ["ok@example.com", "  "] }), /non-empty string/);

  assert.equal(
    await srv.status(ORG, resource, { members: [" Contractor@EXAMPLE.com ", "U123ABC", "contractor@example.com"] }),
    200,
  );
  assert.deepEqual(srv.built.config.getInternalMemberOverrides(), ["contractor@example.com", "u123abc"]);
  assert.deepEqual((await srv.read(ORG)).internalMemberOverrides, ["contractor@example.com", "u123abc"]);
  assert.ok((await srv.built.auditLog.events()).some((event) => event.action === "identity.internal-override.update"));

  assert.equal(await srv.status(ORG, resource, { members: [] }), 200);
  assert.deepEqual(srv.built.config.getInternalMemberOverrides(), []);
});

serverTest(
  "GET /v1/admin/slack-emoji surfaces 404 without a token, and serves the plugin-published catalog once one exists",
  async (srv) => {
    let r = await fetch(`${srv.base}/v1/admin/slack-emoji`, { headers: ADMIN });
    assert.equal(r.status, 404);
    assert.equal(((await r.json()) as { error?: string }).error, "not_configured");

    await srv.built.slackCore.publishEmojiCatalog({
      galaxy_brain: "https://emoji.slack-edge.com/T0/galaxy_brain/abc.png",
    });
    r = await fetch(`${srv.base}/v1/admin/slack-emoji`, { headers: ADMIN });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { emoji: Record<string, string>; standard: unknown[] };
    assert.equal(body.emoji.galaxy_brain, "https://emoji.slack-edge.com/T0/galaxy_brain/abc.png");
    assert.ok(body.standard.length > 1000);
  },
);

serverTest("org purpose runtimes round-trip, validate, and clear independently", async (srv) => {
  const get = () => srv.read(ORG, "?view=models");
  const put = (resource: string, body: unknown, scope = ORG, headers = ADMIN) =>
    srv.status(scope, resource, body, headers);
  assert.equal((await get()).cronRuntime, null);
  assert.equal((await get()).subagentRuntime, null);
  for (const purpose of ["cron", "subagent", "fallback"] as const) {
    const resource = `${purpose}-runtime`;
    const choice = { harnessId: "pi", modelId: "claude-opus-5", effortLevel: "low", fastMode: false };
    assert.equal(await put(resource, choice, ORG, NOBODY), 403);
    assert.equal(await put(resource, choice, "personal:alice"), 400);
    for (const bad of [
      { ...choice, harnessId: "invalid" },
      { ...choice, harnessId: "codex" },
      { ...choice, modelId: "invalid" },
      { ...choice, effortLevel: "invalid" },
      { ...choice, fastMode: "yes" },
      { ...choice, modelId: "claude-fable-5", fastMode: true },
      { modelId: choice.modelId },
    ])
      assert.equal(await put(resource, bad), 400);
    assert.equal(await put(resource, choice), 200);
    assert.deepEqual((await get())[`${purpose}Runtime`], choice);
    assert.equal(await put(resource, { harnessId: "pi", modelId: choice.modelId }), 200);
    assert.deepEqual((await get())[`${purpose}Runtime`], { harnessId: "pi", modelId: choice.modelId });
    assert.equal(await put(resource, { inherit: true }), 200);
    assert.equal((await get())[`${purpose}Runtime`], null);
    assert.equal(await put(resource, choice), 200);
    assert.equal(await put(resource, null), 200);
    assert.equal((await get())[`${purpose}Runtime`], null);
  }
  assert.equal((await get()).runtime, null);
});
