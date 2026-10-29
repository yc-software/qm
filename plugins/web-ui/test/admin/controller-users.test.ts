import assert from "node:assert/strict";
import test from "node:test";
import { mountAdmin } from "./fixture.ts";

test("making someone an admin asks through window.confirm and only grants once confirmed", async () => {
  const prompts: string[] = [];
  let accept = false;
  const grants: unknown[] = [];
  const admin = await mountAdmin(
    "/settings/users",
    {
      "/scopes": { scopes: [], environments: [] },
      "/users": { users: [{ principalId: "alex@example.com", sessionCount: 1, turnCount: 2 }], grants: [] },
      "POST /grants": ({ body }) => {
        grants.push(body);
        return { ok: true };
      },
    },
    {
      confirm(this: unknown, message: string) {
        assert.equal(this, admin.window);
        prompts.push(message);
        return accept;
      },
    },
  );
  await admin.settle(10);
  const makeAdmin = () =>
    [...admin.document.querySelectorAll<HTMLButtonElement>("#view-data button")].find(
      (button) => button.textContent!.trim() === "Make admin",
    )!;
  makeAdmin().click();
  await admin.settle();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /^Make alex@example\.com an org admin\?/);
  assert.deepEqual(grants, []);
  accept = true;
  makeAdmin().click();
  await admin.settle();
  assert.deepEqual(grants, [{ principalId: "alex@example.com", role: "org_admin", scopeId: "org:acme" }]);
  admin.close();
});
