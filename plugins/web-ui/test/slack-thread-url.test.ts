import { test } from "node:test";
import assert from "node:assert/strict";
import { slackThreadUrl } from "../src/core-bridge.ts";

test("slackThreadUrl builds archive permalinks from threadRefs", () => {
  const base = "https://acme.slack.com";
  assert.equal(slackThreadUrl(base, "ch:C0AB12CD3:1699999999.000100"), `${base}/archives/C0AB12CD3/p1699999999000100`);
  assert.equal(slackThreadUrl(base, "dm:D0AB12CD3"), `${base}/archives/D0AB12CD3`);
  assert.equal(slackThreadUrl(null, "dm:D0AB12CD3"), null, "no workspace URL → no link");
  assert.equal(slackThreadUrl(base, "web:alice:t1"), null, "web threadRefs are not Slack-linkable");
});
