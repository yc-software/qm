import assert from "node:assert/strict";
import test from "node:test";
import { mountPage, type Reply, type Route } from "./fixture.ts";
import { GovernanceState } from "../../src/admin/governance-state.ts";

const governance = {
  securityPosture: "auto",
  sharingPosture: "isolated",
  orgAmbient: true,
  commandPolicy: { mode: "denylist", rules: [{ pattern: "^rm", decision: "deny" }] },
  egress: { allowedHosts: [], deniedHosts: [] },
  egressEnforcement: { active: true, fidelity: "full", backend: "proxy" },
};

async function governancePage(routes: Record<string, Reply | Route> = {}, url = "/settings/governance") {
  const page = await mountPage(url, {
    "/scopes": { scopes: [{ scopeId: "channel:C1", label: "#ops" }] },
    "GET /scopes/org:acme": governance,
    ...routes,
  });
  await page.settle();
  return page;
}

const input = (page: { window: any }, el: HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new page.window.Event("input", { bubbles: true }));
};

test("governance renders its policy cards in order for the org scope", async () => {
  const page = await governancePage();
  const ids = [...page.document.querySelectorAll("#view-governance section.card")].map((card) => card.id);
  assert.deepEqual(ids, [
    "card-security-posture",
    "card-sharing-posture",
    "card-governance-org-ambient",
    "card-command-policy",
    "card-egress",
  ]);
  assert.ok(page.document.getElementById("card-security-posture")!.classList.contains("flat-first"));
  assert.ok(page.document.getElementById("card-egress")!.classList.contains("flat-last"));
  assert.equal(
    page.document.querySelector<HTMLAnchorElement>("#card-egress .viewlink")!.getAttribute("href"),
    "/settings/egress",
  );
  const ids2 = [...page.document.querySelectorAll("[id]")].map((node) => node.id);
  assert.equal(new Set(ids2).size, ids2.length);
  page.close();
});

test("a posture change is reviewed, saved with the same payload and refreshed", async () => {
  let reads = 0;
  const page = await governancePage({
    "GET /scopes/org:acme": () => (++reads > 1 ? { ...governance, securityPosture: "strict" } : governance),
    "PUT /scopes/org:acme/security-posture": { ok: true },
  });
  const doc = page.document;
  doc.querySelector<HTMLInputElement>('[name="security-posture-choice"][value="strict"]')!.click();
  assert.equal(doc.getElementById("st-security-posture")!.textContent, "Unsaved changes");
  doc.querySelector<HTMLButtonElement>('[data-save="security-posture"]')!.click();
  await page.settle();
  const dialog = doc.getElementById("governance-review") as HTMLDialogElement;
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent!, /Organization · acme/);
  doc.getElementById("governance-review-confirm")!.click();
  await page.settle();
  const put = page.requests.find((r) => r.method === "PUT")!;
  assert.equal(put.path, "/scopes/org%3Aacme/security-posture");
  assert.deepEqual(put.body, { posture: "strict" });
  assert.equal(reads, 2);
  assert.equal(doc.getElementById("st-security-posture")!.textContent, "Saved");
  assert.equal(doc.querySelector<HTMLButtonElement>('[data-save="security-posture"]')!.disabled, true);
  page.close();
});

test("command policy rules escape input, validate, save and drive the simulator", async () => {
  const page = await governancePage({
    "PUT /scopes/org:acme/command-policy": { ok: true },
    "PUT /scopes/org:acme/command-policy-simulate": {
      decision: "deny",
      ruleSource: "scope",
      ruleIndex: 0,
      matched: "rm -rf",
    },
  });
  const doc = page.document;
  doc.getElementById("add-rule")!.click();
  const pattern = doc.querySelector<HTMLInputElement>(".policy-pattern")!;
  input(page, pattern, "<img src=x onerror=alert(1)>");
  assert.equal(doc.querySelectorAll("#rules img").length, 0);
  input(page, pattern, "[");
  assert.equal(pattern.getAttribute("aria-invalid"), "true");
  doc.querySelector<HTMLButtonElement>('[data-save="command-policy"]')!.click();
  await page.settle();
  assert.match(doc.getElementById("st-policy")!.textContent!, /regular expression/);
  input(page, pattern, "^git push");
  doc.querySelector<HTMLButtonElement>('[data-save="command-policy"]')!.click();
  await page.settle();
  const save = page.requests.find((r) => r.path === "/scopes/org%3Aacme/command-policy")!;
  assert.deepEqual(save.body, {
    mode: "denylist",
    rules: [
      { pattern: "^git push", decision: "deny" },
      { pattern: "^rm", decision: "deny" },
    ],
  });
  doc.getElementById("policy-test-open")!.click();
  input(page, doc.getElementById("policy-sample") as HTMLInputElement, "rm -rf /");
  doc.getElementById("policy-simulate")!.click();
  await page.settle();
  const simulate = page.requests.find((r) => r.path.endsWith("command-policy-simulate"))!;
  assert.equal(simulate.body.command, "rm -rf /");
  assert.equal(simulate.body.policy.rules.length, 2);
  assert.equal(doc.getElementById("policy-result")!.textContent, "This scope’s rule 1 matches “rm -rf” → Deny");
  page.close();
});

test("a reply for a scope left behind is ignored", async () => {
  let release: (value: Reply) => void = () => {};
  const page = await governancePage({
    "GET /scopes/channel:C1": () => new Promise<Reply>((resolve) => (release = resolve)),
    "GET /scopes/channel:C2": { ...governance, securityPosture: "strict", orgAmbient: undefined },
  });
  page.window.history.pushState(null, "", "/settings/governance?scope=channel%3AC1");
  void page.mount();
  await page.settle();
  page.window.history.pushState(null, "", "/settings/governance?scope=channel%3AC2");
  await page.mount();
  await page.settle();
  release({ ...governance, securityPosture: "dangerous" });
  await page.settle();
  const strict = page.document.querySelector<HTMLInputElement>('[name="security-posture-choice"][value="strict"]')!;
  assert.equal(strict.checked, true);
  assert.equal(page.document.querySelector(".pane-title")!.textContent, "#C2");
  page.close();
});

test("a scope follows the organization's sharing after review and links its environment", async () => {
  const page = await governancePage(
    {
      "GET /scopes/channel:C1": {
        ...governance,
        sharingPostureOverride: "open",
        environmentAttachment: { environmentId: "personal:env", environmentName: "Staging" },
      },
      "PUT /scopes/channel:C1/sharing-posture": { ok: true },
    },
    "/settings/governance?scope=channel%3AC1",
  );
  const doc = page.document;
  assert.equal(doc.querySelector(".pane-title")!.textContent, "#ops");
  assert.match(doc.getElementById("environment-notice")!.textContent!, /Uses named environment Staging/);
  assert.equal(
    doc.querySelector<HTMLAnchorElement>("#environment-notice a")!.getAttribute("href"),
    "/settings/governance?scope=personal%3Aenv",
  );
  doc.getElementById("sharing-posture-inherit")!.click();
  await page.settle();
  doc.getElementById("governance-review-confirm")!.click();
  await page.settle();
  const put = page.requests.find((r) => r.method === "PUT")!;
  assert.deepEqual(put.body, { inherit: true });
  page.close();
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
