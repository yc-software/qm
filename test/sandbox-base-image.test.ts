import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the sandbox base permits Claude Code's required install script", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /npm install -g --allow-scripts=@anthropic-ai\/claude-code/);
});

test("the sandbox base verifies the finance router YAML runtime", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /PYYAML_VERSION=6\.0\.3/);
  assert.match(dockerfile, /OPENPYXL_VERSION=3\.1\.5/);
  assert.match(dockerfile, /python -c "import openpyxl, yaml"/);
});
