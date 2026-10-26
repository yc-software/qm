import assert from "node:assert/strict";
import test from "node:test";
import { mountAdmin, type Reply, type Route } from "./fixture.ts";

const governance = {
  securityPosture: "auto",
  sharingPosture: "isolated",
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

async function governancePage(routes: Record<string, Reply | Route> = {}, url = "/settings/governance") {
  const admin = await mountAdmin(url, {
    "/scopes": { scopes: [{ scopeId: "org:acme" }, { scopeId: "personal:other" }], environments: [] },
    "/scopes/org:acme": governance,
    "/scopes/personal:other": { ...governance, autoFlaggerDefault: undefined },
    "/users": { users: [] },
    ...routes,
  });
  await admin.settle();
  return admin;
}

const text = (admin: { document: Document }, id: string) => admin.document.getElementById(id)!.textContent!.trim();
const type = (admin: { window: any; document: Document }, id: string, value: string) => {
  const field = admin.document.getElementById(id) as HTMLInputElement;
  field.value = value;
  field.dispatchEvent(new admin.window.Event("input", { bubbles: true }));
  field.dispatchEvent(new admin.window.Event("change", { bubbles: true }));
};

test("governance shows its policy cards with working navigation actions", async () => {
  const admin = await governancePage();
  const page = admin.document.getElementById("view-governance")!.textContent!;
  for (const heading of [
    "Security posture",
    "Sharing posture",
    "Command policy",
    "Ambient reply policy",
    "Egress policy",
    "External Slack audience",
    "Custom providers",
    "Enabled models",
    "Organization SOUL",
    "Feature flags",
    "Shared service credentials",
    "Personal keychains",
    "Slack",
  ])
    assert.ok(page.includes(heading), heading);
  admin.document.querySelector<HTMLButtonElement>('[data-viewlink="users"]')!.click();
  await admin.settle();
  assert.equal(admin.location(), "/settings/users");
  assert.equal(admin.views.at(-1), "users");
  admin.close();
});

test("Open sharing explains the benefit and the privacy risk in plain language", async () => {
  const admin = await governancePage();
  const card = text(admin, "card-sharing-posture").replace(/\s+/g, " ");
  assert.match(card, /QM can use your saved memories, files, and skills across conversations when you ask it for help/);
  assert.match(card, /In a group conversation, this could risk revealing private information to others/);
  admin.close();
});

test("testing the auto flagger replays the unsaved draft without saving it", async () => {
  const tests: any[] = [];
  const admin = await governancePage({
    "POST /scopes/org:acme/auto-flagger/test": ({ body }: any) => {
      tests.push(body);
      return { sampled: 2, scored: 2, flagged: 1, flagRate: 0.5, durationMs: 100 };
    },
  });
  type(admin, "auto-flagger-rubric", "Unsaved draft — café");
  type(admin, "auto-flagger-window", "25");
  const compare = admin.document.getElementById("auto-flagger-compare") as HTMLInputElement;
  if (!compare.checked) compare.click();
  const button = admin.document.getElementById("auto-flagger-test") as HTMLButtonElement;
  button.click();
  await admin.settle();
  assert.deepEqual(tests, [
    { window: 25, compare: true, harnessId: "pi", modelId: "model-a", rubric: "Unsaved draft — café" },
  ]);
  assert.match(text(admin, "st-auto-flagger-test"), /Flagged 1 of 2 scored \(50.0%\)/);
  assert.equal(button.disabled, false);
  assert.equal(admin.requests.filter((r) => r.method === "PUT").length, 0);
  type(admin, "auto-flagger-window", "0");
  button.click();
  await admin.settle();
  assert.equal(tests.length, 1);
  assert.equal(admin.document.getElementById("auto-flagger-test-result")!.hidden, false);
  assert.match(text(admin, "st-auto-flagger-test"), /between 1 and 500/);
  admin.close();
});

test("auto flagger replay summaries describe empty, partial, errored and comparison runs", async () => {
  const replies = [
    { sampled: 0 },
    {
      sampled: 4,
      scored: 2,
      flagged: 1,
      flagRate: 0.5,
      errors: 1,
      unscreened: 1,
      partial: true,
      durationMs: 100,
      baseline: { flagRate: 0, changed: 1 },
    },
  ];
  const admin = await governancePage({ "POST /scopes/org:acme/auto-flagger/test": () => replies.shift() });
  const button = admin.document.getElementById("auto-flagger-test") as HTMLButtonElement;
  button.click();
  await admin.settle();
  assert.match(text(admin, "st-auto-flagger-test"), /No past screenings/);
  button.click();
  await admin.settle();
  const summary = text(admin, "st-auto-flagger-test");
  assert.match(summary, /current rubric flags 0.0%.*1 verdict changed/);
  assert.match(summary, /1 sample came back unscreened/);
  assert.match(summary, /1 sample errored/);
  assert.match(summary, /partial result/);
  admin.close();
});

test("resetting the auto flagger restores the default and ignores a reply for a scope left behind", async () => {
  const resets: any[] = [];
  let release!: () => void;
  const admin = await governancePage({
    "PUT /scopes/org:acme/auto-flagger": ({ body }: any) => {
      resets.push(body);
      if (resets.length === 1) return { ok: true };
      return new Promise((resolve) => (release = () => resolve({ ok: true })));
    },
  });
  admin.document.getElementById("auto-flagger-reset")!.click();
  await admin.settle();
  assert.deepEqual(resets, [{ reset: true }]);
  assert.equal(text(admin, "st-auto-flagger"), "Default restored");
  admin.document.getElementById("auto-flagger-reset")!.click();
  await admin.settle();
  admin.window.history.pushState({}, "", "/settings/governance?scope=personal%3Aother");
  admin.window.dispatchEvent(new admin.window.PopStateEvent("popstate"));
  await admin.settle();
  const reads = admin.requests.filter((r) => r.path === "/scopes/org%3Aacme").length;
  release();
  await admin.settle();
  assert.equal(admin.requests.filter((r) => r.path === "/scopes/org%3Aacme").length, reads);
  admin.close();
});

test("leaving governance with a draft asks before discarding it", async () => {
  const admin = await governancePage();
  admin.document.querySelector<HTMLInputElement>('[name="security-posture-choice"][value="strict"]')!.click();
  admin.controller.show("users");
  await admin.settle();
  const dialog = admin.document.getElementById("governance-review") as HTMLDialogElement;
  assert.equal(dialog.open, true);
  assert.equal(text(admin, "governance-review-title"), "Discard unsaved governance changes?");
  assert.match(text(admin, "governance-review-facts"), /Organization · acme/);
  admin.document.getElementById("governance-review-cancel")!.click();
  await admin.settle();
  assert.equal(dialog.open, false);
  assert.equal(admin.location(), "/settings/governance?scope=org%3Aacme");
  admin.controller.show("users");
  await admin.settle();
  admin.document.getElementById("governance-review-confirm")!.click();
  await admin.settle();
  assert.equal(admin.location(), "/settings/users");
  admin.close();
});

test("a scope attached to a named environment links to it", async () => {
  const admin = await governancePage({
    "/scopes/org:acme": {
      ...governance,
      environmentAttachment: { environmentId: "personal:other", environmentName: "Staging" },
    },
  });
  const notice = admin.document.getElementById("environment-notice")!;
  assert.equal(notice.classList.contains("hidden"), false);
  assert.equal(text(admin, "environment-notice-title"), "Uses named environment Staging");
  admin.document.getElementById("environment-notice-open")!.click();
  await admin.settle();
  assert.equal(admin.location(), "/settings/governance?scope=personal%3Aother");
  admin.close();
});
