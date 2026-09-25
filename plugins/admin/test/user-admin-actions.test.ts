import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

for (const revoke of [false, true])
  test(`user-row ${revoke ? "revoke" : "promotion"} confirms and sends exact grant target`, async () => {
    const f = litFixture();
    const calls: any[] = [];
    let accepted = false;
    const user = {
      principalId: "alex+admin@example.com",
      admin: { isAdmin: revoke, scopeId: "org:test", role: "org_admin" },
    };
    const controller = f.ui.users.users(
      f.root,
      { users: [user], grants: [{ role: "org_admin" }, { role: "org_admin" }] },
      {
        defaultShell() {},
        orgScope: "org:test",
        labelRole: () => "admin",
        confirm: (message: string) => {
          assert.ok(message.includes(user.principalId));
          return accepted;
        },
        clearCache() {},
        api: async (method: string, path: string, body: any) => {
          if (method !== "GET") calls.push([method, path, ...(body ? [body] : [])]);
          return { ok: true, data: path === "/api/users" ? { users: [user], grants: [] } : {} };
        },
      },
    );
    const event = new f.window.Event("click");
    await controller.admin(user, event);
    assert.equal(calls.length, 0);
    accepted = true;
    await controller.admin(user, event);
    assert.deepEqual(
      JSON.parse(JSON.stringify(calls[0])),
      revoke
        ? ["DELETE", "/api/grants/alex%2Badmin%40example.com?scope=org%3Atest&role=org_admin"]
        : ["POST", "/api/grants", { principalId: user.principalId, role: "org_admin", scopeId: "org:test" }],
    );
    assert.equal(controller.pending.size, 0);
    f.dom.window.close();
  });
