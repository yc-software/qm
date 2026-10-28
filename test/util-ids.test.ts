import { test } from "node:test";
import assert from "node:assert/strict";
import { commitShaPrefixSchema, commitShaSchema, uuidSchema } from "../src/util/ids.ts";

const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

test("commitShaSchema: only a full lowercase 40-hex SHA", () => {
  assert.equal(ok(commitShaSchema, "a".repeat(40)), true);
  assert.equal(ok(commitShaSchema, "0123456789abcdef0123456789abcdef01234567"), true);
  assert.equal(ok(commitShaSchema, "A".repeat(40)), false);
  assert.equal(ok(commitShaSchema, "a".repeat(39)), false);
  assert.equal(ok(commitShaSchema, "a".repeat(41)), false);
  assert.equal(ok(commitShaSchema, "a".repeat(64)), false);
  assert.equal(ok(commitShaSchema, `${"a".repeat(40)}\n`), false);
  assert.equal(ok(commitShaSchema, undefined), false);
});

test("commitShaPrefixSchema: a lowercase SHA of 7 to 40 hex characters", () => {
  assert.equal(ok(commitShaPrefixSchema, "abcdef1"), true);
  assert.equal(ok(commitShaPrefixSchema, "a".repeat(40)), true);
  assert.equal(ok(commitShaPrefixSchema, "abcdef"), false);
  assert.equal(ok(commitShaPrefixSchema, "a".repeat(41)), false);
  assert.equal(ok(commitShaPrefixSchema, "ABCDEF1"), false);
  assert.equal(ok(commitShaPrefixSchema, "main"), false);
});

test("uuidSchema: any 8-4-4-4-12 hex UUID in either case, with no version or variant check", () => {
  assert.equal(ok(uuidSchema, "123e4567-e89b-12d3-a456-426614174000"), true);
  assert.equal(ok(uuidSchema, "123E4567-E89B-12D3-A456-426614174000"), true);
  assert.equal(ok(uuidSchema, "123e4567-e89b-02d3-0456-426614174000"), true);
  assert.equal(ok(uuidSchema, "00000000-0000-0000-0000-0000000000ff"), true);
  assert.equal(ok(uuidSchema, "123e4567e89b12d3a456426614174000"), false);
  assert.equal(ok(uuidSchema, "123e4567-e89b-12d3-a456-42661417400g"), false);
  assert.equal(ok(uuidSchema, " 123e4567-e89b-12d3-a456-426614174000"), false);
  assert.equal(ok(uuidSchema.lowercase(), "123e4567-e89b-12d3-a456-426614174000"), true);
  assert.equal(ok(uuidSchema.lowercase(), "123E4567-e89b-12d3-a456-426614174000"), false);
});
