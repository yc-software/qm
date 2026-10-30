import assert from "node:assert/strict";
import test from "node:test";
import { mountAdmin, type Reply, type Route } from "./fixture.ts";

const governance = {
  securityPosture: "auto",
  sharingPosture: "isolated",
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
    "/scopes/personal:other": governance,
    "/users": { users: [] },
    ...routes,
  });
  await admin.settle();
  return admin;
}

const text = (admin: { document: Document }, id: string) => admin.document.getElementById(id)!.textContent!.trim();

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
