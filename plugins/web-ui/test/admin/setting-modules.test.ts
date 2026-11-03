import assert from "node:assert/strict";
import test from "node:test";
import { SettingsState, load as loadSettings, states as settingsStates } from "../../src/admin/settings.ts";
import { CredentialState } from "../../src/admin/settings-credentials.ts";
import { GovernanceState, load, states } from "../../src/admin/governance-state.ts";

test("governance posture saves refresh only the saved card", () => {
  load({ securityPosture: "auto", sharingPosture: "isolated" }, "org:test");
  states.get("sharing-posture")!.change("sharing-posture", "open");
  load({ securityPosture: "strict", sharingPosture: "isolated" }, "org:test", "security-posture");
  assert.equal(states.get("sharing-posture")!.draft.posture, "open");
  assert.equal(states.get("sharing-posture")!.dirty, true);
});

test("the org ambient reply policy collects exactly the toggled value", () => {
  const state = new GovernanceState("org-ambient");
  state.load({ on: true });
  for (const on of [false, true]) {
    state.change("governance-org-ambient", on);
    assert.deepEqual(state.collect(), { on });
  }
});

test("default runtime controls save reasoning level and fast mode", () => {
  loadSettings(
    {
      baseModelOptions: [{ id: "a" }],
      baseModelDefault: "a",
      runtime: { modelId: "a", effortLevel: "high", fastMode: true },
      fastModeModelIds: ["a"],
    },
    "org:test",
    "runtime",
  );
  assert.deepEqual(settingsStates.get("runtime")!.collect(), {
    modelId: "a",
    effortLevel: "high",
    fastMode: true,
  });
});

test("governance disables egress controls when agent computers cannot enforce them", () => {
  load({ egress: {}, egressEnforcement: { active: false } }, "org:test");
  assert.equal(states.get("egress")!.disabled, true);
  load({ egress: {}, egressEnforcement: { active: true } }, "org:test");
  assert.equal(states.get("egress")!.disabled, false);
});

test("egress hides empty host editors", () => {
  const state = new GovernanceState("egress");
  state.load({ allowedHosts: [], deniedHosts: [] });
  assert.equal(state.allowEditor, false);
  assert.equal(state.denyEditor, false);
  state.load({ allowedHosts: ["example.com"], deniedHosts: [] });
  assert.equal(state.allowEditor, true);
  assert.equal(state.denyEditor, false);
});

test("egress validation follows programmatic reloads", () => {
  const state = new GovernanceState("egress");
  state.load({ allowedHosts: ["https://invalid"], deniedHosts: [] });
  assert.equal(state.warnings.length, 1);
  state.load({ allowedHosts: ["example.com"], deniedHosts: [] });
  assert.deepEqual(state.warnings, []);
});

test("credential edits carry the loaded revision and preserve injection settings", () => {
  const state = new CredentialState();
  state.begin({ slug: "test", name: "Test", host: "example.com", updatedAt: 42 });
  assert.equal(state.collect().expectedUpdatedAt, 42);
  const fixed = new CredentialState();
  fixed.begin({
    slug: "versioned",
    name: "Versioned",
    host: "api.example.com",
    updatedAt: 7,
    injection: { header: "x-api-key", scheme: "Token", actor: true, headers: { "x-api-version": "2025-11-01" } },
  });
  fixed.draft.secret = "rotated";
  fixed.draft.host = "api2.example.com";
  assert.deepEqual(fixed.collect().injection, {
    actor: true,
    headers: { "x-api-version": "2025-11-01" },
    header: "x-api-key",
    scheme: "Token",
  });
});

test("enabled models add and remove through explicit actions", () => {
  const state = new SettingsState("webui-models");
  state.draft = { ids: [] };
  state.baseline = JSON.stringify(state.draft);
  state.selected = "model-a";
  state.add();
  assert.deepEqual(state.collect(), { ids: ["model-a"] });
  assert.equal(state.dirty, true);
  state.remove("model-a");
  assert.equal(state.dirty, false);
});
