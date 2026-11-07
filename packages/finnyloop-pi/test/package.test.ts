import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSeedSkill } from "../../../src/skills/seed.ts";

const packageRoot = new URL("../", import.meta.url);
const skillUrl = new URL("../../../skills-seed/finnyloop/SKILL.md", import.meta.url);

test("Pi package manifest discovers the FinnyLoop extension", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8")) as {
    keywords?: string[];
    pi?: { extensions?: string[] };
  };
  assert.ok(manifest.keywords?.includes("pi-package"));
  assert.deepEqual(manifest.pi?.extensions, ["./extensions/finnyloop.ts"]);
});

test("FinnyLoop seed skill is valid and progressively disclosed", async () => {
  const parsed = parseSeedSkill(await readFile(skillUrl, "utf8"));
  assert.equal(parsed.name, "finnyloop");
  assert.match(parsed.description, /finance/i);
  assert.ok(parsed.body.length > 0);
  await readFile(new URL("references/protocol.md", skillUrl), "utf8");
});
