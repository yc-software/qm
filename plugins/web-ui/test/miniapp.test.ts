import assert from "node:assert/strict";
import { test } from "node:test";
import {
  miniappsIn,
  miniappFrameSrc,
  miniappSourceSrc,
  formatMiniappHtml,
  parseMiniappUrl,
  stripMiniappDirectives,
} from "../src/miniapp.ts";

test("miniappsIn pulls title and url and stripMiniappDirectives removes the marker", () => {
  const text = "Here you go\n[[miniapp: https://qm.test/m/abc/def | Slope]]";
  const apps = miniappsIn(text);
  assert.equal(apps.length, 1);
  assert.equal(apps[0]!.title, "Slope");
  assert.equal(apps[0]!.url, "https://qm.test/m/abc/def");
  assert.equal(stripMiniappDirectives(text), "Here you go");
  assert.equal(stripMiniappDirectives("[[miniapp: sandbox:/mnt/user-data/outputs/x.html | Blocks]]"), "");
});

test("parseMiniappUrl rejects non-miniapp urls", () => {
  assert.equal(parseMiniappUrl("javascript:alert(1)"), null);
  assert.equal(parseMiniappUrl("https://evil.test/hack"), null);
  assert.equal(parseMiniappUrl("/m/aa/bb"), "/m/aa/bb");
});

test("miniappFrameSrc rewrites playground urls onto the ui origin", () => {
  const withBase = (p: string) => `/ui${p}`;
  assert.equal(miniappFrameSrc("/m/aa/bb", withBase), "/ui/m/aa/bb");
  assert.equal(miniappFrameSrc("https://qm.test/m/aa/bb", withBase), "/ui/m/aa/bb");
  assert.equal(miniappFrameSrc("/m/aa/bb", withBase, "light"), "/ui/m/aa/bb?theme=light");
  assert.equal(miniappSourceSrc("/ui/m/aa/bb?theme=light"), "/ui/m/aa/bb?theme=light&view=source");
});

test("formatMiniappHtml indents tags and keeps script blocks intact", () => {
  const formatted = formatMiniappHtml(
    "<!doctype html><html><head><style>body{margin:0}</style></head><body><h2>Hi</h2><canvas id=c></canvas><script>void 0</script></body></html>",
  );
  assert.match(formatted, /<html>\n/);
  assert.match(formatted, /^\s*<head>/m);
  assert.match(formatted, /<style>body\{margin:0\}<\/style>/);
  assert.match(formatted, /^\s*<body>/m);
  assert.match(formatted, /<h2>Hi<\/h2>/);
  assert.match(formatted, /<script>void 0<\/script>/);
  assert.match(formatted, /\n<\/html>$/);
});
