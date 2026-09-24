import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import type { userRuntimeConfigBody } from "../src/api/runtime-config.ts";
import { resolveModel } from "../src/model/pi-models.ts";

type Snapshot = Awaited<ReturnType<typeof userRuntimeConfigBody>>;

async function setup() {
  const built = buildApp(testConfig());
  built.config.setApprovedHarnesses(["pi", "claude", "codex"]);
  await built.config.flushScope("org:default-org");
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    userModelCredentials: built.userModelCredentials,
    harnessId: "pi",
    providerKeys: { anthropic: false, openai: false, openrouter: false },
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const get = async (user = "U1", scope = `personal:${user}`) => {
    const response = await fetch(`${base}/v1/runtime-config?principalId=${user}&scopeId=${encodeURIComponent(scope)}`);
    assert.equal(response.status, 200);
    return response.json() as Promise<Snapshot>;
  };
  const put = (choice: object) =>
    fetch(`${base}/v1/runtime-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1", scopeId: "personal:U1", ...choice }),
    });
  return { built, get, put, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("personal API-key picker works without company keys and saves model, effort and Fast", async () => {
  const s = await setup();
  try {
    await s.built.userModelCredentials.setApiKey("U1", "openai", "synthetic-openai");
    await s.built.config.setPersonalModelAuth("U1", true, "openai");
    const before = await s.get();
    assert.ok(before.modelsByHarness.pi!.includes("gpt-5.6-terra"));
    assert.ok(before.modelsByHarness.pi!.every((id: string) => resolveModel(id)?.provider === "openai"));
    assert.deepEqual(before.modelsByHarness.claude, []);
    assert.deepEqual(before.modelsByHarness.codex, []);
    assert.ok(before.modelsByHarness.pi!.includes(before.effective.modelId));
    assert.equal(before.unavailableReason, undefined);
    assert.doesNotMatch(JSON.stringify(before), /synthetic-openai/);
    const choice = { harnessId: "pi", modelId: "gpt-5.6-terra", effortLevel: "high", fastMode: true };
    const saved = await s.put(choice);
    assert.equal(saved.status, 200);
    assert.deepEqual(((await saved.json()) as Snapshot).effective, choice);
    assert.deepEqual((await s.get()).effective, choice);
    assert.equal((await s.put({ ...choice, modelId: "claude-sonnet-5" })).status, 400);
    await s.built.userModelCredentials.delete("U1", "openai");
    assert.deepEqual((await s.get()).modelsByHarness.pi, []);
    assert.equal((await s.put(choice)).status, 400);
  } finally {
    await s.close();
  }
});

for (const provider of ["anthropic", "openai"] as const) {
  test(`personal ${provider} OAuth picker advertises only compatible runtimes`, async () => {
    const s = await setup();
    try {
      await s.built.userModelCredentials.setOAuth("U1", provider, {
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        expiresAt: Date.now() + 3_600_000,
      });
      await s.built.config.setPersonalModelAuth("U1", true, provider);
      const config = await s.get();
      if (provider === "anthropic") {
        assert.deepEqual(config.modelsByHarness.pi, []);
        assert.ok(config.modelsByHarness.claude!.includes("claude-sonnet-5"));
        assert.deepEqual(config.modelsByHarness.codex, []);
      } else {
        assert.ok(config.modelsByHarness.pi!.includes("codex/gpt-5.6-sol"));
        assert.ok(!config.modelsByHarness.pi!.includes("gpt-5.6-sol"));
        assert.ok(config.modelsByHarness.codex!.includes("gpt-5.6-sol"));
        assert.deepEqual(config.modelsByHarness.claude, []);
      }
      assert.ok(config.modelsByHarness[config.effective.harnessId]!.includes(config.effective.modelId));
    } finally {
      await s.close();
    }
  });
}

test("personal picker keeps org restrictions and shared-scope caller isolation", async () => {
  const s = await setup();
  try {
    await s.built.userModelCredentials.setApiKey("U1", "openai", "synthetic-openai");
    await s.built.userModelCredentials.setApiKey("U2", "anthropic", "synthetic-anthropic");
    await s.built.config.setPersonalModelAuth("U1", true, "openai");
    await s.built.config.setPersonalModelAuth("U2", true, "anthropic");
    await s.built.directory.replaceGroups([
      { groupId: "room", principalId: "U1" },
      { groupId: "room", principalId: "U2" },
    ]);
    assert.ok((await s.get("U1", "group:room")).modelsByHarness.pi!.includes("gpt-5.6-terra"));
    assert.ok(!(await s.get("U2", "group:room")).modelsByHarness.pi!.includes("gpt-5.6-terra"));
    await s.built.config.setRuntimeSelectionLatest("personal:U1", { harnessId: "pi", modelId: "gpt-5.6-terra" });
    s.built.config.setWebuiModels("org:default-org", ["gpt-5.6-sol"]);
    await s.built.config.flushScope("org:default-org");
    assert.ok(!(await s.get()).modelsByHarness.pi!.includes("gpt-5.6-terra"));
    assert.equal((await s.put({ harnessId: "pi", modelId: "gpt-5.6-terra" })).status, 400);
    const refused = await s.built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "web:U1:excluded-saved-model" },
      text: "hello",
      liveActor: true,
      async: true,
      harness: "pi",
      model: "gpt-5.6-terra",
    });
    assert.equal(refused.status, "refused");
    s.built.config.setWebuiModels("org:default-org", []);
    await s.built.config.flushScope("org:default-org");
    assert.ok((await s.get()).modelsByHarness.pi!.includes("gpt-5.6-terra"));
  } finally {
    await s.close();
  }
});
