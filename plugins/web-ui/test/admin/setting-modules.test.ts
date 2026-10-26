import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./fixture.ts";
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
      runtime: { harnessId: "pi", modelId: "a", effortLevel: "high", fastMode: true },
      fastModeModelIds: ["a"],
    },
    "org:test",
    "runtime",
  );
  assert.deepEqual(settingsStates.get("runtime")!.collect(), {
    harnessId: "pi",
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

test("egress validation follows programmatic reloads and successful saves", () => {
  const state = new GovernanceState("egress");
  state.load({ allowedHosts: ["https://invalid"], deniedHosts: [] });
  assert.equal(state.warnings.length, 1);
  state.load({ allowedHosts: ["example.com"], deniedHosts: [] });
  assert.deepEqual(state.warnings, []);
  state.change("egress-deny", "example.com");
  assert.match(state.warnings[0], /both lists/);
});

test("command policy collects its mode and rules", () => {
  const state = new GovernanceState("command-policy");
  state.load({ mode: "allowlist", rules: [{ pattern: "^safe$", decision: "allow" }] });
  assert.deepEqual(state.collect(), { mode: "allowlist", rules: [{ pattern: "^safe$", decision: "allow" }] });
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

test("SOUL saves carry the expected version", () => {
  const state = new SettingsState("soul");
  state.draft = { content: "test", expectedVersion: 4 };
  assert.equal(state.collect().expectedVersion, 4);
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

const loadData = {
  autoFlagger: null,
  autoFlaggerDefault: { harnessId: "pi", modelId: "model-a", rubric: "Default rubric" },
  harnessOptions: ["pi", "claude"],
  modelsByHarness: {
    pi: [
      { id: "model-a", name: "A" },
      { id: "model-b", name: "B" },
    ],
    claude: [{ id: "model-c", name: "C" }],
  },
};

test("loading defaults replaces a previous model and harness selection", () => {
  load(loadData, "org:example");
  const state = states.get("auto-flagger")!;
  state.change("auto-flagger-model", "model-b");
  load(loadData, "org:example");
  assert.equal(state.draft.modelId, "model-a");
  state.change("auto-flagger-harness", "claude");
  assert.equal(state.draft.modelId, "model-c");
});

test("unavailable configured flagger stays selectable", () => {
  load({ ...loadData, autoFlagger: { harnessId: "codex", modelId: "saved-model", rubric: "Saved" } }, "org:example");
  const state = states.get("auto-flagger")!;
  assert.equal(state.draft.modelId, "saved-model");
  assert.ok(state.models.some((model) => model.id === "saved-model"));
});

test("flagger is visible only for org payloads that support it", () => {
  load(loadData, "personal:example");
  assert.equal(states.get("auto-flagger")!.available, false);
  load({}, "org:example");
  assert.equal(states.get("auto-flagger")!.available, false);
});

test("credential usage distinguishes loading, failure, and confirmed zero", () => {
  const f = litFixture();
  try {
    f.root.innerHTML = '<template data-settings-card="card-service-credentials"></template>';
    f.ui.settings.mountCards();
    for (const [usage, message] of [
      [{}, "Loading usage…"],
      [{ usageUnavailable: true }, "Usage unavailable"],
      [{ usageCount: 0 }, "0 successful uses in retained broker history"],
    ] as const) {
      f.ui.settings.loadCredentials([{ slug: "test", host: "example.com", ...usage }], [], [], [], "org:test");
      assert.ok(f.document.querySelector("#sc-list")!.textContent!.includes(message));
    }
  } finally {
    f.dom.window.close();
  }
});
