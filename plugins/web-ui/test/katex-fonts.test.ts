import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import viteConfig from "../vite.config.ts";

test("every KaTeX font URL in the pi-web-ui stylesheet resolves to a bundled font file", () => {
  const require = createRequire(import.meta.url);
  const css = readFileSync(join(dirname(require.resolve("@earendil-works/pi-web-ui/app.css")), "app.css"), "utf8");
  const urls = [...new Set([...css.matchAll(/url\((fonts\/KaTeX_[^)]+)\)/g)].map((m) => m[1]!))];
  assert.ok(urls.length > 0);
  const aliases = (viteConfig as { resolve: { alias: Array<{ find: string | RegExp; replacement: string }> } }).resolve
    .alias;
  for (const url of urls) {
    const alias = aliases.find((a) => a.find instanceof RegExp && a.find.test(url));
    assert.ok(alias, `${url} has an alias`);
    const resolved = url.replace(alias.find, alias.replacement);
    assert.ok(existsSync(resolved), `${url} -> ${resolved} exists`);
  }
});
