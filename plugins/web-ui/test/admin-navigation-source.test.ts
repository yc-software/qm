import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("admin navigation uses an admin-specific icon", () => {
  const adminLink = shell.match(/<a class="icon-btn subtle footer-rail-btn" href=\$\{ADMIN_HOME_URL\}[\s\S]*?<\/a>/);
  assert.ok(adminLink, "admin navigation link exists");
  assert.match(adminLink[0], /icon\(ShieldUser, 17\)/);
  assert.doesNotMatch(adminLink[0], /icon\(ArrowLeft, 17\)/);
});

test("the open sidebar puts admin on the account menu and the collapsed rail keeps an icon", () => {
  assert.equal([...shell.matchAll(/href=\$\{ADMIN_HOME_URL\}/g)].length, 2);
  assert.match(shell, /class="session-menu-option" href=\$\{ADMIN_HOME_URL\}/);
  assert.match(shell, /class="icon-btn subtle footer-rail-btn" href=\$\{ADMIN_HOME_URL\}/);
  assert.match(css, /\.layout:not\(\.sidebar-closed\) \.footer-rail-btn \{\s*display: none;/);
});
