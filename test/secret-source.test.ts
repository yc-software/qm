import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnvSecretSource } from "../src/credentials/secret-source.ts";

test("env source reads the provided env; a missing or blank var is a miss", async () => {
  const src = createEnvSecretSource({ FOO: "bar", BLANK: "" } as NodeJS.ProcessEnv);
  assert.equal(await src.get("FOO"), "bar");
  assert.equal(await src.get("MISSING"), undefined);
  assert.equal(await src.get("BLANK"), undefined);
});
