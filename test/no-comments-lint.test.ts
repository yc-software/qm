import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";

async function rules(text: string) {
  const [result] = await new ESLint().lintText(text, { filePath: "scripts/sample.mjs" });
  return result!.messages.filter((message) => message.severity === 2).map((message) => message.ruleId);
}

test("lint fails on every comment and cannot be switched off inline", async () => {
  assert.deepEqual(await rules("#!/usr/bin/env node\nexport const a = 1;\n"), []);
  assert.deepEqual(await rules("export const a = 1; // why\n"), ["qm/no-comments"]);
  assert.deepEqual(await rules("/** doc */\nexport const a = 1;\n"), ["qm/no-comments"]);
  assert.deepEqual(await rules("/* eslint-disable */\nexport const a = 1;\n"), ["qm/no-comments"]);
});
