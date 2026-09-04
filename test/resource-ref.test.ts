import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cronRef,
  deployRef,
  encodeRef,
  fileRef,
  parseRef,
  refPrefix,
  serviceCredRef,
  skillRef,
} from "../src/acl/resource-ref.ts";

test("encode/parse round-trips every kind", () => {
  for (const r of [skillRef("s1"), deployRef("d1"), cronRef("c1"), serviceCredRef("x")]) {
    assert.deepEqual(parseRef(encodeRef(r)), r);
  }
});

test("a file ref encodes to its bare path (no prefix) so pre-ref file grants are byte-identical", () => {
  assert.equal(encodeRef(fileRef("dir/orange.jpg")), "dir/orange.jpg");
  assert.deepEqual(parseRef("dir/orange.jpg"), { kind: "file", id: "dir/orange.jpg" });
});

test("deploy keeps its historical `deployment:` wire prefix while its kind is `deploy`", () => {
  assert.equal(encodeRef(deployRef("d1")), "deployment:d1");
  assert.deepEqual(parseRef("deployment:d1"), { kind: "deploy", id: "d1" });
  assert.equal(refPrefix("deploy"), "deployment:");
});

test("an unprefixed string with a path that resembles a non-file id is still a file ref", () => {
  assert.deepEqual(parseRef("notes:draft.md"), { kind: "file", id: "notes:draft.md" });
});
