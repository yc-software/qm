import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

test("user controls render before credentials and artifacts are scoped links", async () => {
  const f = litFixture();
  let finish!: (value: any) => void;
  const keychain = new Promise((resolve) => {
    finish = resolve;
  });
  const pending = f.ui.userDetail.detail(f.root, "alex@example.com", {
    pageShell() {},
    current: () => true,
    labelRole: () => "member",
    scopeKind: () => "personal",
    fmtTime: String,
    plural: (n: number, noun: string) => `${n} ${noun}s`,
    stateToUrl: ({ view, scope }: any) => `/admin/${view}?scope=${encodeURIComponent(scope)}`,
    webUiAsButton: () => f.document.createElement("button"),
    api: (_method: string, path: string) =>
      path.startsWith("/api/keychain")
        ? keychain
        : Promise.resolve({
            ok: true,
            data: { principalId: "alex@example.com", scopeId: "personal:alex@example.com", stats: { sessions: 42 } },
          }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    [...f.root.querySelectorAll("h2")].map((e) => e.textContent),
    ["Configuration", "Onboarding", "Offboarding"],
  );
  const links = [...f.root.querySelectorAll<HTMLAnchorElement>(".user-resource-links a")];
  assert.deepEqual(
    links.map((e) => e.textContent),
    ["42 conversations →", "Files →", "Apps →", "Crons →", "Skills →", "Memory →"],
  );
  assert.ok(links.every((a) => a.href.endsWith("scope=personal%3Aalex%40example.com")));
  finish({ ok: true, data: { credentials: [], grants: [] } });
  await pending;
  assert.deepEqual(
    [...f.root.querySelectorAll("h2")].map((e) => e.textContent),
    ["Credentials (0)", "Grants (0)", "Configuration", "Onboarding", "Offboarding"],
  );
  f.dom.window.close();
});

test("offboarding previews, applies only after confirmation, and reports each result", async () => {
  const f = litFixture();
  const posts: any[] = [];
  let accepted = false;
  const change = {
    kind: "cron",
    id: "c1",
    label: "daily digest",
    scopeId: "personal:alex@example.com",
    action: "disable_and_archive",
  };
  const signIn = {
    kind: "principal",
    id: "alex@example.com",
    label: "sign-in and app access",
    scopeId: "org:test",
    action: "deactivate",
  };
  const kept = [{ kind: "app", id: "a1", label: "team app", scopeId: "channel:C1", reason: "lives in a shared scope" }];
  await f.ui.userDetail.detail(f.root, "alex@example.com", {
    pageShell() {},
    current: () => true,
    labelRole: () => "member",
    scopeKind: () => "personal",
    fmtTime: String,
    plural: (n: number, noun: string) => `${n} ${noun}s`,
    stateToUrl: () => "/admin",
    webUiAsButton: () => f.document.createElement("button"),
    confirm: () => accepted,
    api: async (method: string, path: string, body: any) => {
      if (method === "POST") {
        posts.push(JSON.parse(JSON.stringify([path, body])));
        return body?.apply
          ? {
              ok: true,
              data: {
                applied: true,
                kept,
                principal: {
                  principalId: "alex@example.com",
                  offboarded: true,
                  offboardedAt: 1700000000000,
                  offboardedBy: "admin-alice",
                  offboardChanges: [{ ...signIn, result: "done" }],
                },
                changes: [
                  { ...signIn, result: "done" },
                  { ...change, result: "failed", error: "store unavailable" },
                ],
              },
            }
          : { ok: true, data: { applied: false, kept, changes: [signIn, change] } };
      }
      if (path.startsWith("/api/keychain")) return { ok: true, data: { credentials: [], grants: [] } };
      return { ok: true, data: { principalId: "alex@example.com", scopeId: "personal:alex@example.com" } };
    },
  });
  const button = (label: string) =>
    [...f.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.trim().startsWith(label))!;
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  button("Preview offboarding").click();
  await settle();
  assert.deepEqual(posts, [["/api/users/alex%40example.com/offboard", { apply: false }]]);
  assert.match(f.root.textContent!, /daily digest/);
  assert.match(f.root.textContent!, /lives in a shared scope/);

  button("Offboard (2 changes)").click();
  await settle();
  assert.equal(posts.length, 1, "declining the confirmation sends nothing");

  accepted = true;
  button("Offboard (2 changes)").click();
  await settle();
  assert.deepEqual(posts[1], ["/api/users/alex%40example.com/offboard", { apply: true }]);
  assert.match(f.root.textContent!, /store unavailable/);
  assert.match(f.root.textContent!, /1 changes failed/);
  assert.ok(button("Reactivate sign-in"), "sign-in shows as deactivated");
  assert.match(f.root.textContent!, /offboarded\s+Offboarded 1700000000000 by admin-alice \(1 changes\)/);
  f.dom.window.close();
});
