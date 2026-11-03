import assert from "node:assert/strict";
import test from "node:test";
import { mountPage } from "./fixture.ts";

const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.trim() === label)!;

test("users: make admin confirms before granting, revoke sends the grant target, invite posts and refreshes", async () => {
  let accept = false;
  const calls: unknown[] = [];
  const users = {
    users: [
      { principalId: "alex+a@example.com", sessionCount: 1, turnCount: 2 },
      { principalId: "kim@example.com", admin: { isAdmin: true, scopeId: "org:acme", role: "org_admin" } },
    ],
    grants: [{ role: "org_admin" }, { role: "org_admin" }],
    externalUsers: [],
  };
  const page = await mountPage(
    "/settings/users",
    {
      "GET /users": users,
      "POST /grants": ({ body }) => (calls.push(["POST", body]), {}),
      "DELETE /grants/kim@example.com": ({ url }) => (calls.push(["DELETE", url.search]), {}),
      "POST /users/invite": ({ body }) => (
        calls.push(["INVITE", body]),
        { member: { email: body.email }, emailSent: false, signInUrl: "https://x/in" }
      ),
    },
    { confirm: () => accept },
  );
  await page.settle();
  const row = page.document.querySelector<HTMLAnchorElement>("td a")!;
  assert.equal(row.getAttribute("href"), "/settings/user?principal=alex%2Ba%40example.com");
  button(page.host, "Make admin").click();
  await page.settle();
  assert.deepEqual(calls, []);
  accept = true;
  button(page.host, "Make admin").click();
  await page.settle();
  button(page.host, "Revoke").click();
  await page.settle();
  const email = page.document.querySelector<HTMLInputElement>("#users-email")!;
  email.value = "new@example.com";
  email.dispatchEvent(new page.window.Event("input"));
  page.document.querySelector("form")!.dispatchEvent(new page.window.Event("submit", { cancelable: true }));
  await page.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["POST", { principalId: "alex+a@example.com", role: "org_admin", scopeId: "org:acme" }],
    ["DELETE", "?scope=org%3Aacme&role=org_admin"],
    ["INVITE", { email: "new@example.com", role: "member" }],
  ]);
  assert.match(page.host.textContent!, /Added new@example\.com\./);
  assert.ok(button(page.host, "Copy invite link"));
  page.close();
});

test("user detail: loads profile and keychain, sets onboarding, and links back to the list", async () => {
  const puts: unknown[] = [];
  const page = await mountPage("/settings/user?principal=alex%40example.com", {
    "GET /users/alex@example.com": { principalId: "alex@example.com", onboarding: "pending" },
    "GET /keychain": {
      credentials: [{ id: "c1", service: "github" }],
      grants: [{ credentialId: "c1", mode: "standing" }],
    },
    "PUT /users/alex@example.com/onboarding": ({ body }) => (puts.push(body), { body: { status: body.status } }),
  });
  await page.settle();
  assert.match(page.host.textContent!, /Credentials \(1\)/);
  assert.match(page.host.textContent!, /Grants \(1\)/);
  button(page.host, "Mark completed").click();
  await page.settle();
  assert.deepEqual(puts, [{ status: "completed" }]);
  assert.match(page.host.textContent!, /Saved\./);
  assert.equal(page.document.querySelector(".context-back")!.getAttribute("href"), "/settings/users");
  page.close();
});

test("keychain: lists people with links to their user page", async () => {
  const page = await mountPage("/settings/keychain", {
    "GET /keychain": {
      people: [{ principalId: "alex@example.com", credentialCount: 2 }],
      credentials: [],
      grants: [],
      asks: [],
    },
  });
  await page.settle();
  const link = [...page.document.querySelectorAll<HTMLAnchorElement>("a")].find((a) =>
    a.textContent!.includes("alex@"),
  )!;
  assert.equal(link.getAttribute("href"), "/settings/user?principal=alex%40example.com");
  page.close();
});
