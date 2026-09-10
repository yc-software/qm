import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { ADMIN_RESOURCES } from "../src/api/routes/admin-resources.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

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

function start(
  harnessId = "pi",
  withLayer = true,
  overrides: (built: BuiltApp) => Partial<NonNullable<Parameters<typeof createInsecureTestServer>[1]>> = () => ({}),
): { base: string; built: BuiltApp; close: () => Promise<void> } {
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
    loops: built.loops,
    harnessId,
    ...overrides(built),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("security flags are visible and legacy session taint can be released by an org admin", async () => {
  const srv = start();
  try {
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
    const denied = await fetch(`${srv.base}/v1/admin/security/release`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
      body: JSON.stringify({ sessionId: session.id }),
    });
    assert.equal(denied.status, 403);
    const released = await fetch(`${srv.base}/v1/admin/security/release`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ sessionId: session.id }),
    });
    assert.equal(released.status, 200);
    const payload = (await srv.built.sessions.getEntries(session.id))[0]!.payload as Record<string, unknown>;
    assert.equal(payload.securityTainted, undefined);
  } finally {
    await srv.close();
  }
});

test("GET /v1/admin/resources returns a manifest entry for every registered resource", async () => {
  const srv = start();
  try {
    const r = await fetch(`${srv.base}/v1/admin/resources`, { headers: ADMIN });
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      resources: {
        id: string;
        kind: string;
        target?: string;
        secret?: boolean;
        clearable?: boolean;
        enumValues?: unknown[];
      }[];
    };
    const ids = body.resources.map((x) => x.id).sort();
    assert.deepEqual(ids, ADMIN_RESOURCES.map((x) => x.id).sort());

    const byId = new Map(body.resources.map((x) => [x.id, x]));
    assert.equal(byId.get("base-model")?.kind, "enum");
    assert.equal(byId.get("base-model")?.target, "any");
    assert.ok((byId.get("base-model")?.enumValues?.length ?? 0) > 0);
    assert.deepEqual(byId.get("security-posture")?.enumValues, ["dangerous", "auto", "strict"]);
    assert.equal(byId.get("service-credentials")?.target, "org");
    assert.equal(byId.get("service-credentials")?.secret, true);
    assert.equal(byId.get("factory-config")?.kind, "custom");
    assert.equal(byId.get("factory-config")?.target, "org");
    assert.equal(byId.get("factory-config")?.clearable, true);
    assert.equal(byId.has("import"), false);
  } finally {
    await srv.close();
  }
});

test("turn wall-clock governance validates, round-trips, clears, and is org-admin-only", async () => {
  const srv = start();
  const url = `${srv.base}/v1/admin/scopes/org:default-org/turn-wall-clock`;
  try {
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
          body: JSON.stringify({ sec: 60 }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${srv.base}/v1/admin/scopes/channel:C1/turn-wall-clock`, {
          method: "PUT",
          headers: ADMIN,
          body: JSON.stringify({ sec: 60 }),
        })
      ).status,
      400,
    );
    for (const sec of [59, 86_401, 60.5, "nope"]) {
      assert.equal((await fetch(url, { method: "PUT", headers: ADMIN, body: JSON.stringify({ sec }) })).status, 400);
    }
    assert.equal(
      (await fetch(url, { method: "PUT", headers: ADMIN, body: JSON.stringify({ sec: "120" }) })).status,
      200,
    );
    let body = (await (await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN })).json()) as {
      turnWallClockSec: number | null;
    };
    assert.equal(body.turnWallClockSec, 120);
    assert.equal((await fetch(url, { method: "PUT", headers: ADMIN, body: JSON.stringify({ sec: 0 }) })).status, 200);
    body = (await (await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN })).json()) as {
      turnWallClockSec: number | null;
    };
    assert.equal(body.turnWallClockSec, 0);
    assert.equal((await fetch(url, { method: "PUT", headers: ADMIN, body: JSON.stringify({ sec: "" }) })).status, 200);
    body = (await (await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN })).json()) as {
      turnWallClockSec: number | null;
    };
    assert.equal(body.turnWallClockSec, null);
    assert.equal((await fetch(url, { method: "PUT", headers: ADMIN, body: JSON.stringify({ sec: 120 }) })).status, 200);
    assert.equal(
      (await fetch(url, { method: "PUT", headers: ADMIN, body: JSON.stringify({ sec: "  " }) })).status,
      200,
    );
    body = (await (await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN })).json()) as {
      turnWallClockSec: number | null;
    };
    assert.equal(body.turnWallClockSec, null);
  } finally {
    await srv.close();
  }
});

test("branding governance validates, round-trips through surface-config, clears, and is org-admin-only", async () => {
  const srv = start();
  const url = `${srv.base}/v1/admin/scopes/org:default-org/branding`;
  const surfaceBranding = async () =>
    (
      (await (await fetch(`${srv.base}/v1/surface-config`)).json()) as {
        branding?: { accent?: string; mark?: string; selfLabel?: string };
      }
    ).branding;
  try {
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
          body: JSON.stringify({ accent: "#6366f1" }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${srv.base}/v1/admin/scopes/channel:C1/branding`, {
          method: "PUT",
          headers: ADMIN,
          body: JSON.stringify({ accent: "#6366f1" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(url, { method: "PUT", headers: ADMIN, body: JSON.stringify({ accent: "#abcde" }) })).status,
      400,
    );
    assert.equal(
      (await fetch(url, { method: "PUT", headers: ADMIN, body: JSON.stringify({ accent: "#aabbccddee" }) })).status,
      400,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: ADMIN,
          body: JSON.stringify({ accent: "#6366f1", mark: "Q", selfLabel: "{{qm}}", orgName: "Acme Corp" }),
        })
      ).status,
      200,
    );
    const readBack = (await (
      await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN })
    ).json()) as { branding?: { accent?: string; orgName?: string } };
    assert.equal(readBack.branding?.accent, "#6366f1");
    assert.equal(readBack.branding?.orgName, "Acme Corp");
    assert.deepEqual(await surfaceBranding(), { accent: "#6366f1", mark: "Q", selfLabel: "qm" });
    assert.equal(
      (await fetch(url, { method: "PUT", headers: ADMIN, body: JSON.stringify({ mark: "<b>xy" }) })).status,
      200,
    );
    assert.equal((await surfaceBranding())?.mark, "bx");
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: ADMIN,
          body: JSON.stringify({ accent: "", mark: "", selfLabel: "" }),
        })
      ).status,
      200,
    );
    assert.equal(await surfaceBranding(), undefined);
  } finally {
    await srv.close();
  }
});

test("surface-config filters persisted model choices to the active native harness", async () => {
  const srv = start("codex");
  try {
    srv.built.config.setBaseModel("org:default-org", "claude-opus-4-8");
    srv.built.config.setWebuiModels("org:default-org", ["claude-opus-4-8", "gpt-5.6-sol"]);
    const response = await fetch(`${srv.base}/v1/surface-config`);
    const config = (await response.json()) as { harnessId: string; baseModel: string; webuiModels: string[] };
    assert.equal(config.harnessId, "codex");
    assert.equal(config.baseModel, "gpt-5.6-sol");
    assert.deepEqual(config.webuiModels, ["gpt-5.6-sol"]);
  } finally {
    await srv.close();
  }
});

test("runtime-config lets a person set, keep, and inherit an approved personal runtime", async () => {
  const srv = start("pi");
  try {
    srv.built.config.setApprovedHarnesses(["pi", "codex", "claude"]);
    srv.built.config.setWebuiModels("org:default-org", ["claude-sonnet-4-6", "claude-opus-4-8", "gpt-5.5"]);
    srv.built.config.setRuntimeSelection("org:default-org", { harnessId: "pi", modelId: "claude-opus-4-8" });
    await srv.built.config.flushScope("org:default-org");
    const url = `${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal:alice`;

    const initial = (await fetch(url).then((r) => r.json())) as {
      effective: { harnessId: string };
      scopeOverride: unknown;
      modelsByHarness: Record<string, string[]>;
    };
    assert.equal(initial.effective.harnessId, "pi");
    assert.equal(initial.scopeOverride, null);
    assert.deepEqual(initial.modelsByHarness.claude, ["claude-sonnet-4-6", "claude-opus-4-8"]);
    assert.deepEqual(initial.modelsByHarness.codex, ["gpt-5.5"]);

    const set = await fetch(`${srv.base}/v1/runtime-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: "alice",
        scopeId: "personal:alice",
        harnessId: "codex",
        modelId: "gpt-5.5",
        effortLevel: "low",
        fastMode: true,
      }),
    });
    assert.equal(set.status, 200);
    const selected = (await set.json()) as {
      effective: { harnessId: string; effortLevel: string; fastMode: boolean };
    };
    assert.deepEqual(selected.effective, {
      harnessId: "codex",
      modelId: "gpt-5.5",
      effortLevel: "low",
      fastMode: false,
    });

    srv.built.config.setRuntimeSelection("org:default-org", { harnessId: "claude", modelId: "claude-opus-4-8" });
    await srv.built.config.flushScope("org:default-org");
    assert.equal(((await fetch(url).then((r) => r.json())) as { upgradeAvailable: boolean }).upgradeAvailable, true);

    const keep = await fetch(`${srv.base}/v1/runtime-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "alice", scopeId: "personal:alice", keep: true }),
    });
    assert.equal(((await keep.json()) as { upgradeAvailable: boolean }).upgradeAvailable, false);

    const inherit = await fetch(`${srv.base}/v1/runtime-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "alice", scopeId: "personal:alice", inherit: true }),
    });
    const inherited = (await inherit.json()) as { effective: { harnessId: string }; scopeOverride: unknown };
    assert.equal(inherited.effective.harnessId, "claude");
    assert.equal(inherited.scopeOverride, null);

    srv.built.config.setBaseModel("personal:alice", "claude-sonnet-4-6");
    await srv.built.config.flushScope("personal:alice");
    assert.equal(((await fetch(url).then((r) => r.json())) as { upgradeAvailable: boolean }).upgradeAvailable, true);
    const keepLegacy = await fetch(`${srv.base}/v1/runtime-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "alice", scopeId: "personal:alice", keep: true }),
    });
    const keptLegacy = (await keepLegacy.json()) as {
      upgradeAvailable: boolean;
      scopeOverride: { harnessId: string; modelId: string };
    };
    assert.equal(keptLegacy.upgradeAvailable, false);
    assert.deepEqual(keptLegacy.scopeOverride, { harnessId: "pi", modelId: "claude-sonnet-4-6", orgRevision: 2 });
  } finally {
    await srv.close();
  }
});

test("PUT to an unknown resource is a 404", async () => {
  const srv = start();
  try {
    const r = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/not-a-resource`, {
      method: "PUT",
      headers: ADMIN,
      body: "{}",
    });
    assert.equal(r.status, 404);
  } finally {
    await srv.close();
  }
});

test("a generic resource round-trips through the registry dispatch + read loop", async () => {
  const srv = start();
  try {
    const put = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/soul`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ content: "be excellent", expectedVersion: 1 }),
    });
    assert.equal(put.status, 200);
    const get = await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    const body = (await get.json()) as {
      soul: string;
      soulVersion: number;
      soulHistory: Array<{ content: string; version: number; updatedBy?: string; updatedAt: number }>;
    };
    assert.equal(body.soul, "be excellent");
    assert.equal(body.soulVersion, 2);
    assert.equal(body.soulHistory[0]?.content, "be excellent");
    assert.equal(body.soulHistory[0]?.updatedBy, "admin-alice");
    assert.ok(body.soulHistory[0]?.updatedAt);

    const stale = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/soul`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ content: "overwrite", expectedVersion: 1 }),
    });
    assert.equal(stale.status, 409);
    assert.match(await stale.text(), /changed after this draft was loaded/);
  } finally {
    await srv.close();
  }
});

test("feature flag table changes one scope live without restart", async () => {
  const srv = start();
  try {
    const endpoint = `${srv.base}/v1/admin/scopes/org:default-org/feature-flags`;
    assert.equal(await srv.built.featureFlags.enabled("command_scoped_credentials", "channel:C1"), false);
    const enable = await fetch(endpoint, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ featureName: "command_scoped_credentials", scopeId: "channel:C1", on: true }),
    });
    assert.equal(enable.status, 200);
    assert.equal(await srv.built.featureFlags.enabled("command_scoped_credentials", "channel:C1"), true);
    assert.equal(await srv.built.featureFlags.enabled("command_scoped_credentials", "channel:C2"), false);
    const read = await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    const flags = ((await read.json()) as { featureFlags: Array<{ enabledScopes: string[] }> }).featureFlags;
    assert.deepEqual(flags[0]?.enabledScopes, ["channel:C1"]);
  } finally {
    await srv.close();
  }
});

test("device-flow cutover is scope-specific, audited, and reverses without deleting records", async () => {
  const srv = start();
  try {
    const scope = "channel:C1";
    const endpoint = `${srv.base}/v1/admin/scopes/${encodeURIComponent(scope)}/device-flow-cutover`;
    const prefer = await fetch(endpoint, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ service: "acmecli", mode: "prefer_ephemeral" }),
    });
    assert.equal(prefer.status, 200);
    assert.equal(await srv.built.deviceFlowCutover.resolve(scope, "acmecli"), "prefer_ephemeral");

    const read = await fetch(`${srv.base}/v1/admin/scopes/${encodeURIComponent(scope)}`, { headers: ADMIN });
    const body = (await read.json()) as {
      deviceFlowCutover: { acmecli: { effective: string; configured: { updatedBy: string } } };
    };
    assert.equal(body.deviceFlowCutover.acmecli.effective, "prefer_ephemeral");
    assert.equal(body.deviceFlowCutover.acmecli.configured.updatedBy, "admin-alice");

    const unsupported = await fetch(endpoint, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ service: "aws", mode: "ephemeral_only" }),
    });
    assert.equal(unsupported.status, 400);
    assert.match(await unsupported.text(), /no credential paths/);

    const rollback = await fetch(endpoint, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ service: "acmecli", mode: "legacy" }),
    });
    assert.equal(rollback.status, 200);
    assert.equal(await srv.built.deviceFlowCutover.resolve(scope, "acmecli"), "legacy");

    await srv.built.deviceFlowCutover.set("org:default-org", "acmecli", "prefer_ephemeral", "admin-alice");
    const inherit = await fetch(endpoint, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ service: "acmecli", mode: "inherit" }),
    });
    assert.equal(inherit.status, 200);
    assert.equal(await srv.built.deviceFlowCutover.get(scope, "acmecli"), null);
    assert.equal(await srv.built.deviceFlowCutover.resolve(scope, "acmecli"), "prefer_ephemeral");
    assert.ok((await srv.built.auditLog.events()).some((event) => event.action === "device-flow-cutover.update"));
    assert.ok(
      (await srv.built.auditLog.events()).some(
        (event) =>
          event.action === "credential.cutover.update" &&
          event.resource === "acmecli:legacy/legacy->inherit/prefer_ephemeral",
      ),
    );
  } finally {
    await srv.close();
  }
});

test("security posture round-trips through durable scoped governance", async () => {
  const srv = start();
  try {
    const before = await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    assert.equal(((await before.json()) as { securityPosture: string }).securityPosture, "auto");

    const put = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/security-posture`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ posture: "strict" }),
    });
    assert.equal(put.status, 200);
    const after = await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    assert.equal(((await after.json()) as { securityPosture: string }).securityPosture, "strict");

    const invalid = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/security-posture`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ posture: "YOLO" }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await srv.close();
  }
});

test("approval grant modes round-trip, validate, and compose tighten-only across scopes", async () => {
  const srv = start();
  try {
    const before = await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    assert.deepEqual(((await before.json()) as { approvalGrantModes: unknown }).approvalGrantModes, {
      session: true,
      always: true,
    });

    const put = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/approval-grant-modes`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ session: true, always: false }),
    });
    assert.equal(put.status, 200);
    const after = await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    assert.deepEqual(((await after.json()) as { approvalGrantModes: unknown }).approvalGrantModes, {
      session: true,
      always: false,
    });

    const scoped = await fetch(`${srv.base}/v1/admin/scopes/channel:C1/approval-grant-modes`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ session: false, always: true }),
    });
    assert.equal(scoped.status, 200);
    const channel = await fetch(`${srv.base}/v1/admin/scopes/channel:C1`, { headers: ADMIN });
    assert.deepEqual(((await channel.json()) as { approvalGrantModes: unknown }).approvalGrantModes, {
      session: false,
      always: false,
    });

    const invalid = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/approval-grant-modes`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ session: "yes" }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await srv.close();
  }
});

test("base-model is a sparse per-scope override: a channel pins its own model, empty clears back to inherit", async () => {
  const srv = start();
  try {
    const def = await fetch(`${srv.base}/v1/admin/scopes/channel:C1`, { headers: ADMIN });
    assert.equal(((await def.json()) as { baseModel: string | null }).baseModel, null);

    const unknown = await fetch(`${srv.base}/v1/admin/scopes/channel:C1/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "not-a-model" }),
    });
    assert.equal(unknown.status, 400);
    assert.match(((await unknown.json()) as { message: string }).message, /unknown model id/);

    const put = await fetch(`${srv.base}/v1/admin/scopes/channel:C1/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "claude-opus-4-8" }),
    });
    assert.equal(put.status, 200);
    const got = await fetch(`${srv.base}/v1/admin/scopes/channel:C1`, { headers: ADMIN });
    assert.equal(((await got.json()) as { baseModel: string | null }).baseModel, "claude-opus-4-8");

    const clear = await fetch(`${srv.base}/v1/admin/scopes/channel:C1/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "" }),
    });
    assert.equal(clear.status, 200);
    const afterClear = await fetch(`${srv.base}/v1/admin/scopes/channel:C1`, { headers: ADMIN });
    assert.equal(((await afterClear.json()) as { baseModel: string | null }).baseModel, null);
  } finally {
    await srv.close();
  }
});

test("admin runtime saves reasoning level and fast mode with the default model", async () => {
  const srv = start();
  const url = `${srv.base}/v1/admin/scopes/org:default-org/runtime`;
  try {
    srv.built.config.setApprovedHarnesses(["pi", "opencode", "codex"]);
    await srv.built.config.flushScope("org:default-org");
    const saved = await fetch(url, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ harnessId: "pi", modelId: "claude-opus-5", effortLevel: "high", fastMode: true }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await srv.built.config.getRuntimeSelectionDurable("org:default-org"), {
      harnessId: "pi",
      modelId: "claude-opus-5",
      effortLevel: "high",
      fastMode: true,
      orgRevision: 1,
      revision: 1,
    });

    const changedModel = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "claude-fable-5" }),
    });
    assert.equal(changedModel.status, 200);
    assert.deepEqual(await srv.built.config.getRuntimeSelectionDurable("org:default-org"), {
      harnessId: "pi",
      modelId: "claude-fable-5",
      effortLevel: "high",
      fastMode: false,
      orgRevision: 2,
      revision: 2,
    });

    const unsupported = await fetch(url, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ harnessId: "pi", modelId: "claude-fable-5", effortLevel: "low", fastMode: true }),
    });
    assert.equal(unsupported.status, 200);
    assert.equal((await srv.built.config.getRuntimeSelectionDurable("org:default-org"))?.fastMode, false);

    const unsupportedHarness = await fetch(url, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ harnessId: "opencode", modelId: "claude-opus-5", effortLevel: "auto", fastMode: true }),
    });
    assert.equal(unsupportedHarness.status, 200);
    assert.equal((await srv.built.config.getRuntimeSelectionDurable("org:default-org"))?.fastMode, false);

    for (const body of [
      { harnessId: "pi", modelId: "claude-opus-5", effortLevel: "extreme", fastMode: true },
      { harnessId: "codex", modelId: "gpt-5.5", effortLevel: "max", fastMode: false },
      { harnessId: "pi", modelId: "claude-opus-5", effortLevel: "high", fastMode: "yes" },
    ]) {
      assert.equal((await fetch(url, { method: "PUT", headers: ADMIN, body: JSON.stringify(body) })).status, 400);
    }
  } finally {
    await srv.close();
  }
});

test("ambient-policy edits a channel's standing order and bot ledger through the registry", async () => {
  const srv = start();
  try {
    const org = (await (
      await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN })
    ).json()) as Record<string, unknown>;
    assert.equal("ambientPolicy" in org, false);
    const empty = (await (await fetch(`${srv.base}/v1/admin/scopes/channel:C1`, { headers: ADMIN })).json()) as {
      ambientPolicy: { orders: string; bots: object; updatedAt: number };
    };
    assert.deepEqual(empty.ambientPolicy, { orders: "", bots: {}, ambientEnabled: null, updatedAt: 0 });

    const badScope = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/ambient-policy`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ orders: "x", bots: {} }),
    });
    assert.equal(badScope.status, 400);
    const badMode = await fetch(`${srv.base}/v1/admin/scopes/channel:C1/ambient-policy`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ orders: "", bots: { GitHub: { mode: "mute" } } }),
    });
    assert.equal(badMode.status, 400);
    assert.match(((await badMode.json()) as { message: string }).message, /mode must be one of/);
    const badHours = await fetch(`${srv.base}/v1/admin/scopes/channel:C1/ambient-policy`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ orders: "", bots: { GitHub: { mode: "rollup", rollupHours: -2 } } }),
    });
    assert.equal(badHours.status, 400);
    const caseDup = await fetch(`${srv.base}/v1/admin/scopes/channel:C1/ambient-policy`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ orders: "", bots: { GitHub: { mode: "action" }, github: { mode: "ignore" } } }),
    });
    assert.equal(caseDup.status, 400);
    assert.match(((await caseDup.json()) as { message: string }).message, /duplicate bot/i);

    const put = await fetch(`${srv.base}/v1/admin/scopes/channel:C1/ambient-policy`, {
      method: "PUT",
      headers: ADMIN,
      body: '{"orders":"flag anything about the Q3 launch","bots":{"GitHub":{"mode":"rollup","rollupHours":24},"Linear":{"mode":"ignore"},"__proto__":{"mode":"ignore"}}}',
    });
    assert.equal(put.status, 200);
    const got = (await (await fetch(`${srv.base}/v1/admin/scopes/channel:C1`, { headers: ADMIN })).json()) as {
      ambientPolicy: { orders: string; bots: object; updatedAt: number };
    };
    const stored = await srv.built.channelPolicy.get("C1");
    assert.equal(got.ambientPolicy.orders, "flag anything about the Q3 launch");
    assert.deepEqual(Object.keys(got.ambientPolicy.bots).sort(), ["GitHub", "Linear", "__proto__"]);
    assert.equal(got.ambientPolicy.updatedAt, stored?.updatedAt);
    assert.equal(stored?.setBy, "admin-alice");
    const revs = await srv.built.channelPolicy.history("C1");
    assert.deepEqual(Object.keys(revs[0]?.bots ?? {}).sort(), ["GitHub", "Linear", "__proto__"]);

    const stale = await fetch(`${srv.base}/v1/admin/scopes/channel:C1/ambient-policy`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ orders: "overwrite", bots: {}, baseUpdatedAt: 1 }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await srv.built.channelPolicy.get("C1"))?.orders, "flag anything about the Q3 launch");
    const fresh = await fetch(`${srv.base}/v1/admin/scopes/channel:C1/ambient-policy`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ orders: "updated", bots: {}, baseUpdatedAt: stored?.updatedAt }),
    });
    assert.equal(fresh.status, 200);
    assert.equal((await srv.built.channelPolicy.get("C1"))?.orders, "updated");
  } finally {
    await srv.close();
  }
});

test("webui-models is an org-wide string-list read back via admin GET and surface-config", async () => {
  const srv = start();
  try {
    const bad = await fetch(`${srv.base}/v1/admin/scopes/personal:U1/webui-models`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ids: ["claude-opus-4-8"] }),
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { message: string }).message, /org-wide/);

    const unknown = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/webui-models`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ids: ["not-a-model"] }),
    });
    assert.equal(unknown.status, 400);
    assert.match(((await unknown.json()) as { message: string }).message, /unknown model id/);

    const put = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/webui-models`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ids: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-sonnet-4-6"] }),
    });
    assert.equal(put.status, 200);
    const adminGet = await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    assert.deepEqual(((await adminGet.json()) as { webuiModels: string[] }).webuiModels, [
      "claude-sonnet-4-6",
      "claude-opus-4-8",
    ]);
    const surf = await fetch(`${srv.base}/v1/surface-config`);
    assert.deepEqual(((await surf.json()) as { webuiModels: string[] }).webuiModels, [
      "claude-sonnet-4-6",
      "claude-opus-4-8",
    ]);

    const before = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(((await before.json()) as { baseModel: string }).baseModel, "claude-opus-5");
    const setBase = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "claude-sonnet-4-6" }),
    });
    assert.equal(setBase.status, 200);
    const after = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(((await after.json()) as { baseModel: string }).baseModel, "claude-sonnet-4-6");

    const clear = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/webui-models`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ids: [] }),
    });
    assert.equal(clear.status, 200);
    const afterClear = await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    assert.equal(((await afterClear.json()) as { webuiModels: string[] | null }).webuiModels, null);
  } finally {
    await srv.close();
  }
});

test("internal-member-overrides is org-only, validates entries, audits, and round-trips", async () => {
  const srv = start();
  try {
    const wrongScope = await fetch(`${srv.base}/v1/admin/scopes/personal:U1/internal-member-overrides`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ members: ["u1"] }),
    });
    assert.equal(wrongScope.status, 400);
    assert.match(((await wrongScope.json()) as { message: string }).message, /org-wide/);

    const notArray = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/internal-member-overrides`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ members: "u1" }),
    });
    assert.equal(notArray.status, 400);
    assert.match(((await notArray.json()) as { message: string }).message, /requires/);

    const badEntry = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/internal-member-overrides`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ members: ["ok@example.com", "  "] }),
    });
    assert.equal(badEntry.status, 400);
    assert.match(((await badEntry.json()) as { message: string }).message, /non-empty string/);

    const put = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/internal-member-overrides`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ members: [" Contractor@EXAMPLE.com ", "U123ABC", "contractor@example.com"] }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(srv.built.config.getInternalMemberOverrides(), ["contractor@example.com", "u123abc"]);
    const adminGet = await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    assert.deepEqual(((await adminGet.json()) as { internalMemberOverrides: string[] }).internalMemberOverrides, [
      "contractor@example.com",
      "u123abc",
    ]);
    assert.ok(
      (await srv.built.auditLog.events()).some((event) => event.action === "identity.internal-override.update"),
    );

    const clear = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/internal-member-overrides`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ members: [] }),
    });
    assert.equal(clear.status, 200);
    assert.deepEqual(srv.built.config.getInternalMemberOverrides(), []);
  } finally {
    await srv.close();
  }
});

test("GET /v1/admin/slack-emoji surfaces 404 without a token, and serves the plugin-published catalog once one exists", async () => {
  const srv = start();
  try {
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
  } finally {
    await srv.close();
  }
});

test("historical cutover policies remain visible and clearable without layer tools", async () => {
  const srv = start("pi", false);
  try {
    const scope = "channel:C1";
    await srv.built.deviceFlowCutover.set("org:default-org", "retired", "ephemeral_only", "admin");
    const read = await fetch(`${srv.base}/v1/admin/scopes/${encodeURIComponent(scope)}`, { headers: ADMIN });
    const body = (await read.json()) as { deviceFlowCutover: { retired: { effective: string } } };
    assert.equal(body.deviceFlowCutover.retired.effective, "ephemeral_only");
    const update = await fetch(`${srv.base}/v1/admin/scopes/${encodeURIComponent(scope)}/device-flow-cutover`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ service: "retired", mode: "legacy" }),
    });
    assert.equal(update.status, 200);
    const clear = await fetch(`${srv.base}/v1/admin/scopes/${encodeURIComponent(scope)}/device-flow-cutover`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ service: "retired", mode: "inherit" }),
    });
    assert.equal(clear.status, 200);
    assert.equal(await srv.built.deviceFlowCutover.resolve(scope, "retired"), "ephemeral_only");
  } finally {
    await srv.close();
  }
});

const FACTORY_BODY = {
  forge: "github",
  publishProject: "yc-software/qm",
  targetBranch: "main",
  repoCloneUrl: "https://github.com/yc-software/qm.git",
  linearTeamId: "QM",
  sourceAppDirs: "src,plugins",
  sourceTestRe: "^test/.*\\.test\\.ts$",
  verifyTestsCmd: "npm test",
  verifyTestFileCmd: "node --test",
  verifyLintCmd: "npm run lint",
  bugbotRequired: true,
  followupsEnabled: false,
};

const putFactory = (base: string, scope: string, body: unknown, headers: Record<string, string> = ADMIN) =>
  fetch(`${base}/v1/admin/scopes/${scope}/factory-config`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });

const scopeConfig = async (base: string, scope: string): Promise<Record<string, unknown>> =>
  (await (await fetch(`${base}/v1/admin/scopes/${scope}`, { headers: ADMIN })).json()) as Record<string, unknown>;

const withoutKey = (key: string): Record<string, unknown> => {
  const body: Record<string, unknown> = { ...FACTORY_BODY };
  delete body[key];
  return body;
};

test("factory-config round-trips through the org scope, replaces wholesale, and is admin-gated", async () => {
  const srv = start();
  try {
    const before = await scopeConfig(srv.base, "org:default-org");
    assert.equal(before.factoryConfig, null);

    const put = await putFactory(srv.base, "org:default-org", FACTORY_BODY);
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { ok: true, scopeId: "org:default-org", resource: "factory-config" });

    const after = await scopeConfig(srv.base, "org:default-org");
    assert.deepEqual(after.factoryConfig, FACTORY_BODY);
    const stored = after.factoryConfig as Record<string, unknown>;
    for (const optional of ["repoSetupCmd", "proofStartCmd", "proofBaseUrlCmd", "slackChannel"]) {
      assert.equal(Object.hasOwn(stored, optional), false, `${optional} must not be materialized`);
    }
    assert.deepEqual({ ...after, factoryConfig: null }, { ...before, factoryConfig: null });

    const audit = (await (
      await fetch(`${srv.base}/v1/admin/audit?scope=org:default-org`, { headers: ADMIN })
    ).json()) as { events: { action: string; resource: string; principalId: string }[] };
    const updates = audit.events.filter((e) => e.action === "factory-config.update");
    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.resource, "factory-config");
    assert.equal(updates[0]!.principalId, "admin-alice");

    const withOptionals = { ...FACTORY_BODY, repoSetupCmd: "npm ci", proofStartCmd: "npm run dev" };
    assert.equal((await putFactory(srv.base, "org:default-org", withOptionals)).status, 200);
    assert.deepEqual((await scopeConfig(srv.base, "org:default-org")).factoryConfig, withOptionals);

    assert.equal(
      (await putFactory(srv.base, "org:default-org", { ...FACTORY_BODY, targetBranch: "  release  " })).status,
      200,
    );
    assert.deepEqual((await scopeConfig(srv.base, "org:default-org")).factoryConfig, {
      ...FACTORY_BODY,
      targetBranch: "release",
    });

    const denied = await putFactory(srv.base, "org:default-org", FACTORY_BODY, {
      "content-type": "application/json",
      "x-admin-actor": "nobody@default-org",
    });
    assert.equal(denied.status, 403);
    assert.deepEqual((await scopeConfig(srv.base, "org:default-org")).factoryConfig, {
      ...FACTORY_BODY,
      targetBranch: "release",
    });
  } finally {
    await srv.close();
  }
});

test("factory-config rejects every malformed body by name and leaves the stored record intact", async () => {
  const srv = start();
  try {
    assert.equal((await putFactory(srv.base, "org:default-org", FACTORY_BODY)).status, 200);

    const cases: [unknown, string][] = [
      [{ ...FACTORY_BODY, forge: "bitbucket" }, "forge"],
      [{}, "forge"],
      [withoutKey("verifyTestsCmd"), "verifyTestsCmd"],
      [{ ...FACTORY_BODY, targetBranch: "   " }, "targetBranch"],
      [{ ...FACTORY_BODY, bugbotRequired: "true" }, "bugbotRequired"],
      [{ ...FACTORY_BODY, slackChannel: 42 }, "slackChannel"],
      [{ ...FACTORY_BODY, repoSetupCmd: null }, "repoSetupCmd"],
      [{ ...FACTORY_BODY, linearTeamID: "QM" }, "linearTeamID"],
      [[], "body must be an object"],
      [null, "body must be an object"],
    ];
    for (const [body, named] of cases) {
      const r = await putFactory(srv.base, "org:default-org", body);
      const label = JSON.stringify(body);
      assert.equal(r.status, 400, label);
      const payload = (await r.json()) as { error: string; message: string };
      assert.equal(payload.error, "bad_request", label);
      assert.ok(payload.message.startsWith("factory-config: "), `${label} → ${payload.message}`);
      assert.ok(payload.message.includes(named), `${label} → ${payload.message}`);
    }

    assert.deepEqual((await scopeConfig(srv.base, "org:default-org")).factoryConfig, FACTORY_BODY);
    const audit = (await (
      await fetch(`${srv.base}/v1/admin/audit?scope=org:default-org`, { headers: ADMIN })
    ).json()) as { events: { action: string }[] };
    assert.equal(audit.events.filter((e) => e.action === "factory-config.update").length, 1);
  } finally {
    await srv.close();
  }
});

test("factory-config is org-only at every scope while non-org reads echo the org record", async () => {
  const srv = start();
  try {
    assert.equal((await putFactory(srv.base, "org:default-org", FACTORY_BODY)).status, 200);

    for (const scope of ["channel:C1", "personal:U1"]) {
      for (const body of [FACTORY_BODY, { reset: true }]) {
        const r = await putFactory(srv.base, scope, body);
        assert.equal(r.status, 400, `${scope} ${JSON.stringify(body)}`);
        const payload = (await r.json()) as { error: string; message: string };
        assert.equal(payload.error, "bad_request");
        assert.equal(payload.message, "the factory config is org-wide; target an org scope");
      }
    }

    assert.deepEqual((await scopeConfig(srv.base, "org:default-org")).factoryConfig, FACTORY_BODY);
    const channel = await fetch(`${srv.base}/v1/admin/scopes/channel:C1`, { headers: ADMIN });
    assert.equal(channel.status, 200);
    assert.deepEqual(((await channel.json()) as Record<string, unknown>).factoryConfig, FACTORY_BODY);
  } finally {
    await srv.close();
  }
});

test("factory-config clears with { reset: true } only, idempotently, and leaves other org settings alone", async () => {
  const srv = start();
  try {
    assert.equal(
      (
        await fetch(`${srv.base}/v1/admin/scopes/org:default-org/approved-harnesses`, {
          method: "PUT",
          headers: ADMIN,
          body: JSON.stringify({ ids: ["pi"] }),
        })
      ).status,
      200,
    );
    assert.equal((await putFactory(srv.base, "org:default-org", FACTORY_BODY)).status, 200);
    const seeded = await scopeConfig(srv.base, "org:default-org");

    const reset = await putFactory(srv.base, "org:default-org", { reset: true });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { ok: true, scopeId: "org:default-org", resource: "factory-config" });

    const cleared = await scopeConfig(srv.base, "org:default-org");
    assert.equal(Object.hasOwn(cleared, "factoryConfig"), true);
    assert.equal(cleared.factoryConfig, null);
    assert.deepEqual(cleared.approvedHarnesses, seeded.approvedHarnesses);
    assert.deepEqual({ ...cleared, factoryConfig: null }, { ...seeded, factoryConfig: null });

    assert.equal((await putFactory(srv.base, "org:default-org", { reset: true })).status, 200);
    assert.equal((await scopeConfig(srv.base, "org:default-org")).factoryConfig, null);

    assert.equal((await putFactory(srv.base, "org:default-org", FACTORY_BODY)).status, 200);
    assert.deepEqual((await scopeConfig(srv.base, "org:default-org")).factoryConfig, FACTORY_BODY);

    for (const body of [{ reset: true, forge: "github" }, { reset: false }, { reset: "true" }, { reset: 1 }]) {
      const r = await putFactory(srv.base, "org:default-org", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(((await r.json()) as { message: string }).message, "factory-config: unknown key reset");
    }
    assert.deepEqual((await scopeConfig(srv.base, "org:default-org")).factoryConfig, FACTORY_BODY);
  } finally {
    await srv.close();
  }
});

const factoryLoops = async (built: BuiltApp) =>
  (await built.loops.store.list()).filter((loop) => loop.surface === "factory");

test("applying a factory config mints one factory loop owned by the acting admin at the deployment org scope", async () => {
  const srv = start();
  try {
    assert.deepEqual(await srv.built.loops.store.list(), []);
    assert.equal((await putFactory(srv.base, "org:default-org", FACTORY_BODY)).status, 200);

    const loops = await factoryLoops(srv.built);
    assert.equal(loops.length, 1);
    const loop = loops[0]!;
    assert.equal(loop.owner, "admin-alice");
    assert.equal(loop.ownerScopeId, "org:default-org");
    assert.equal((await srv.built.loops.store.list()).length, 1);
    assert.equal((await fetch(`${srv.base}/v1/loops/${loop.id}?principalId=admin-alice`)).status, 200);

    const fired = await srv.built.loops.fire!.fire(loop.id, "apply-fire-1");
    assert.equal(fired.status, "failed");
    assert.match(fired.note ?? "", /factory_credentials_missing: factory-linear, factory-github/);
  } finally {
    await srv.close();
  }
});

test("re-applying a factory config never mints a second loop and never re-owns the first", async () => {
  const srv = start();
  try {
    assert.equal((await putFactory(srv.base, "org:default-org", FACTORY_BODY)).status, 200);
    const first = (await factoryLoops(srv.built))[0]!;

    const bob = { "content-type": "application/json", "x-admin-actor": "admin-bob@default-org" };
    const repeats: [string, string, unknown, Record<string, string>][] = [
      ["same admin, same body", "org:default-org", FACTORY_BODY, ADMIN],
      ["another admin", "org:default-org", FACTORY_BODY, bob],
      ["edited config", "org:default-org", { ...FACTORY_BODY, targetBranch: "release" }, ADMIN],
      ["another org scope in the path", "org:other-org", FACTORY_BODY, ADMIN],
    ];
    for (const [label, scope, body, headers] of repeats) {
      assert.equal((await putFactory(srv.base, scope, body, headers)).status, 200, label);
      const loops = await factoryLoops(srv.built);
      assert.equal(loops.length, 1, label);
      assert.deepEqual(loops[0], first, label);
    }
    assert.equal((await srv.built.loops.store.list()).length, 1);
  } finally {
    await srv.close();
  }
});

test("resetting the factory config clears the config only and leaves the loop standing", async () => {
  const srv = start();
  try {
    assert.equal((await putFactory(srv.base, "org:default-org", { reset: true })).status, 200);
    assert.deepEqual(await srv.built.loops.store.list(), []);

    assert.equal((await putFactory(srv.base, "org:default-org", FACTORY_BODY)).status, 200);
    const loop = (await factoryLoops(srv.built))[0]!;

    assert.equal((await putFactory(srv.base, "org:default-org", { reset: true })).status, 200);
    assert.equal((await scopeConfig(srv.base, "org:default-org")).factoryConfig, null);
    assert.deepEqual(await srv.built.loops.store.list(), [loop]);

    const fired = await srv.built.loops.fire!.fire(loop.id, "reset-fire-1");
    assert.equal(fired.status, "failed");
    assert.match(fired.note ?? "", /factory_config_missing/);
  } finally {
    await srv.close();
  }
});

test("deleting the factory loop and applying again brings exactly one back", async () => {
  const srv = start();
  try {
    assert.equal((await putFactory(srv.base, "org:default-org", FACTORY_BODY)).status, 200);
    const first = (await factoryLoops(srv.built))[0]!;

    const deleted = await fetch(`${srv.base}/v1/loops/${first.id}?principalId=admin-alice`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await srv.built.loops.store.list(), []);

    assert.equal((await putFactory(srv.base, "org:default-org", FACTORY_BODY)).status, 200);
    assert.equal((await factoryLoops(srv.built)).length, 1);
  } finally {
    await srv.close();
  }
});

test("a rejected factory-config apply leaves no loop behind", async () => {
  const srv = start();
  try {
    const rejected: [string, string, unknown, Record<string, string>][] = [
      ["missing verifyLintCmd", "org:default-org", withoutKey("verifyLintCmd"), ADMIN],
      ["unknown key", "org:default-org", { ...FACTORY_BODY, linearTeamID: "QM" }, ADMIN],
      ["unknown forge", "org:default-org", { ...FACTORY_BODY, forge: "svn" }, ADMIN],
      ["non-org scope", "channel:C1", FACTORY_BODY, ADMIN],
      ["non-admin actor", "org:default-org", FACTORY_BODY, { ...ADMIN, "x-admin-actor": "nobody@default-org" }],
    ];
    for (const [label, scope, body, headers] of rejected) {
      const r = await putFactory(srv.base, scope, body, headers);
      assert.equal(r.status, headers["x-admin-actor"] === "nobody@default-org" ? 403 : 400, label);
      assert.deepEqual(await srv.built.loops.store.list(), [], label);
    }
  } finally {
    await srv.close();
  }
});

test("a deployment without loops wired still accepts its factory config", async () => {
  const srv = start("pi", true, () => ({ loops: undefined }));
  try {
    assert.equal((await putFactory(srv.base, "org:default-org", FACTORY_BODY)).status, 200);
    assert.deepEqual((await scopeConfig(srv.base, "org:default-org")).factoryConfig, FACTORY_BODY);
    assert.deepEqual(await srv.built.loops.store.list(), []);
  } finally {
    await srv.close();
  }
});

test("a factory loop that fails to be created surfaces as an error and a retry converges to one loop", async () => {
  let failNext = true;
  const srv = start("pi", true, (built) => ({
    loops: {
      ...built.loops,
      store: {
        ...built.loops.store,
        create: async (input) => {
          if (failNext) {
            failNext = false;
            throw new Error("loop store is down");
          }
          return built.loops.store.create(input);
        },
      },
    },
  }));
  try {
    const failed = await putFactory(srv.base, "org:default-org", FACTORY_BODY);
    assert.equal(failed.status, 500);
    assert.equal(((await failed.json()) as { error: string }).error, "internal_error");
    assert.deepEqual(await srv.built.loops.store.list(), []);

    assert.equal((await putFactory(srv.base, "org:default-org", FACTORY_BODY)).status, 200);
    assert.equal((await factoryLoops(srv.built)).length, 1);
  } finally {
    await srv.close();
  }
});

test("the public loop create route still refuses to carry a surface", async () => {
  const srv = start();
  try {
    const created = await fetch(`${srv.base}/v1/loops?principalId=admin-alice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "not the factory",
        playbook: "do the thing",
        successCondition: "the thing is done",
        surface: "factory",
      }),
    });
    assert.equal(created.status, 200);
    const loop = ((await created.json()) as { loop: { id: string; surface?: string } }).loop;
    assert.equal(loop.surface, undefined);
    assert.deepEqual(await factoryLoops(srv.built), []);
  } finally {
    await srv.close();
  }
});
