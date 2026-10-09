import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/skills.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

function bodyOf(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

test("skill rows link to dedicated detail routes instead of expanding inline", () => {
  const row = bodyOf("skillVariant");
  assert.match(row, /class="list-row skill-row/);
  assert.match(row, /deepLinkPath\(UI_BASE, "skills", null, null, s\.id \?\? null\)/);
  assert.match(row, /openSkill\(s, \{ push: true \}\)/);
  assert.doesNotMatch(row, /<details|<summary|skillMeta|skill-variant-meta/);
  assert.match(row, /<span class="list-row-title" dir="auto">\/\$\{s\.name\}<\/span>/);
  assert.match(row, /class="skill-row-description"/);
  assert.doesNotMatch(row, /<button|skill-edit-trigger|skill-archive-trigger/);
  assert.doesNotMatch(source, /skill-registry-controls|Filter skills by scope|Filter skills by source/);
  assert.match(css, /\.skill-row \.list-row-title \{\s*flex: 0 0 210px;/);
  assert.match(source, /groups: rows/);
});

test("skill details have a back link and resource fields", () => {
  const detail = bodyOf("openSkill");
  assert.match(detail, /listBackLink\("Skills", \(\) => drawSkills\(\)\)/);
  for (const label of ["Description", "Scope", "Version", "Source", "Capabilities", "Assets"]) {
    assert.match(detail, new RegExp(`<label>${label}</label>`));
  }
  assert.match(
    bodyOf("skillScopeTitle"),
    /s\.scope === "personal" \|\| s\.scope === "channel" \|\| s\.scope === "group"/,
  );
});

test("skill detail routes survive reload and browser history", () => {
  assert.match(shell, /if \(wanted === "skills" && wantedItem\) openSkillById\(wantedItem\)/);
  assert.match(shell, /else if \(view === "skills"\) routeSkillsHistory\(item\)/);
});
