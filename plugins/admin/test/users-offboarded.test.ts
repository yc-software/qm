import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

test("the users list hides offboarded people until asked, and badges deactivated and offboarded rows", async () => {
  const f = litFixture();
  const users = [
    { principalId: "active@example.com", admin: { isAdmin: false } },
    { principalId: "paused@example.com", deactivated: true, admin: { isAdmin: false } },
    { principalId: "gone@example.com", deactivated: true, offboarded: true, admin: { isAdmin: false } },
    {
      principalId: "gone-admin@example.com",
      deactivated: true,
      offboarded: true,
      admin: { isAdmin: true, role: "org_admin" },
    },
  ];
  const opened: string[] = [];
  f.ui.users.users(
    f.root,
    { users, grants: [] },
    {
      defaultShell() {},
      orgScope: "org:test",
      labelRole: () => "member",
      relTime: () => "-",
      fmtTime: () => "-",
      openUser: (id: string) => opened.push(id),
      api: async () => ({ ok: false, data: {} }),
    },
  );
  const rows = () =>
    [...f.root.querySelectorAll(".users-roster tbody tr")].map((r) => r.textContent!.replace(/\s+/g, " "));
  assert.equal(rows().length, 3);
  assert.ok(
    rows().some((r) => r.includes("gone-admin@example.com")),
    "an offboarded admin stays listed so their grant can be revoked",
  );
  assert.ok(!rows().some((r) => r.includes("gone@example.com")), "offboarded people are hidden by default");
  assert.ok(
    rows()
      .find((r) => r.includes("paused@example.com"))!
      .includes("Deactivated"),
  );

  const toggle = f.root.querySelector<HTMLInputElement>(".users-offboarded-toggle input")!;
  assert.match(f.root.querySelector(".users-offboarded-toggle")!.textContent!, /Show offboarded \(2\)/);
  toggle.checked = true;
  toggle.dispatchEvent(new f.window.Event("change"));
  const gone = rows().find((r) => r.includes("gone@example.com"));
  assert.ok(gone?.includes("Offboarded"), "the toggle shows them with a badge");
  [...f.root.querySelectorAll<HTMLElement>(".users-roster tbody tr")]
    .find((r) => r.textContent!.includes("gone@example.com"))!
    .click();
  assert.deepEqual(opened, ["gone@example.com"], "their detail page stays reachable");
  f.dom.window.close();
});
