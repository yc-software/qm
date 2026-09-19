import assert from "node:assert/strict";
import test from "node:test";
import { UsersView } from "../ui/users.ts";
function model() {
  const view = Object.create(UsersView.prototype) as UsersView;
  Object.assign(view, {
    pending: new Set(),
    refreshRequest: 0,
    root: { isConnected: true },
    draw: () => {},
    data: {},
    email: "first@example.com",
    role: "member",
    expires: "2026-12-01",
    inviteOpen: true,
  });
  return view;
}
test("user invitation keeps newer edited fields open when the submitted invitation succeeds", async () => {
  const view = model();
  let resolve!: (value: any) => void;
  view.services = {
    api: async (method: string) => (method === "POST" ? new Promise((r) => (resolve = r)) : { ok: true, data: {} }),
    clearCache: () => {},
    fmtTime: () => "",
    labelRole: () => "",
  };
  const pending = view.invite();
  view.email = "next@example.com";
  resolve({ ok: true, data: { member: { email: "first@example.com" }, emailSent: true } });
  await pending;
  assert.equal(view.inviteOpen, true);
  assert.equal(view.email, "next@example.com");
});
test("overlapping roster refreshes cannot restore an older snapshot", async () => {
  const view = model();
  const pending: Array<(value: any) => void> = [];
  view.services = { api: () => new Promise((r) => pending.push(r)), clearCache: () => {} };
  const first = view.refresh(),
    second = view.refresh();
  pending[1]({ ok: true, data: { value: "latest" } });
  await second;
  pending[0]({ ok: true, data: { value: "older" } });
  await first;
  assert.equal(view.data.value, "latest");
});
