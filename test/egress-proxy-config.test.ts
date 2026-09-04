import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("the egress data plane dials only the address vetted by authorization", () => {
  const config = readFileSync(new URL("../deploy/egress-proxy/envoy.yaml", import.meta.url), "utf8");
  assert.match(config, /x-egress-upstream-address/);
  assert.match(config, /type: ORIGINAL_DST/);
  assert.doesNotMatch(config, /dynamic_forward_proxy/);
});
