import assert from "node:assert/strict";
import { test } from "node:test";
import { avatarInitial, groupAvatarStack } from "../src/group-avatars.ts";

const people = ["alice", "bob", "carol", "dan", "erin"].map((name) => ({
  principalId: `U_${name}`,
  displayName: name,
}));

test("up to three other people each get a face", () => {
  assert.deepEqual(groupAvatarStack(people.slice(0, 3)), { shown: people.slice(0, 3), overflow: 0 });
  assert.deepEqual(groupAvatarStack(undefined), { shown: [], overflow: 0 });
});

test("four or more collapse to two faces and a +N chip", () => {
  assert.deepEqual(groupAvatarStack(people.slice(0, 4)), { shown: people.slice(0, 2), overflow: 2 });
  assert.deepEqual(groupAvatarStack(people), { shown: people.slice(0, 2), overflow: 3 });
});

test("avatar initials fall back when a name is blank", () => {
  assert.equal(avatarInitial("alice"), "A");
  assert.equal(avatarInitial("  "), "?");
});
