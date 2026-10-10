import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { DEFAULT_AGENT_MODEL_ID } from "../src/model/pi-models.ts";
import { resolveIndividualAuthRouting } from "../src/core/individual-auth-routing.ts";
import type { UserModelCredential } from "../src/model/user-model-credential-store.ts";
import { settle } from "./support/settle.ts";
import { testConfig } from "./support/test-config.ts";

const ORG_MODEL = "claude-opus-5-5";

const claudeOauth = (): UserModelCredential => ({ provider: "anthropic", kind: "oauth", oauth: {}, updatedAt: 0 });

test("anthropic OAuth with no requested model falls back to the hardcoded default agent model", () => {
  assert.equal(DEFAULT_AGENT_MODEL_ID, "claude-opus-5");
  const routing = resolveIndividualAuthRouting(claudeOauth(), null, undefined, "claude");
  assert.equal(routing?.kind, "oauth");
  assert.equal(routing?.harness, "claude");
  assert.equal(routing?.model, DEFAULT_AGENT_MODEL_ID);
});

test("a requested anthropic model is served verbatim on a personal claude-oauth turn", () => {
  const routing = resolveIndividualAuthRouting(claudeOauth(), null, ORG_MODEL, "claude");
  assert.equal(routing?.kind, "oauth");
  assert.equal(routing?.harness, "claude");
  assert.equal(routing?.model, ORG_MODEL);
});

for (const provider of [undefined, "anthropic"] as const) {
  test(`a Slack DM on a personal Claude account (${provider ?? "provider-less"}) runs the org-configured model`, async (t) => {
    const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "slack-individual-model-")) }));
    t.after(async () => {
      built.scheduler.stop();
      built.deploymentLayerRefresh.stop();
      await built.runtime.stop();
    });
    built.runtime.startBackground();
    await built.userModelCredentials.setOAuth("U1", "anthropic", { accessToken: "acc-token" });
    await built.config.setPersonalModelAuth("U1", true, provider);
    built.config.setRuntimeSelection("org:default-org", { harnessId: "claude", modelId: ORG_MODEL });
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    };
    try {
      const submitted = await built.app.turn({
        surface: "slack",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: `slack-individual-model-${provider ?? "personal"}` },
        text: "hello",
        liveActor: true,
        async: true,
      });
      assert.equal(submitted.status, "queued");
      let log = "";
      await settle(async () => {
        log = lines.find((l) => l.startsWith("[individual-auth] user=U1")) ?? "";
        return log.includes("model=");
      });
      assert.match(log, /model=claude-opus-5-5/);
      assert.match(log, /auth=claude-oauth/);
      assert.match(log, /harness=claude/);
    } finally {
      console.log = original;
    }
  });
}
