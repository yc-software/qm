import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(import.meta.dirname, "../public/index.html"), "utf8");

test("the admin UI lists named environments and links attachment warnings", () => {
  assert.match(readFileSync(join(import.meta.dirname, "../ui/history.ts"), "utf8"), /Named environments/);
  assert.match(html, /id="environment-notice"/);
  assert.match(html, /Uses named environment/);
  assert.match(html, /scope: attachment\.environmentId/);
});
