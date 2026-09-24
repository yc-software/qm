import assert from "node:assert/strict";
import { readAdminSource } from "./admin-source.ts";
import test from "node:test";

const html = readAdminSource();

test("view services wrap window.confirm instead of passing it detached", () => {
  assert.doesNotMatch(html, /^\s+confirm,\s*$/m);
  assert.equal(html.match(/confirm: \(message\) => window\.confirm\(message\)/g)?.length, 2);
});

test("calling services.confirm as a method reaches window.confirm", () => {
  const seen: string[] = [];
  const services = { confirm: (message: string) => window.confirm(message) };
  (globalThis as any).window = { confirm: (m: string) => (seen.push(m), true) };
  try {
    assert.equal(services.confirm("Make x an org admin?"), true);
    assert.deepEqual(seen, ["Make x an org admin?"]);
  } finally {
    delete (globalThis as any).window;
  }
});
