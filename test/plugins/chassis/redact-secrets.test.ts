import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSensitiveKeys } from "../../../plugins/chassis/src/redact-secrets.ts";

test("values under secret-named keys are redacted structurally at any depth", () => {
  assert.deepEqual(
    redactSensitiveKeys({
      id: 1,
      auth: { apiKey: "k", nested: [{ password: "p", note: "keep" }] },
      tokens: ["a", "b"],
      access_token: ["a", "b"],
      text: "Bearer stays because the key is not secret-named",
    }),
    {
      id: 1,
      auth: { apiKey: "[redacted]", nested: [{ password: "[redacted]", note: "keep" }] },
      tokens: ["a", "b"],
      access_token: "[redacted]",
      text: "Bearer stays because the key is not secret-named",
    },
  );
  assert.equal(redactSensitiveKeys("plain"), "plain");
});
