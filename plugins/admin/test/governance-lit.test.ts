import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildGovernanceUI } from "../src/governance-bundle.ts";
import { GovernanceState } from "../ui/governance-state.ts";
const bundle = buildGovernanceUI();
function setup() {
  const dom = new JSDOM(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), {
    runScripts: "outside-only",
  });
  dom.window.structuredClone = structuredClone;
  dom.window.eval(bundle + ";window.governanceUI = governanceUI; governanceUI.mountCards();");
  return dom;
}
test("Lit mounts Governance without wrappers or duplicate ids", () => {
  const dom = setup();
  try {
    for (const id of [
      "security-posture",
      "auto-flagger",
      "sharing-posture",
      "command-policy",
      "egress",
      "ambient-policy",
    ]) {
      const card = dom.window.document.getElementById(`card-${id}`)!;
      assert.equal(card.tagName, "SECTION");
      assert.equal(card.parentElement?.className, "governance-content");
      assert.ok(card.querySelector(`[data-save="${id}"]`));
    }
    const ids = [...dom.window.document.querySelectorAll("[id]")].map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    dom.window.close();
  }
});
test("editing and reverting a posture drives radio, dirty state and save button", () => {
  const dom = setup();
  try {
    dom.window.eval('governanceUI.load({securityPosture:"auto"},"org:test")');
    const doc = dom.window.document;
    const button = doc.querySelector<HTMLButtonElement>('[data-save="security-posture"]')!;
    const input = doc.querySelector<HTMLInputElement>('[name="security-posture-choice"][value="strict"]')!;
    input.click();
    assert.equal(button.disabled, false);
    assert.equal(doc.getElementById("st-security-posture")!.textContent, "Unsaved changes");
    assert.equal(dom.window.eval('governanceUI.collect("security-posture").posture'), "strict");
    doc.querySelector<HTMLInputElement>('[name="security-posture-choice"][value="auto"]')!.click();
    assert.equal(button.disabled, true);
    assert.equal(doc.getElementById("st-security-posture")!.textContent, "");
  } finally {
    dom.window.close();
  }
});
test("keyed Lit rules preserve focus, escape values, validate and remove from state", () => {
  const dom = setup();
  try {
    dom.window.eval('governanceUI.load({commandPolicy:{mode:"denylist",rules:[]}},"org:test")');
    const doc = dom.window.document;
    doc.getElementById("add-rule")!.click();
    const input = doc.querySelector<HTMLInputElement>(".policy-pattern")!;
    input.value = "<img src=x onerror=alert(1)>";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(doc.activeElement, input);
    assert.equal(doc.querySelectorAll("#rules img, #rules script").length, 0);
    assert.equal(dom.window.eval('governanceUI.collect("command-policy").rules[0].pattern'), input.value);
    input.value = "[";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.throws(() => dom.window.eval('governanceUI.collect("command-policy")'), /regular expression/);
    doc.querySelector<HTMLButtonElement>('[aria-label="Remove command policy rule"]')!.click();
    assert.equal(doc.querySelectorAll(".policy-rule").length, 0);
    assert.equal(doc.getElementById("rules-empty")!.classList.contains("hidden"), false);
  } finally {
    dom.window.close();
  }
});
test("bot ledger changes derive rollup enablement and payload from state", () => {
  const dom = setup();
  try {
    dom.window.eval('governanceUI.load({ambientPolicy:{bots:{Build:{mode:"rollup",rollupHours:12}}}},"channel:test")');
    const doc = dom.window.document;
    const hours = doc.querySelector<HTMLInputElement>('#ambient-bots input[type="number"]')!;
    assert.equal(hours.disabled, false);
    const select = doc.querySelector<HTMLSelectElement>("#ambient-bots select")!;
    select.value = "ignore";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(hours.disabled, true);
    assert.equal(dom.window.eval('governanceUI.collect("ambient-policy").bots.Build.mode'), "ignore");
    doc.querySelector<HTMLButtonElement>('[aria-label="Remove bot ledger entry"]')!.click();
    assert.equal(doc.querySelectorAll("#ambient-bots tr").length, 0);
  } finally {
    dom.window.close();
  }
});
test("saving an older submitted draft preserves edits made during the request", () => {
  const state = new GovernanceState("security-posture");
  state.load({ posture: "auto" });
  state.change("security-posture", "strict");
  const submitted = state.collect();
  state.saving = true;
  state.change("security-posture", "auto");
  state.commit(submitted);
  assert.equal(state.draft.posture, "auto");
  assert.equal(state.dirty, true);
  assert.equal(state.message, "Unsaved changes");
});
test("policy validation detects duplicate bots and overlapping hosts", () => {
  const bots = new GovernanceState("ambient-policy");
  bots.load({ bots: { Build: { mode: "ignore" } } });
  bots.bots.push({ id: -1, name: "build", mode: "ignore", hours: "" });
  assert.throws(() => bots.collect(), /Duplicate bot/);
  const egress = new GovernanceState("egress");
  egress.load({ allowedHosts: ["example.com"], deniedHosts: ["example.com"] });
  assert.throws(() => egress.collect(), /both lists/);
});
test("Governance bundle stays inline-script safe without external runtime imports", () => {
  assert.doesNotMatch(bundle, /<\/script/i);
  assert.doesNotMatch(bundle, /\bimport\s*\(/);
});
