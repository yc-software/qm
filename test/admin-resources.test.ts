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

function brokeredLayer(): string {
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
        broker: {
          kind: "aws-role",
          roleArnEnv: "TEST_BROKER_ROLE_ARN",
          region: "us-west-2",
          sessionActions: ["execute-api:Invoke"],
        },
      },
    }),
  );
  return dir;
}

function start(harnessId = "pi"): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-res-")), deploymentLayerDir: brokeredLayer() }),
  );
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    sessions: built.sessions,
    acl: built.acl,
    serviceCreds: built.serviceCreds,
    deviceFlowCutover: built.deviceFlowCutover,
    brokeredServices: () => built.brokeredTools.map((tool) => tool.service),
    channelPolicy: built.channelPolicy,
    harnessId,
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
      resources: { id: string; kind: string; target?: string; secret?: boolean; enumValues?: unknown[] }[];
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
    srv.built.config.setWebuiModels("org:default-org", ["claude-sonnet-4-6", "gpt-5.5"]);
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
    assert.deepEqual(initial.modelsByHarness.claude, ["claude-sonnet-4-6"]);
    assert.deepEqual(initial.modelsByHarness.codex, ["gpt-5.5"]);

    const outsidePicker = await fetch(`${srv.base}/v1/runtime-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: "alice",
        scopeId: "personal:alice",
        harnessId: "claude",
        modelId: "claude-haiku-4-5",
      }),
    });
    assert.equal(outsidePicker.status, 400);
    assert.equal(((await outsidePicker.json()) as { error: string }).error, "model_not_enabled");

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
    assert.match(await unsupported.text(), /no isolated adapter/);

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
