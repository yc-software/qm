import { test } from "node:test";
import assert from "node:assert/strict";
import { appState, can } from "../src/shell-state.ts";

test("can(key) is false before /me loads", () => {
  appState.me = null;
  assert.equal(can("admin"), false);
});

test("can(key) gates on the permission being present", () => {
  appState.me = { user: "alice", org: "acme", permissions: ["admin"] };
  assert.equal(can("admin"), true);
  assert.equal(can("nope"), false);
});

test("a user without the permission cannot — drives hiding the admin session-log link", () => {
  appState.me = { user: "bob", org: "acme", permissions: [] };
  assert.equal(can("admin"), false);

  appState.me = { user: "carol", org: "acme" };
  assert.equal(can("admin"), false);
});
