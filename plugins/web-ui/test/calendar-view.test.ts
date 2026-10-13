import assert from "node:assert/strict";
import test from "node:test";
import { deepLinkPath, parseDeepLink } from "../src/deep-link.ts";
import { documentTitle, PRODUCT_TITLE } from "../src/document-title.ts";

test("calendar has a stable route and document title", () => {
  assert.equal(deepLinkPath("", "calendar", null), "/calendar");
  assert.deepEqual(parseDeepLink("", "/calendar", ""), { view: "calendar", session: null, item: null });
  assert.equal(documentTitle("calendar"), `Calendar · ${PRODUCT_TITLE}`);
});
