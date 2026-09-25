import assert from "node:assert/strict";
import test from "node:test";
import { UsersView } from "../ui/users.ts";

test("admin promotion and admin invitations require confirmation before making a request", async () => {
  for (const approved of [false, true]) {
    for (const invite of [false, true]) {
      const requests: string[] = [];
      let message = "";
      const view = Object.create(UsersView.prototype) as UsersView;
      Object.assign(view, {
        data: {},
        email: "teammate@example.test",
        role: "org_admin",
        pending: new Set(),
        refreshRequest: 0,
        root: { isConnected: true },
        draw() {},
        renderShell() {},
        services: {
          orgScope: "org:qa",
          confirm(text: string) {
            message = text;
            return approved;
          },
          async api(method: string, path: string) {
            if (method === "POST") requests.push(path);
            return { ok: true, data: { member: { email: "teammate@example.test" }, emailSent: true } };
          },
          clearCache() {},
        },
      });
      if (invite) await view.invite();
      else await view.admin({ principalId: "teammate@example.test" }, { stopPropagation() {} } as Event);
      assert.match(message, /Make teammate@example.test an org admin/);
      assert.match(message, /manage users, permissions, and organization settings/);
      assert.deepEqual(requests, approved ? [invite ? "/api/users/invite" : "/api/grants"] : []);
    }
  }
});
