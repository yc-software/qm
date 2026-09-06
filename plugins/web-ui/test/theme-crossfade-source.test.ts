import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("theme toggle clicks are intercepted once at capture phase and replayed inside a view transition", () => {
  const fn = shell.match(/function crossfadeThemeSwitch\(e: MouseEvent\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(fn, /typeof document\.startViewTransition !== "function" \|\| reduceMotion\.matches\) return;/);
  assert.match(fn, /e\.target\.closest<ThemeCycler>\("theme-toggle"\) : null;/);
  assert.match(fn, /typeof toggle\.cycleTheme !== "function"\) return;/);
  assert.match(
    fn,
    /e\.stopImmediatePropagation\(\);\s*e\.preventDefault\(\);\s*document\.startViewTransition\(\(\) => toggle\.cycleTheme\?\.\(\)\);/,
  );
  assert.equal(shell.match(/document\.addEventListener\("click", crossfadeThemeSwitch, true\);/g)?.length, 1);
  assert.doesNotMatch(shell.match(/export function mountShell[\s\S]*?\n\}/)?.[0] ?? "", /crossfadeThemeSwitch/);
});

test("the root crossfade is opacity-only at 260ms and disabled under reduced motion", () => {
  assert.match(
    css,
    /::view-transition-old\(root\),\s*::view-transition-new\(root\) \{\s*animation-duration: 260ms;\s*animation-timing-function: ease-in-out;\s*\}/,
  );
  assert.doesNotMatch(css, /::view-transition[^{]*\{[^}]*mix-blend-mode/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*::view-transition-group\(\*\),\s*::view-transition-old\(\*\),\s*::view-transition-new\(\*\) \{\s*animation: none;\s*\}\s*\}/,
  );
});
