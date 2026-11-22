import assert from "node:assert/strict";
import test from "node:test";
import { mountPage } from "./fixture.ts";

test("Teams settings show this deployment's endpoint, connect a bot and offer its app package", async () => {
  const saves: unknown[] = [];
  const endpoint = "https://qm.example/v1/surfaces/teams/activities";
  const admin = await mountPage("/settings/teams-settings", {
    "/teams": { configured: false, endpoint, signInRedirect: "https://qm.example/auth/callback" },
    "PUT /teams": ({ body }: { body: unknown }) => (
      saves.push(body),
      { configured: true, tenantId: "t-1", appId: "bot-1", endpoint }
    ),
  });
  await admin.settle();
  const doc = admin.document;
  assert.equal(doc.getElementById("teams-state")!.textContent, "Not connected");
  assert.equal(doc.getElementById("teams-endpoint")!.textContent, endpoint);
  assert.equal(doc.getElementById("teams-download")!.getAttribute("aria-disabled"), "true");
  for (const [id, value] of [
    ["teams-tenant-id", " t-1 "],
    ["teams-app-id", "bot-1"],
    ["teams-app-secret", "s3cret"],
  ]) {
    const input = doc.getElementById(id) as HTMLInputElement;
    input.value = value!;
    input.dispatchEvent(new admin.window.Event("input", { bubbles: true }));
  }
  (doc.getElementById("teams-save") as HTMLButtonElement).click();
  await admin.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(saves)), [{ tenantId: "t-1", appId: "bot-1", appSecret: "s3cret" }]);
  assert.equal(doc.getElementById("teams-state")!.textContent, "Connected");
  assert.ok(doc.getElementById("teams-download")!.getAttribute("href")!.endsWith("/teams/app-package"));
  admin.close();
});
