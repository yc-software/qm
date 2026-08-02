import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const CATALOG_FILES = ["zh-CN.json", "ja.json", "ko.json"];
const T_CALL = /(?:^|[^\w$.])t\(\s*"((?:[^"\\]|\\.)*)"/g;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) yield path;
  }
}

function usedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of walk(srcDir)) {
    if (file.includes(`${join("locales", "")}`)) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(T_CALL)) {
      keys.add(JSON.parse(`"${match[1]}"`) as string);
    }
  }
  return keys;
}

function catalog(name: string): Record<string, string> {
  return JSON.parse(readFileSync(join(srcDir, "locales", name), "utf8")) as Record<string, string>;
}

test("every t() key is translated in every catalog, with no stale keys", () => {
  const keys = usedKeys();
  for (const name of CATALOG_FILES) {
    const entries = catalog(name);
    const missing = [...keys].filter((key) => !(key in entries));
    const stale = Object.keys(entries).filter((key) => !keys.has(key));
    assert.deepEqual(missing, [], `${name} is missing translations for: ${missing.join(", ")}`);
    assert.deepEqual(stale, [], `${name} has stale keys: ${stale.join(", ")}`);
  }
});

test("catalog values are non-empty strings", () => {
  for (const name of CATALOG_FILES) {
    for (const [key, value] of Object.entries(catalog(name))) {
      assert.equal(typeof value, "string");
      assert.ok(value.trim().length > 0, `${name}: empty translation for ${key}`);
    }
  }
});

test("every placeholder in a key survives in its translation", () => {
  for (const name of CATALOG_FILES) {
    for (const [key, value] of Object.entries(catalog(name))) {
      for (const match of key.matchAll(/\{(\w+)\}/g)) {
        assert.ok(value.includes(match[0]), `${name}: ${match[0]} lost in translation of ${key}`);
      }
    }
  }
});
