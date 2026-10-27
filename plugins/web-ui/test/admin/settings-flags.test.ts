import assert from "node:assert/strict";
import test from "node:test";
import { settingsDom } from "../support/admin-settings.ts";

test("feature flag entries use a compact row that cannot inherit the card grid", async () => {
  const dom = settingsDom();
  try {
    dom.window.eval(`settingsUI.configureFlags({
      loadChoices: async () => [],
      buildSelector: () => document.createElement("button"),
      save: async () => ({ ok: true }),
    })`);
    await dom.window.eval(`settingsUI.loadFlags(
      { featureFlags: [{ featureName: "app_annotations", enabledScopes: ["personal:person-with-a-long-name@example.com"] }] },
      "org:test",
    )`);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    const list = dom.window.document.getElementById("feature-flag-list")!;
    assert.equal(list.querySelectorAll(".feature-flag-row").length, 1);
    assert.equal(list.querySelector(".setting-row"), null);
    const editor = dom.window.document.querySelector("#card-feature-flags .feature-flag-editor")!;
    assert.ok(editor);
    assert.equal(editor.classList.contains("editor-grid"), false);
  } finally {
    dom.window.close();
  }
});

test("feature flag picker offers every server feature and limits personal-only features to people", async () => {
  const dom = settingsDom();
  try {
    dom.window.eval(`settingsUI.configureFlags({
      loadChoices: async () => [{ scopeId: "personal:ada" }, { scopeId: "channel:C1" }],
      buildSelector: (choices) => Object.assign(document.createElement("ul"), { id: "offered", textContent: choices.map((c) => c.scopeId).join() }),
      save: async () => ({ ok: true }),
    })`);
    await dom.window.eval(`settingsUI.loadFlags(
      { featureFlags: [
        { featureName: "app_annotations", label: "App annotations", personalOnly: true, hint: "People only.", enabledScopes: [] },
        { featureName: "ui_canvas", label: "UI canvas", personalOnly: true, enabledScopes: [] },
        { featureName: "team_scopes", label: "Team scopes", enabledScopes: [] },
      ] },
      "org:test",
    )`);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    const doc = dom.window.document;
    const select = doc.getElementById("feature-flag-name") as HTMLSelectElement;
    assert.deepEqual(
      [...select.options].map((option) => option.textContent),
      ["App annotations", "UI canvas", "Team scopes"],
    );
    assert.equal(select.value, "app_annotations");
    assert.equal(doc.getElementById("offered")!.textContent, "personal:ada");
    assert.equal(doc.querySelector("#card-feature-flags .hint:not(#feature-flag-list)")!.textContent, "People only.");
    select.value = "team_scopes";
    select.dispatchEvent(new dom.window.Event("change"));
    assert.equal(doc.getElementById("offered")!.textContent, "personal:ada,channel:C1");
  } finally {
    dom.window.close();
  }
});
