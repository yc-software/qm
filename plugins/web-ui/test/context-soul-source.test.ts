import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const contexts = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");
const soul = readFileSync(new URL("../src/context-soul.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");

test("project instructions render only for administrators", () => {
  assert.match(contexts, /c\.project && can\("admin"\) \? contextSoulSection/);
  assert.match(contexts, /if \(can\("admin"\).*\n\s*void loadContextSoul/);
});

test("project instructions use the scoped soul API", () => {
  assert.match(soul, /fetchScopeSoul\(scope\)/);
  assert.match(soul, /updateScopeSoul\(contextSoulState\.scope/);
  assert.match(server, /method === "GET" && path === "\/api\/soul"/);
  assert.match(server, /method === "PUT" && path === "\/api\/soul"/);
});
