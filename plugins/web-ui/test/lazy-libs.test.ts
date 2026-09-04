import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import katexFacade from "../src/lazy-katex.ts";
import hljsFacade from "../src/lazy-hljs.ts";

test("katex facade renders math as escaped text before the real library loads", () => {
  const out = katexFacade.renderToString('x < y & "z"');
  assert.match(out, /^<span class="math-pending">/);
  assert.ok(out.includes("x &lt; y &amp; &quot;z&quot;"), "math text must be HTML-escaped");
  assert.ok(!out.includes("<y"), "no raw angle brackets survive");
});

test("hljs facade highlights as escaped plain text before the real library loads", () => {
  const out = hljsFacade.highlight('if (a < b) alert("hi");', { language: "javascript" });
  assert.equal(out.value, "if (a &lt; b) alert(&quot;hi&quot;);");
  const auto = hljsFacade.highlightAuto("<script>alert(1)</script>");
  assert.ok(!auto.value.includes("<script>"), "auto path must escape too");
});

test("hljs facade reports no language pre-load, so code-block takes the auto path", () => {
  assert.equal(hljsFacade.getLanguage("javascript"), undefined);
});

test("stub grammar registration is a safe no-op", () => {
  assert.doesNotThrow(() => hljsFacade.registerLanguage("javascript", () => ({})));
});

const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

test("vite aliases route katex and highlight.js through the lazy facades", () => {
  assert.match(vite, /find: \/\^katex\$\/, replacement: here\("src\/lazy-katex\.ts"\)/);
  assert.match(vite, /find: \/\^highlight\\\.js\\\/lib\\\/core\$\/, replacement: here\("src\/lazy-hljs\.ts"\)/);
  assert.match(
    vite,
    /find: \/\^highlight\\\.js\\\/lib\\\/languages\\\/\.\*\$\/, replacement: here\("src\/hljs-lang-stub\.ts"\)/,
  );
  const langOrder = ["javascript", "typescript", "python", "xml", "css", "json", "bash", "sql", "markdown"];
  for (const lang of langOrder) {
    assert.ok(vite.includes(`hljs-real-${lang}`), `real grammar alias for ${lang}`);
  }
});

test("the real-library aliases point INTO the packages, never back at the facades", () => {
  assert.match(vite, /find: "katex-real", replacement: here\("node_modules\/katex\/dist\/katex\.mjs"\)/);
  assert.match(vite, /find: "hljs-real", replacement: here\("node_modules\/highlight\.js\/lib\/core\.js"\)/);
});
