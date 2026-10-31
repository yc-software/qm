import assert from "node:assert/strict";
import { test } from "node:test";
import { avatarInitial, groupAvatarStack } from "../src/group-avatars.ts";

const m = (principalId: string, displayName: string) => ({ principalId, displayName });

test("group DM avatars follow the label order and show everyone up to three", () => {
  const stack = groupAvatarStack(
    [m("U3", "Eric Migicovsky"), m("U1", "Regan Bell"), m("U2", "josh")],
    ["regan", "eve", "josh", "eric"],
  );
  assert.deepEqual(
    stack.shown.map((x) => x.principalId),
    ["U1", "U2", "U3"],
  );
  assert.equal(stack.overflow, 0);
});

test("more than three people collapse to two faces and a +N chip", () => {
  const five = ["a", "b", "c", "d", "e"].map((n) => m(n, n));
  assert.deepEqual(groupAvatarStack(five), { shown: five.slice(0, 2), overflow: 3 });
  assert.equal(groupAvatarStack(five.slice(0, 4)).overflow, 2);
  assert.deepEqual(groupAvatarStack(undefined), { shown: [], overflow: 0 });
});

test("avatar initials fall back when a name is blank", () => {
  assert.equal(avatarInitial("regan"), "R");
  assert.equal(avatarInitial("  "), "?");
});
