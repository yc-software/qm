import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { resolveRuntimeChoiceDurable } from "../src/harness/harness-router.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import { projectScopeId } from "../src/projects/project-store.ts";
import { testConfig } from "./support/test-config.ts";

const ORG = "org:default-org";
const fallback = { harnessId: "pi" as const, modelId: "claude-opus-5" };
const override = { harnessId: "codex", modelId: "gpt-5.5", effortLevel: "high", fastMode: false };
async function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "runtime-card-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    identity: built.identity,
    auditLog: built.auditLog,
    harnessId: "pi",
    baseModelDefault: fallback.modelId,
    providerKeys: { anthropic: true, openai: false, openrouter: false, codexOAuth: true },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  await built.config.setRuntimeSelectionLatest(ORG, fallback);
  built.config.setApprovedHarnesses(["pi", "codex"]);
  await built.config.flushScope(ORG);
  const headers = (actor: string) => ({ "content-type": "application/json", "x-admin-actor": `${actor}@default-org` });
  const get = (scope: string, actor = "admin-alice") =>
    fetch(`${base}/v1/admin/scopes/${encodeURIComponent(scope)}`, { headers: headers(actor) });
  const put = (scope: string, body: unknown, actor = "admin-alice") =>
    fetch(`${base}/v1/admin/scopes/${encodeURIComponent(scope)}/runtime`, {
      method: "PUT",
      headers: headers(actor),
      body: JSON.stringify(body),
    });
  return { built, get, put, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("admin runtime round trips every existing scope kind without touching siblings or org", async () => {
  const s = await start();
  try {
    const project = await s.built.projects.create({ name: "Runtime fixture", ownerId: "owner-alice" });
    for (const scope of ["channel:C1", projectScopeId(project.id), "personal:alice", "team:T1"]) {
      assert.equal((await s.put(scope, override)).status, 200);
      const data = (await (await s.get(scope)).json()) as any;
      assert.equal(data.scopeId, scope);
      assert.equal(data.runtime.modelId, override.modelId);
      assert.equal(data.runtime.effortLevel, "high");
      assert.equal(data.baseModel, override.modelId);
      assert.equal((await s.built.config.getRuntimeSelectionDurable(ORG))?.modelId, fallback.modelId);
      assert.equal(await s.built.config.getRuntimeSelectionDurable("channel:untouched"), null);
      assert.equal((await s.put(scope, { inherit: true })).status, 200);
      const reset = (await (await s.get(scope)).json()) as any;
      assert.equal(reset.runtime, null);
      assert.equal(reset.baseModel, null);
      assert.deepEqual(await resolveRuntimeChoiceDurable(s.built.config, ORG, scope, fallback), fallback);
    }
    assert.equal((await s.put(ORG, override)).status, 200);
    assert.equal(((await (await s.get(ORG)).json()) as any).runtime.harnessId, "codex");
    assert.deepEqual(await resolveRuntimeChoiceDurable(s.built.config, ORG, "channel:C1", fallback), override);
  } finally {
    await s.close();
  }
});

test("reset clears legacy model-only rows and follows future org tuple changes", async () => {
  const s = await start();
  try {
    s.built.config.setBaseModel("channel:legacy", "claude-fable-5");
    await s.built.config.flushScope("channel:legacy");
    const legacy = (await (await s.get("channel:legacy")).json()) as any;
    assert.equal(legacy.runtime, null);
    assert.equal(legacy.baseModel, "claude-fable-5");
    assert.equal((await s.put("channel:legacy", { inherit: true })).status, 200);
    assert.equal((await s.put(ORG, override)).status, 200);
    assert.deepEqual(await resolveRuntimeChoiceDurable(s.built.config, ORG, "channel:legacy", fallback), override);
    assert.equal(await s.built.config.getBaseModelOwnDurable("channel:legacy"), null);
  } finally {
    await s.close();
  }
});

test("registered custom models are exposed and accepted through the existing scoped runtime", async () => {
  const s = await start();
  try {
    setCustomProviders([
      {
        id: "runtime-fixture",
        name: "Fixture",
        protocol: "openai",
        baseUrl: "https://unused.invalid/v1",
        models: [{ id: "custom-deepseek" }],
      },
    ]);
    const data = (await (await s.get("channel:C1")).json()) as any;
    assert.ok(data.modelsByHarness.pi.some((m: any) => m.id === "custom-deepseek"));
    assert.equal(
      (await s.put("channel:C1", { harnessId: "pi", modelId: "custom-deepseek", effortLevel: "low", fastMode: false }))
        .status,
      200,
    );
    assert.equal(((await (await s.get("channel:C1")).json()) as any).runtime.modelId, "custom-deepseek");
  } finally {
    setCustomProviders([]);
    await s.close();
  }
});

test("runtime validation still rejects unsupported tuples and credentials without changing saved state", async () => {
  const s = await start();
  try {
    assert.equal((await s.put("channel:C1", override)).status, 200);
    const saved = await s.built.config.getRuntimeSelectionDurable("channel:C1");
    for (const body of [
      { harnessId: "opencode", modelId: "claude-opus-5" },
      { harnessId: "codex", modelId: "claude-opus-5" },
      { harnessId: "pi", modelId: "not-a-model" },
      { harnessId: "pi", modelId: "gpt-5.5" },
      { ...override, effortLevel: "max" },
      { ...override, fastMode: "yes" },
    ]) {
      assert.equal((await s.put("channel:C1", body)).status, 400);
      assert.deepEqual(await s.built.config.getRuntimeSelectionDurable("channel:C1"), saved);
    }
    assert.equal(
      (await s.put("channel:C1", { harnessId: "pi", modelId: "claude-fable-5", fastMode: true })).status,
      200,
    );
    assert.equal((await s.built.config.getRuntimeSelectionDurable("channel:C1"))?.fastMode, false);
  } finally {
    await s.close();
  }
});

test("project ownership, membership, revoked grants and inactive admins cannot read or mutate admin runtime", async () => {
  const s = await start();
  try {
    const project = await s.built.projects.create({ name: "Owner is not admin", ownerId: "owner-alice" });
    await s.built.projects.addMember(project.id, "owner-alice", "member-bob");
    const scope = projectScopeId(project.id);
    await s.built.admin.revokeGrant({ id: "admin-bob", type: "internal" }, "admin-alice", ORG, "org_admin");
    for (const actor of ["owner-alice", "member-bob", "admin-alice"]) {
      assert.equal((await s.get(scope, actor)).status, 403);
      for (const body of [override, { inherit: true }]) assert.equal((await s.put(scope, body, actor)).status, 403);
    }
    await s.built.identity.deactivate("admin-bob");
    assert.equal((await s.get(scope, "admin-bob")).status, 403);
    assert.equal((await s.put(scope, override, "admin-bob")).status, 403);
    assert.equal(await s.built.config.getRuntimeSelectionDurable(scope), null);
    assert.equal((await s.built.config.getRuntimeSelectionDurable(ORG))?.modelId, fallback.modelId);
  } finally {
    await s.close();
  }
});

test("readback marks a retained unserviceable saved model unavailable and a recovery choice available", async () => {
  const s = await start();
  try {
    await s.built.config.setRuntimeSelectionLatest("channel:C1", { harnessId: "pi", modelId: "gpt-5.5" });
    const data = (await (await s.get("channel:C1")).json()) as any;
    assert.equal(data.runtime.modelId, "gpt-5.5");
    assert.equal(data.modelsByHarness.pi.find((m: any) => m.id === "gpt-5.5").available, false);
    assert.equal(data.baseModelOptions.find((m: any) => m.id === "gpt-5.5").available, false);
    assert.equal(data.modelsByHarness.pi.find((m: any) => m.id === "claude-opus-5").available, true);
    assert.equal((await s.put("channel:C1", { harnessId: "pi", modelId: "gpt-5.5" })).status, 400);
    assert.equal((await s.put("channel:C1", fallback)).status, 200);
    assert.equal((await s.put("channel:C1", { inherit: true })).status, 200);
  } finally {
    await s.close();
  }
});

test("retained harness options do not imply approval and retained incompatible models remain unavailable", async () => {
  const s = await start();
  try {
    await s.built.config.setRuntimeSelectionLatest("channel:C1", { harnessId: "codex", modelId: "claude-opus-5" });
    s.built.config.setApprovedHarnesses(["pi"]);
    await s.built.config.flushScope(ORG);
    const data = (await (await s.get("channel:C1")).json()) as any;
    assert.ok(data.harnessOptions.includes("codex"));
    assert.deepEqual(data.approvedHarnesses, ["pi"]);
    assert.equal(data.modelsByHarness.codex.find((m: any) => m.id === "claude-opus-5").available, false);
    assert.equal((await s.put("channel:C1", override)).status, 400);
    assert.equal((await s.put("channel:C1", { inherit: true })).status, 200);
  } finally {
    await s.close();
  }
});

test("scoped readback uses durable harness approval even when its org cache is stale", async () => {
  const s = await start();
  try {
    await s.built.config.setRuntimeSelectionLatest("channel:C1", { harnessId: "codex", modelId: "gpt-5.5" });
    s.built.config.setApprovedHarnesses(["pi"]);
    await s.built.config.flushScope(ORG);
    s.built.config.getApprovedHarnesses = () => ["codex"];
    const data = (await (await s.get("channel:C1")).json()) as any;
    assert.deepEqual(data.approvedHarnesses, ["pi"]);
    assert.ok(data.harnessOptions.includes("codex"));
    assert.equal((await s.put("channel:C1", override)).status, 400);
    assert.equal((await s.put("channel:C1", { inherit: true })).status, 200);
  } finally {
    await s.close();
  }
});
