import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("list search uses its purpose as an accessible name", () => {
  const source = readFileSync(new URL("../src/list-page.ts", import.meta.url), "utf8");
  assert.equal(source.includes("aria-label=${o.search.placeholder"), true);
});

test("every list page renders its status tabs as one chip row above the table, never inside it", () => {
  const read = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const crons = read("crons.ts");
  const deploys = read("deploys.ts");
  assert.match(crons, /filters: html`\$\{notice\}\$\{all\.length \? cronTabs\(counts\) : nothing\}`/);
  assert.doesNotMatch(crons, /rows\.push\(cronTabs/);
  assert.match(deploys, /filters,\s*rows: rows\.map\(deploymentRow\)/);
  for (const file of ["crons.ts", "deploys.ts", "skills.ts", "sessions.ts"]) {
    assert.match(read(file), /class="resource-tabs"/, `${file} uses the shared chip row`);
  }
  for (const file of ["crons.ts", "deploys.ts", "skills.ts"]) {
    assert.match(read(file), /data-status=\$\{/, `${file} tags each chip with the status it filters`);
  }
  const css = read("shell.css") + read("styles/filter.css");
  assert.doesNotMatch(css, /cron-filter-chip|cron-list-controls/);
  assert.match(css, /\.list-rows \{[^}]*border: 1px solid var\(--line\);[^}]*border-radius: var\(--radius-md\);/);
  assert.match(css, /\.list-divider \{[^}]*background: var\(--line\);/);
  assert.match(css, /\.resource-tabs button\.active \{[^}]*background: var\(--field\);/);
  assert.match(css, /\.resource-tabs button span \{[^}]*font-family: var\(--font-mono\);[^}]*font-size: 11\.5px;/);
});
