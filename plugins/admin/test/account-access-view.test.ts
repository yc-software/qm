import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("the users surface shows deactivation state and offers recovery", () => {
  assert.match(html, /users\.filter\(\(u\) => u\.deactivation\)\.length, "Deactivated"/);
  assert.match(html, /label: "Reactivate"/);
  assert.match(html, /"Account access"/);
  assert.match(html, /"Reactivate account"/);
  assert.match(html, /impersonate\.disabled = true/);
  assert.match(html, /Reactivate this account before impersonating it/);
  assert.match(html, /st-user-access-list/);
  assert.match(html, /catch \(e\)[\s\S]*Reactivation failed/);
  assert.match(html, /finally \{[\s\S]*reactivate\.disabled = false/);
  assert.match(html, /\/reactivate/);
});
