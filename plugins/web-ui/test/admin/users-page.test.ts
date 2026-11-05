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
  assert.equal(row.getAttribute("href"), "/settings/user?user=alex%2Ba%40example.com");
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
  const page = await mountPage("/settings/user?user=alex%40example.com", {
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
  assert.equal(link.getAttribute("href"), "/settings/user?user=alex%40example.com");
  page.close();
});

test("user detail: offboarding previews, applies after confirming, then offers reactivation", async () => {
  let accept = false;
  const calls: unknown[] = [];
  const changes = [
    { kind: "principal", id: "alex@example.com", label: "sign-in", action: "deactivate" },
    { kind: "cron", id: "cr1", label: "digest", action: "disable_and_archive" },
  ];
  const page = await mountPage(
    "/settings/user?user=alex%40example.com",
    {
      "GET /users/alex@example.com": { principalId: "alex@example.com", deactivated: false },
      "GET /keychain": { credentials: [], grants: [] },
      "POST /users/alex@example.com/offboard": ({ body }) => (
        calls.push(["offboard", body]),
        body.apply
          ? {
              applied: true,
              changes: changes.map((c, i) => ({ ...c, result: i ? "failed" : "done", error: "boom" })),
              user: { id: "alex@example.com", offboardedAt: Date.UTC(2026, 0, 2), offboardedBy: "admin@example.com" },
            }
          : { applied: false, changes }
      ),
      "POST /users/alex@example.com/reactivate": () => (calls.push(["reactivate"]), { active: true }),
    },
    { confirm: () => accept },
  );
  await page.settle();
  button(page.host, "Preview offboarding").click();
  await page.settle();
  assert.match(page.host.textContent!, /disable and archive/);
  button(page.host, "Offboard").click();
  await page.settle();
  accept = true;
  button(page.host, "Offboard").click();
  await page.settle();
  assert.match(page.host.textContent!, /1 failed\. Preview again to retry\./);
  assert.match(page.host.textContent!, /Offboarded .* by admin@example\.com/, "the card shows the user row's record");
  button(page.host, "Reactivate").click();
  await page.settle();
  assert.match(page.host.textContent!, /Sign-in is back on\./);
  assert.doesNotMatch(page.host.textContent!, /Offboarded .* by admin@example\.com/);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["offboard", {}],
    ["offboard", { apply: true }],
    ["reactivate"],
  ]);
  page.close();
});

test("users: offboarded people are badged and hidden until shown", async () => {
  const page = await mountPage("/settings/users", {
    "GET /users": {
      users: [
        { principalId: "stay@example.com", sessionCount: 1, turnCount: 1 },
        { principalId: "gone@example.com", sessionCount: 1, turnCount: 1, offboarded: true, deactivated: true },
        {
          principalId: "boss@example.com",
          sessionCount: 1,
          turnCount: 1,
          offboarded: true,
          admin: { isAdmin: true, role: "org_admin", scopeId: "org:default-org" },
        },
      ],
      grants: [{ principalId: "boss@example.com", role: "org_admin", scopeId: "org:default-org" }],
      externalUsers: [],
    },
  });
  await page.settle();
  assert.doesNotMatch(page.host.textContent!, /gone@example\.com/);
  assert.doesNotMatch(page.host.textContent!, /boss@example\.com/, "an offboarded admin is hidden like anyone else");
  assert.match(page.host.textContent!, /1 users · 1 admins · 2 offboarded hidden/);
  const toggle = [...page.document.querySelectorAll("button")].find((b) =>
    /Show offboarded \(2\)/.test(b.textContent!),
  )!;
  toggle.click();
  await page.settle();
  assert.match(page.host.textContent!, /gone@example\.com\s*offboarded/);
  assert.match(page.host.textContent!, /3 users · 1 admins/, "the toggle reveals exactly the hidden count");
  page.close();
});

test("users: apps carry an app badge and the search finds them", async () => {
  const page = await mountPage("/settings/users", {
    "GET /users": {
      users: [
        { principalId: "pat@example.com", kind: "person", sessionCount: 1, turnCount: 1 },
        { principalId: "U0APP", kind: "app", sessionCount: 1, turnCount: 3 },
      ],
      grants: [],
      externalUsers: [],
    },
  });
  await page.settle();
  assert.match(page.host.textContent!, /U0APP\s*app/);
  assert.doesNotMatch(page.host.textContent!, /pat@example\.com\s*app/);
  const search = page.host.querySelector<HTMLInputElement>("input[type=search], .search input")!;
  search.value = "app";
  search.dispatchEvent(new page.window.Event("input"));
  await page.settle();
  assert.match(page.host.textContent!, /U0APP/);
  assert.doesNotMatch(page.host.textContent!, /pat@example\.com/);
  page.close();
});

test("users: a person links to their user id, lists their other sign-ins, and the search finds any of them", async () => {
  const page = await mountPage("/settings/users", {
    "GET /users": {
      users: [
        { userId: "u-1", principalId: "pat@example.com", aliases: ["pat@example.com", "U0PAT"], sessionCount: 2 },
        { userId: "u-2", principalId: "sam@example.com", aliases: ["sam@example.com"] },
      ],
      grants: [],
      externalUsers: [],
    },
  });
  await page.settle();
  const links = [...page.document.querySelectorAll<HTMLAnchorElement>("td a")].map((a) => a.getAttribute("href"));
  assert.deepEqual(links, ["/settings/user?user=u-1", "/settings/user?user=u-2"]);
  assert.match(page.host.textContent!, /U0PAT/);
  const search = page.document.querySelector<HTMLInputElement>("input[type=search]")!;
  search.value = "u0pat";
  search.dispatchEvent(new page.window.Event("input"));
  await page.settle();
  assert.deepEqual(
    [...page.document.querySelectorAll("td a")].map((a) => a.textContent),
    ["pat@example.com"],
  );
  page.close();
});

test("user detail: opens by user id, lists every sign-in, and acts on the person's primary sign-in", async () => {
  const puts: unknown[] = [];
  const page = await mountPage("/settings/user?user=u-1", {
    "GET /users/u-1": {
      userId: "u-1",
      principalId: "pat@example.com",
      onboarding: "pending",
      user: { id: "u-1", principalId: "pat@example.com", aliases: ["pat@example.com", "U0PAT"] },
    },
    "GET /keychain": { credentials: [], grants: [] },
    "PUT /users/pat@example.com/onboarding": ({ body }) => (puts.push(body), { body: { status: body.status } }),
  });
  await page.settle();
  assert.match(page.host.textContent!, /Sign-ins \(2\)/);
  assert.match(page.host.textContent!, /U0PAT/);
  button(page.host, "Mark completed").click();
  await page.settle();
  assert.deepEqual(puts, [{ status: "completed" }]);
  page.close();
});
