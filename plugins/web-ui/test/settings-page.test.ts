import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const shellState = readFileSync(new URL("../src/shell-state.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("settings is a routable view, so /settings survives a reload and a shared link", () => {
  assert.match(shellState, /"skills", "settings"\] as const/);
  assert.match(shell, /case "settings":\s*renderSettings\(\);/);
  const switchBody = shell.slice(
    shell.indexOf("export function switchView"),
    shell.indexOf("function refreshActiveView"),
  );
  assert.match(switchBody, /case "settings":/, "switchView must route the settings view");
});

test("the sidebar footer keeps only the identity pill and the settings button", () => {
  const footer = shell.slice(
    shell.indexOf("export function renderSidebarFooter"),
    shell.indexOf("export function renderSidebarTop"),
  );
  assert.match(footer, /class="user-pill"/);
  assert.match(footer, /aria-label="Settings"/);
  assert.doesNotMatch(footer, /theme-toggle/, "the theme toggle became the settings button");
  assert.doesNotMatch(footer, /ADMIN_HOME_URL/, "admin moved onto the settings page");
  assert.doesNotMatch(footer, /aria-label="Sign out"/, "sign out moved behind the identity pill");
  assert.match(footer, /Sign out/, "sign out still exists — inside the pill's menu");
  assert.doesNotMatch(shell, /mini-lit\/dist\/ThemeToggle/, "the theme web component is no longer imported");
});

test("the identity menu closes on an outside click and on Escape", () => {
  assert.match(main, /if \(!target\?\.closest\("\.user-menu"\)\) closeUserMenu\(\);/);
  const escapeHandler = main.slice(main.indexOf('if (e.key !== "Escape") return;'));
  assert.match(escapeHandler, /closeUserMenu\(\);/);
});

test("theme choice persists under the key the boot path reads, and system tracks the OS", () => {
  assert.match(settings, /const THEME_KEY = "theme";/);
  assert.match(settings, /localStorage\.removeItem\(THEME_KEY\)/, "system is stored as the absence of a choice");
  assert.match(settings, /matchMedia\("\(prefers-color-scheme: dark\)"\)/);
  assert.match(settings, /classList\.toggle\("dark", dark\)/);
  assert.match(
    shell,
    /applyTheme\(\);\nwatchSystemTheme\(\);/,
    "boot must apply the saved theme without the old component",
  );
});

test("the settings page offers the theme picker and a way into admin", () => {
  assert.match(settings, /value: "light"/);
  assert.match(settings, /value: "dark"/);
  assert.match(settings, /value: "system"/);
  assert.match(settings, /href=\$\{ADMIN_HOME_URL\}/);
  assert.match(settings, /role="radiogroup"/);
  assert.match(css, /\.settings-choice-option\.selected \{/);
});

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("the chat greeting rotates across reloads, not just within one page session", () => {
  assert.match(chat, /const CTA_INDEX_KEY = "web-ui:chat-cta";/);
  const next = chat.slice(chat.indexOf("function nextChatCta"), chat.indexOf("const connectedConnectors"));
  assert.match(next, /localStorage\.getItem\(CTA_INDEX_KEY\)/, "the seed must survive a page load");
  assert.match(next, /localStorage\.setItem\(CTA_INDEX_KEY/);
  assert.match(next, /% CHAT_CTAS\.length/);
  assert.doesNotMatch(chat, /let ctaIndex = -1;/, "the per-surface counter always restarted at the first line");
});
