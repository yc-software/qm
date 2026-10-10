import { test } from "node:test";
import assert from "node:assert/strict";
import { jwtClaims } from "../src/util/jwt.ts";

const segment = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

test("jwtClaims decodes a three-segment token payload", () => {
  assert.deepEqual(jwtClaims(["h", segment({ sub: "1", exp: 5 }), "s"].join(".")), { sub: "1", exp: 5 });
});

test("jwtClaims returns undefined for malformed tokens", () => {
  for (const bad of [
    `h.${segment({ sub: "1" })}`,
    `h.${segment({ sub: "1" })}.s.x.y`,
    "h..s",
    "h.%%%.s",
    `h.${Buffer.from("not json").toString("base64url")}.s`,
    `h.${segment([1, 2])}.s`,
    `h.${segment(null)}.s`,
    42,
    undefined,
  ]) {
    assert.equal(jwtClaims(bad), undefined);
  }
});
