import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  contrast,
  importTheme,
  isPalette,
  parseHex,
  stripJsonc,
  themeCss,
  themeTokens,
  type Palette,
} from "../src/theme-import.ts";

const shellCss = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const baseCss = readFileSync(
  new URL("../node_modules/@earendil-works/pi-web-ui/dist/app.css", import.meta.url),
  "utf8",
);

function plistColor(key: string, r: number, g: number, b: number): string {
  return `<key>${key}</key><dict>
    <key>Alpha Component</key><real>1</real>
    <key>Blue Component</key><real>${b}</real>
    <key>Color Space</key><string>sRGB</string>
    <key>Green Component</key><real>${g}</real>
    <key>Red Component</key><real>${r}</real>
  </dict>`;
}

const solarizedDark = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${plistColor("Ansi 0 Color", 0.0275, 0.2118, 0.2588)}
${plistColor("Ansi 1 Color", 0.8627, 0.1961, 0.1843)}
${plistColor("Ansi 2 Color", 0.5216, 0.6, 0)}
${plistColor("Ansi 3 Color", 0.7098, 0.5373, 0)}
${plistColor("Ansi 4 Color", 0.149, 0.5451, 0.8235)}
${plistColor("Ansi 5 Color", 0.8275, 0.2118, 0.5098)}
${plistColor("Ansi 6 Color", 0.1647, 0.6314, 0.5961)}
${plistColor("Ansi 7 Color", 0.9333, 0.9098, 0.8353)}
${plistColor("Ansi 8 Color", 0, 0.1686, 0.2118)}
${plistColor("Background Color", 0, 0.1686, 0.2118)}
${plistColor("Foreground Color", 0.5137, 0.5804, 0.5882)}
${plistColor("Cursor Color", 0.5137, 0.5804, 0.5882)}
${plistColor("Link Color", 0.0, 0.4, 0.8)}
</dict></plist>`;

test("an iTerm2 preset parses its 0–1 float components into 8-bit colours", () => {
  const palette = importTheme("Solarized Dark.itermcolors", solarizedDark);
  assert.equal(palette.source, "iterm2");
  assert.equal(palette.name, "Solarized Dark");
  assert.deepEqual(palette.background, { r: 0, g: 43, b: 54 });
  assert.deepEqual(palette.foreground, { r: 131, g: 148, b: 150 });
  assert.deepEqual(palette.ansi[1], { r: 220, g: 50, b: 47 });
  assert.equal(palette.ansi[9], null, "missing ANSI slots stay empty rather than inventing a colour");
  assert.deepEqual(palette.link, { r: 0, g: 102, b: 204 });
});

test("a preset that keeps separate light and dark colours falls back to its dark set", () => {
  const xml = `<plist><dict>
    <key>Use Separate Colors for Light and Dark Mode</key><true/>
    ${plistColor("Background Color (Dark)", 0.1, 0.1, 0.1)}
    ${plistColor("Foreground Color (Dark)", 0.9, 0.9, 0.9)}
    ${plistColor("Background Color (Light)", 1, 1, 1)}
    ${plistColor("Foreground Color (Light)", 0, 0, 0)}
  </dict></plist>`;
  const palette = importTheme("dual.itermcolors", xml);
  assert.deepEqual(palette.background, { r: 26, g: 26, b: 26 });
  assert.deepEqual(palette.foreground, { r: 230, g: 230, b: 230 });
});

test("a plist without a background and foreground is rejected with a plain explanation", () => {
  assert.throws(
    () => importTheme("x.itermcolors", `<plist><dict>${plistColor("Ansi 0 Color", 0, 0, 0)}</dict></plist>`),
    /Background Color and a Foreground Color/,
  );
  assert.throws(() => importTheme("x.itermcolors", "bplist00\0\0"), /binary plist/);
});

const vsCodeTheme = `{
  // Dracula-ish, with the comments and trailing commas VS Code tolerates
  "name": "Night Test",
  "type": "dark",
  "colors": {
    "editor.background": "#282a36",
    "editor.foreground": "#f8f8f2",
    "sideBar.background": "#21222c",
    "button.background": "#bd93f9",
    "textLink.foreground": "#8be9fd",
    "editor.selectionBackground": "#44475a80", /* alpha, composited over the editor */
    "terminal.ansiRed": "#ff5555",
    "terminal.ansiGreen": "#50fa7b",
  },
  "tokenColors": [
    { "scope": "comment", "settings": { "foreground": "#6272a4" } },
    { "scope": ["keyword", "storage.type"], "settings": { "foreground": "#ff79c6" } },
    { "scope": "string", "settings": { "foreground": "#f1fa8c", }, },
    { "scope": "entity.name.function", "settings": { "foreground": "#50fa7b" } },
    { "scope": "entity.name", "settings": { "foreground": "#ffffff" } },
  ],
}`;

test("a VS Code theme parses through its comments and trailing commas and takes its own name", () => {
  const palette = importTheme("night-test-color-theme.json", vsCodeTheme);
  assert.equal(palette.source, "vscode");
  assert.equal(palette.name, "Night Test");
  assert.equal(palette.kind, "dark");
  assert.deepEqual(palette.background, { r: 40, g: 42, b: 54 });
  assert.deepEqual(palette.sidebar, { r: 33, g: 34, b: 44 });
  assert.deepEqual(palette.button, { r: 189, g: 147, b: 249 });
  assert.deepEqual(palette.ansi[1], { r: 255, g: 85, b: 85 });
  assert.equal(palette.ansi[4], null);
});

test("VS Code token scopes pick the most specific matching rule", () => {
  const palette = importTheme("t.json", vsCodeTheme);
  assert.deepEqual(palette.syntax?.keyword, { r: 255, g: 121, b: 198 });
  assert.deepEqual(palette.syntax?.entity, { r: 80, g: 250, b: 123 }, "entity.name.function beats entity.name");
  assert.deepEqual(palette.syntax?.comment, { r: 98, g: 114, b: 164 });
  assert.deepEqual(palette.syntax?.tag, { r: 255, g: 255, b: 255 }, "entity.name covers entity.name.tag");
});

test("a colour with a malformed component is dropped instead of leaking NaN into the CSS", () => {
  const xml = `<plist><dict>
    <key>Background Color</key><dict><key>Red Component</key><real>.</real><key>Green Component</key><real>0</real><key>Blue Component</key><real>0</real></dict>
    ${plistColor("Foreground Color", 1, 1, 1)}
  </dict></plist>`;
  assert.throws(() => importTheme("nan.itermcolors", xml), /Background Color and a Foreground Color/);
});

test("integer plist components are as good as reals", () => {
  const xml = `<plist><dict>
    <key>Background Color</key><dict><key>Red Component</key><integer>0</integer><key>Green Component</key><integer>0</integer><key>Blue Component</key><integer>1</integer></dict>
    ${plistColor("Foreground Color", 1, 1, 1)}
  </dict></plist>`;
  assert.deepEqual(importTheme("int.itermcolors", xml).background, { r: 0, g: 0, b: 255 });
});

test("a BOM, a trailing comma before a comment, and a null token rule are all tolerated", () => {
  const text = `\uFEFF{"type": "dark", "colors": {"editor.background": "#101010", // last
  }, "tokenColors": [null, {"scope": [1, "keyword"], "settings": {"foreground": "#ff0000"}}], /* end */ }`;
  const palette = importTheme("bom.json", text);
  assert.deepEqual(palette.background, { r: 16, g: 16, b: 16 });
  assert.deepEqual(palette.syntax?.keyword, { r: 255, g: 0, b: 0 });
});

test("a theme name is capped so the settings radio stays a label", () => {
  const long = "x".repeat(500);
  assert.equal(importTheme("t.json", `{"name": "${long}", "type": "dark"}`).name.length, 60);
  assert.equal(importTheme(`${long}.itermcolors`, solarizedDark).name.length, 60);
});

test("garbage is rejected with a message that names both accepted formats", () => {
  assert.throws(() => importTheme("notes.json", "hello there"), /iTerm2 \.itermcolors or a VS Code color theme/);
  assert.throws(() => importTheme("empty.json", "{}"), /editor\.background/);
});

test("stripJsonc leaves comment-looking text inside strings alone", () => {
  assert.equal(stripJsonc('{"url": "http://x//y", /* c */ "a": [1,], }'), '{"url": "http://x//y",  "a": [1] }');
});

test("parseHex takes every CSS hex length and reports alpha", () => {
  assert.deepEqual(parseHex("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseHex("#f008"), { r: 255, g: 0, b: 0, a: 0x88 / 255 });
  assert.deepEqual(parseHex("#282a36"), { r: 40, g: 42, b: 54, a: 1 });
  assert.equal(parseHex("#282a3680")?.a, 128 / 255);
  assert.equal(parseHex("red"), undefined);
  assert.equal(parseHex("#12345"), undefined);
});

function darkTokenNames(css: string): string[] {
  return [...css.matchAll(/\.dark\s*\{([^}]*)\}/g)].flatMap((block) =>
    [...block[1].matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1]),
  );
}

const NON_COLOUR_TOKENS = /^--(font|shadow|radius|spacing|tracking|chart)/;

test("an imported palette fills every colour slot the dark theme fills, so nothing bleeds through", () => {
  const palette = importTheme("Solarized Dark.itermcolors", solarizedDark);
  const { vars } = themeTokens(palette);
  const expected = [...darkTokenNames(baseCss), ...darkTokenNames(shellCss)].filter(
    (name) => !NON_COLOUR_TOKENS.test(name),
  );
  assert.ok(expected.includes("--background") && expected.includes("--syntax-keyword"));
  assert.ok(expected.includes("--primary") && expected.includes("--destructive"), "both pi .dark blocks are read");
  const missing = expected.filter((name) => !(name in vars));
  assert.deepEqual(missing, []);
  for (const value of Object.values(vars)) assert.match(value, /^#[0-9a-f]{6}$/);
});

test("a dark terminal palette turns dark mode on; a light one turns it off", () => {
  const dark = themeTokens(importTheme("d.itermcolors", solarizedDark));
  assert.equal(dark.dark, true);
  assert.equal(dark.vars["--background"], "#002b36");
  assert.equal(dark.vars["--foreground"], "#839496");
  const light = themeTokens({
    ...importTheme("d.itermcolors", solarizedDark),
    background: { r: 253, g: 246, b: 227 },
    foreground: { r: 101, g: 123, b: 131 },
  });
  assert.equal(light.dark, false);
  assert.notEqual(light.vars["--card"], light.vars["--background"], "cards still separate from the page");
});

test("a VS Code theme's declared type wins over guessing from the background", () => {
  const palette: Palette = {
    ...importTheme("t.json", vsCodeTheme),
    kind: "light",
  };
  assert.equal(themeTokens(palette).dark, false);
});

test("accent colours that would vanish against the background are pulled toward the text", () => {
  const palette = importTheme("Solarized Dark.itermcolors", solarizedDark);
  const { vars } = themeTokens(palette);
  const bg = palette.background;
  const commentHex = vars["--syntax-comment"];
  const comment = parseHex(commentHex);
  assert.ok(comment);
  assert.ok(contrast(comment, bg) >= 3, `comment ${commentHex} is still legible on ${vars["--background"]}`);
  for (const name of ["--primary", "--destructive", "--syntax-string", "--working-dot"]) {
    const color = parseHex(vars[name]);
    assert.ok(color && contrast(color, bg) >= 3, `${name} ${vars[name]} must be readable`);
  }
});

test("the VS Code button colour drives the buttons and the sidebar colour drives the rail", () => {
  const { vars } = themeTokens(importTheme("t.json", vsCodeTheme));
  assert.equal(vars["--cta"], "#bd93f9");
  assert.equal(vars["--primary"], "#bd93f9");
  assert.equal(vars["--sidebar"], "#21222c");
  assert.equal(vars["--syntax-keyword"], "#ff79c6");
  assert.equal(vars["--syntax-tag"], "#ffffff");
  const withoutScopes = themeTokens({ ...importTheme("t.json", vsCodeTheme), syntax: {} });
  assert.equal(withoutScopes.vars["--syntax-tag"], "#ff5555", "with no tag scope the terminal red stands in");
});

test("the theme is emitted as one html:root rule so it beats both :root and .dark", () => {
  const css = themeCss(themeTokens(importTheme("t.json", vsCodeTheme)));
  assert.match(css, /^html:root\{--background:#282a36;/);
  assert.match(css, /color-scheme:dark;\}/, "native scrollbars and form controls follow the palette");
  assert.doesNotMatch(css, /[<>]/);
});

test("text selection takes the terminal's selection colours, and stays readable without them", () => {
  const withSelection = `<plist><dict>
    ${plistColor("Background Color", 0, 0, 0)}
    ${plistColor("Foreground Color", 1, 1, 1)}
    ${plistColor("Selection Color", 0.2, 0.4, 0.6)}
    ${plistColor("Selected Text Color", 1, 1, 0)}
  </dict></plist>`;
  const tokens = themeTokens(importTheme("sel.itermcolors", withSelection));
  assert.equal(tokens.vars["--selection"], "#336699");
  assert.match(themeCss(tokens), /::selection\{background:var\(--selection\);color:#ffff00;\}$/);
  const vsCode = themeCss(themeTokens(importTheme("t.json", vsCodeTheme)));
  assert.match(vsCode, /::selection\{background:var\(--selection\);\}$/, "no selection text colour means inherit");
  assert.equal(
    themeTokens(importTheme("t.json", vsCodeTheme)).vars["--selection"],
    "#363948",
    "alpha composited over the editor",
  );
});

test("status colours come from the terminal's green and yellow", () => {
  const { vars } = themeTokens(importTheme("Solarized Dark.itermcolors", solarizedDark));
  assert.equal(vars["--success"], "#859900");
  assert.equal(vars["--warning"], "#b58900");
});

test("a stored palette is only trusted when it still has the shape we wrote", () => {
  const palette = importTheme("t.json", vsCodeTheme);
  assert.ok(isPalette(JSON.parse(JSON.stringify(palette))));
  assert.equal(isPalette({ ...palette, ansi: [] }), false);
  assert.equal(isPalette({ ...palette, background: "#fff" }), false);
  assert.equal(isPalette({ ...palette, background: { r: 12.5, g: 0, b: 0 } }), false);
  assert.equal(isPalette({ ...palette, background: { r: 256, g: 0, b: 0 } }), false);
  assert.equal(isPalette(null), false);
  assert.equal(isPalette("Solarized"), false);
});
