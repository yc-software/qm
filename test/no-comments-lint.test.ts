import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();

async function rules(text: string, filePath: string) {
  const [result] = await eslint.lintText(text, { filePath });
  return result!.messages.filter((message) => message.severity === 2).map((message) => message.ruleId);
}

test("lint fails on every comment and cannot be switched off inline", async () => {
  for (const filePath of ["scripts/sample.ts", "docs/qa/sample.mjs"]) {
    assert.deepEqual(await rules("#!/usr/bin/env node\nexport const a = 1;\n", filePath), []);
    assert.deepEqual(await rules("export const a = 1; // why\n", filePath), ["qm/no-comments"]);
    assert.deepEqual(await rules("/** doc */\nexport const a = 1;\n", filePath), ["qm/no-comments"]);
    assert.deepEqual(await rules("/* eslint-disable */\nexport const a = 1;\n", filePath), ["qm/no-comments"]);
  }
});
