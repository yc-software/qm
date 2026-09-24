import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedImagePolicy } from "../src/shared-image-policy.ts";

for (const origin of ["http://127.0.0.1:41234", "https://chat.example.com", "http://localhost:8144"]) {
  test(`shared diagrams only load inline images, assets and this share's files on ${origin}`, () => {
    const policy = sharedImagePolicy(`${origin}/share/external/example`, "/");
    assert.equal(
      policy,
      `img-src data: ${origin}/assets/ ${origin}/src/assets/ ${origin}/share/external/example/files/`,
    );
    assert.equal(policy.includes("'self'"), false);
    assert.equal(policy.includes("/api/"), false);
  });
}

test("shared image policy preserves a deployment base path", () => {
  assert.equal(
    sharedImagePolicy("https://example.com/qm/share/internal/example", "/qm/"),
    "img-src data: https://example.com/qm/assets/ https://example.com/qm/src/assets/ https://example.com/qm/share/internal/example/files/",
  );
});
