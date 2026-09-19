import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";
import { UsersView } from "../ui/users.ts";
function model() {
  const view = Object.create(UsersView.prototype) as UsersView;
  Object.assign(view, {
    pending: new Set(),
    refreshRequest: 0,
    root: { isConnected: true },
    draw: () => {},
    renderShell: () => {},
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

test("roster refresh updates shell counts while retaining search focus and invitation drafts", async () => {
  const f = litFixture();
  const bar = f.document.createElement("div");
  bar.id = "shellbar";
  f.document.body.prepend(bar);
  const shells: any[] = [];
  let data = { users: [], grants: [], externalUsers: [] } as any;
  const view = f.ui.users.users(f.root, data, {
    defaultShell(shell: any) {
      shells.push(shell);
      bar.replaceChildren();
      const search = f.document.createElement("div");
      search.className = "shell-search";
      const input = f.document.createElement("input");
      input.value = shell.search.value;
      input.oninput = () => shell.search.onInput(input.value);
      search.append(input);
      bar.append(search);
    },
    api: async (_method: string, path: string) => ({ ok: true, data: path === "/api/users" ? data : { people: [] } }),
    clearCache() {},
    labelRole: String,
  });
  f.root.querySelector<HTMLButtonElement>('[aria-label="Invite external user"]')!.click();
  const email = f.root.querySelector<HTMLInputElement>("#users-email")!;
  email.value = "draft@example.com";
  email.dispatchEvent(new f.window.Event("input"));
  const search = bar.querySelector("input")!;
  search.value = "admin";
  search.dispatchEvent(new f.window.Event("input"));
  search.focus();
  search.setSelectionRange(2, 4);
  data = { users: [], grants: [{ role: "org_admin" }], externalUsers: [] };
  await view.refresh();
  view.draw();
  assert.equal(shells.at(-1).stats[1][0], 1);
  assert.equal(bar.querySelector("input"), search);
  assert.equal(f.document.activeElement, search);
  assert.equal(search.value, "admin");
  assert.equal(search.selectionStart, 2);
  assert.equal(search.selectionEnd, 4);
  assert.equal(f.root.querySelector("#users-email"), email);
  assert.equal(email.value, "draft@example.com");
  assert.equal(view.inviteOpen, true);
  bar.replaceChildren(f.document.createTextNode("Another view"));
  await view.refresh();
  assert.equal(bar.textContent, "Another view");
  f.dom.window.close();
});
