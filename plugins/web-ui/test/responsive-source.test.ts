import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const compactCss = css.replace(/\s+/g, " ");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
const model = readFileSync(new URL("../src/sidebar-model.ts", import.meta.url), "utf8");
const contexts = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("mobile shell follows the visual viewport and device safe areas", () => {
  assert.match(page, /viewport-fit=cover/);
  assert.match(compactCss, /height: 100dvh/);
  for (const inset of ["top", "right", "bottom", "left"]) {
    assert.match(compactCss, new RegExp(`safe-area-inset-${inset}`));
  }
});

test("mobile sidebar is modal, dismissible, and sized for touch", () => {
  assert.match(
    shell,
    /closeSidebarOnNarrowView\(\);[\s\S]{0,200}shortcut\.target === "action:new-chat"\) startNewChatInLastScope\(\);/,
  );
  assert.match(sessions, /export function startNewChat\([^)]*\)[^{]*\{\s*closeSidebarOnNarrowView\(\);/);
  assert.match(shell, /class="sidebar-scrim"[^>]+aria-label="Close sidebar"[^>]+@click=\$\{toggleSidebar\}/);
  assert.match(shell, /main\.inert = modal/);
  assert.match(
    css,
    /\.layout\.sidebar-closed \.sidebar > :not\(\.brand\):not\(#sidebar-top\):not\(#sidebar-footer\),\s*\.layout\.sidebar-closed \.brand-lockup \{[^}]*opacity: 0;\s*visibility: hidden;/,
  );
  assert.match(shell, /sidebar\.setAttribute\("role", modal \? "dialog" : "navigation"\)/);
  assert.match(
    shell,
    /if \(modal\) sidebar\.setAttribute\("aria-modal", "true"\);\s*else sidebar\.removeAttribute\("aria-modal"\)/,
  );
  assert.match(shell, /event\.key === "Escape" && event\.defaultPrevented/);
  assert.match(shell, /event\.key === "Escape" && closeOpenSessionMenu\(\)/);
  assert.match(sessions, /data-menu-id=\$\{menuKey\}/);
  assert.match(sessions, /data-menu-id=\$\{s\.id\}/);
  assert.match(sessions, /focusSessionMenuButton\(menuKey\)/);
  assert.match(shell, /trapDialogFocus\(event, \(\) => setSidebarOpen\(false\)\)/);
  assert.match(css, /\.layout\.sidebar-closed \.sidebar \{\s*position: static;/);
  assert.match(
    shell,
    /setSidebarOpen\(false, false\);\s*requestAnimationFrame\(\(\) => appState\.mainEl\?\.focus\(\{ preventScroll: true \}\)\)/,
  );
  assert.match(shell, /class="main" id="main" tabindex="-1"/);
  assert.match(compactCss, /\.layout\.sidebar-closed \.sidebar-scrim \{\s*display: none;/);
  assert.match(
    compactCss,
    /\.navrow,[\s\S]*\.browse-tile,[\s\S]*\.settings-choice-option,[\s\S]*\.session-menu-option,[\s\S]*\.archived-toggle \{\s*min-height: 44px;/,
  );
  assert.match(compactCss, /\.session-menu-btn,[\s\S]*\.recent-project-new-chat \{\s*width: 44px;\s*height: 44px;/);
  assert.match(compactCss, /\.session-menu\s*\{\s*right:\s*0;\s*margin-top:\s*-22px;\s*\}/);
  assert.match(
    compactCss,
    /@media \(max-width: 860px\) and \(hover: none\)[\s\S]*\.sidebar \.session-menu-btn\s*\{\s*opacity:\s*1;\s*\}/,
  );
  assert.match(compactCss, /\.recent-project-head \.recent-project-count \{ opacity: 0; \}/);
});

test("the sidebar's quick actions share the navrow treatment", () => {
  assert.match(shell, /return html`<button\s+class="navrow"\s+type="button"/);
  assert.doesNotMatch(shell, /class="new-chat"/);
  assert.doesNotMatch(shell, /split-new-session/);
  assert.doesNotMatch(css, /(^|\n)\.new-chat[ ,:{]/);
  assert.doesNotMatch(css, /split-new-session/);
});

test("the sidebar resize handle stays accessible without a hover tooltip", () => {
  const resize = shell.match(/class="sidebar-resize-handle"[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.match(resize, /aria-label="Resize sidebar"/);
  assert.match(resize, /@pointerdown=\$\{startSidebarResize\}/);
  assert.match(resize, /@dblclick=\$\{resetSidebarWidth\}/);
  assert.match(resize, /@keydown=/);
  assert.doesNotMatch(shell, /Drag to resize/);
});

test("the configurable quick nav keeps search and the default destinations accessible", () => {
  assert.match(
    shell,
    /<nav class="nav quick-nav"[\s\S]*?aria-label="Search"[\s\S]*?sidebarTabs\(\)[\s\S]*?shortcuts.map\(shortcutRow\)/,
  );
  for (const target of [
    "view:chats",
    "view:inbox",
    "view:calendar",
    "view:contexts",
    "action:browse",
    "action:new-chat",
  ])
    assert.ok(model.includes(`"${target}"`));
  assert.match(sidebar, /aria-label="Shortcut destination"/);
  assert.doesNotMatch(shell, /nav-section-toggle|nav-group|navWorkspaceOpen/);
  assert.doesNotMatch(css, /\.nav-section-toggle|\.nav-group/);
});

test("sidebar customization controls remain large enough on touch screens", () => {
  assert.match(
    compactCss,
    /@media \(max-width: 860px\), \(pointer: coarse\) \{[\s\S]*?\.sidebar-small-button \{[^}]*flex-basis: 44px;[^}]*height: 44px;/,
  );
  assert.match(compactCss, /\.sidebar-tabs button,[\s\S]*?\.sidebar-section-toggle,[\s\S]*?min-height: 44px;/);
  assert.match(compactCss, /\.sidebar-customization-row \{ flex-wrap: wrap;/);
});

test("impersonation mode keeps its critical exit control below the top safe area", () => {
  assert.match(compactCss, /height: calc\(38px \+ env\(safe-area-inset-top\)\)/);
  assert.match(compactCss, /padding: env\(safe-area-inset-top\)/);
  assert.match(compactCss, /margin-top: calc\(38px \+ env\(safe-area-inset-top\)\)/);
  assert.match(compactCss, /\.layout\.impersonating \{\s*--surface-safe-top: 0px;/);
  assert.match(compactCss, /padding-top: calc\(10px \+ var\(--surface-safe-top\)\)/);
});

test("shared dialogs keep their scrollable edge inside device safe areas", () => {
  assert.match(
    compactCss,
    /\.project-dialog-backdrop,\s*\.project-dialog \{[\s\S]*--dialog-pad-bottom: max\(20px, env\(safe-area-inset-bottom\)\)/,
  );
  assert.match(
    compactCss,
    /padding: var\(--dialog-pad-top\) var\(--dialog-pad-right\) var\(--dialog-pad-bottom\) var\(--dialog-pad-left\)/,
  );
  assert.match(compactCss, /max-height: calc\(100dvh - var\(--dialog-pad-top\) - var\(--dialog-pad-bottom\)\)/);
});

test("touch layouts expose row actions and preserve readable composer choices", () => {
  assert.match(compactCss, /@media \(hover: none\)\s*\{\s*\.chat-row-actions\s*\{\s*opacity:\s*1;\s*\}/);
  assert.match(compactCss, /@media \(max-width: 360px\)[\s\S]*content: attr\(data-mobile-label\)/);
  assert.match(
    compactCss,
    /\.composer-toolbar \.runtime-default-btn,[\s\S]*\.composer-toolbar \.send-btn \{\s*min-height: 44px;/,
  );
  assert.match(compactCss, /\.composer-right \.model-control \{\s*flex: 1 1 96px;/);
  assert.match(compactCss, /\.project-create-button \{\s*width: 44px;\s*height: 44px;/);
  assert.match(contexts, /project-create-button"\s+type="button"\s+aria-label="New project"/);
  assert.match(
    compactCss,
    /\.chat-scroll \{\s*padding-right: max\(var\(--chat-pad\), env\(safe-area-inset-right\)\);\s*padding-left: max\(var\(--chat-pad\), env\(safe-area-inset-left\)\)/,
  );
  assert.match(
    compactCss,
    /\.pane \{\s*padding: calc\(28px \+ var\(--surface-safe-top\)\) max\(28px, env\(safe-area-inset-right\)\) calc\(40px \+ env\(safe-area-inset-bottom\)\) max\(28px, env\(safe-area-inset-left\)\)/,
  );
  assert.match(
    compactCss,
    /padding: calc\(20px \+ var\(--surface-safe-top\)\) max\(14px, env\(safe-area-inset-right\)\) calc\(32px \+ env\(safe-area-inset-bottom\)\) max\(14px, env\(safe-area-inset-left\)\)/,
  );
  assert.match(compactCss, /margin: 0 auto max\(18px, calc\(10px \+ env\(safe-area-inset-bottom\)\)\)/);
  assert.match(
    compactCss,
    /\.composer-wrap \{\s*width: auto;\s*margin-right: max\(16px, calc\(10px \+ env\(safe-area-inset-right\)\)\);\s*margin-left: max\(16px, calc\(10px \+ env\(safe-area-inset-left\)\)\)/,
  );
  assert.match(
    compactCss,
    /\.composer-wrap \{\s*margin-right: calc\(10px \+ env\(safe-area-inset-right\)\);\s*margin-bottom: calc\(10px \+ env\(safe-area-inset-bottom\)\);\s*margin-left: calc\(10px \+ env\(safe-area-inset-left\)\)/,
  );
});
