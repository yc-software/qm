import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const HARNESSES = ["claude-harness.ts", "codex-harness.ts", "opencode-harness.ts", "pi-harness.ts"];

function source(file: string): string {
  return readFileSync(new URL(`../src/harness/${file}`, import.meta.url), "utf8");
}

test("every harness still flags the mid-turn message it persists", () => {
  assert.match(source("harness-shared.ts"), /steered: true/);
  for (const file of HARNESSES) {
    assert.match(
      source(file),
      /recordSteerIntake/,
      `${file} no longer stamps steered:true — a requeued run will re-answer a turn this harness steered`,
    );
  }
});
