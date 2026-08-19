import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

test("admin navigation uses an admin-specific icon", () => {
  const adminLink = shell.match(/<a class="navrow" href=\$\{ADMIN_HOME_URL\}[\s\S]*?<\/a>/);
  assert.ok(adminLink, "admin navigation link exists");
  assert.match(adminLink[0], /icon\(ShieldCheck, 17\)/);
  assert.doesNotMatch(adminLink[0], /icon\(ArrowLeft, 17\)/);
});

test("the sidebar footer carries no duplicate admin shortcut", () => {
  assert.doesNotMatch(shell, /<a class="icon-btn subtle" href=\$\{ADMIN_HOME_URL\}/);
});
