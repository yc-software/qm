import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

test("teammate invitation form stays in Users and preserves draft through async counts", async () => {
  const f = litFixture();
  let resolve!: (v: any) => void;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const controller = f.ui.users.users(
    f.root,
    { users: [], grants: [], externalUsers: [] },
    { defaultShell() {}, api: () => pending },
  );
  assert.deepEqual(
    [...f.root.querySelectorAll("h2")].map((e) => e.textContent),
    ["Users", "Invitations", "Company access"],
  );
  const invite = f.root.querySelector<HTMLButtonElement>('[aria-label="Invite teammate"]')!;
  invite.click();
  const input = f.root.querySelector<HTMLInputElement>("#users-email")!;
  input.value = "guest@example.com";
  input.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  resolve({ ok: true, data: { people: [] } });
  await pending;
  await Promise.resolve();
  assert.equal(controller.email, "guest@example.com");
  assert.equal(input, f.root.querySelector("#users-email"));
  assert.equal(input.value, "guest@example.com");
  assert.equal(input.closest("section")!.querySelector("h2")!.textContent, "Users");
  f.dom.window.close();
});
