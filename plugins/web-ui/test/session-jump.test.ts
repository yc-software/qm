import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const jump = readFileSync(new URL("../src/session-jump.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
const jumpHotkey = jump.slice(jump.indexOf("export function registerSessionJumpHotkeys"));
const newSessionHotkey = jump.slice(
  jump.indexOf("export function registerNewSessionHotkey"),
  jump.indexOf("export function registerSessionJumpHotkeys"),
);

test("cmd+digit jumps to the Nth rendered sidebar session", () => {
  assert.match(jumpHotkey, /hasExactPrimaryModifier\(e, isMac\)/);
  assert.match(
    jumpHotkey,
    /\^Digit\(\[1-9\]\)\$.*exec\(e\.code\)/,
    "physical digit keys, so shifted-digit layouts like AZERTY still work",
  );
  assert.match(
    jumpHotkey,
    /appState\.listEl\?\.querySelectorAll<HTMLAnchorElement>\("a\.session"\)\[Number\(digit\) - 1\]/,
    "targets the Nth session anchor in rendered sidebar order, so pinned rows and visibility rules are honored for free",
  );
  assert.ok(
    jumpHotkey.indexOf("e.preventDefault()") > jumpHotkey.indexOf("if (!target) return"),
    "digits without a matching row fall through untouched",
  );
  assert.match(
    jumpHotkey,
    /target\.click\(\)/,
    "reuses the row's click path (openSession, split intercept, view switch)",
  );
});

test("cmd+n starts a new session through the sidebar action path", () => {
  assert.match(newSessionHotkey, /!appState\.me \|\| !appState\.mainEl\?\.isConnected/);
  assert.match(newSessionHotkey, /matchesPrimaryShortcut\(e, "n", isMac\)/);
  assert.match(newSessionHotkey, /e\.preventDefault\(\);\s*startNewChatInLastScope\(\);/);
});

test("the session hotkeys are registered at boot", () => {
  assert.match(main, /registerNewSessionHotkey\(\)/);
  assert.match(main, /registerSessionJumpHotkeys\(\)/);
});

test("sidebar session rows expose the anchor the hotkey targets", () => {
  const row = sessions.match(/function sessionRow\([^]*?\n\}/)?.[0] ?? "";
  assert.match(row, /class="session"/, "sessionRow renders an a.session anchor");
  assert.match(row, /void openSession\(s\);/, "clicking the anchor opens the session");
});
