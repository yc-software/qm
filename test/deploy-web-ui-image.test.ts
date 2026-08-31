import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("web UI assets build on the builder while the runtime stays on the deployment target", () => {
  const dockerfile = readFileSync(new URL("../deploy/web-ui/Dockerfile", import.meta.url), "utf8");
  const stages = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));

  assert.equal(stages.length, 2);
  assert.match(stages[0]!, /^FROM --platform=\$BUILDPLATFORM \S+ AS build$/);
  assert.doesNotMatch(stages[1]!, /--platform=/);
  assert.match(dockerfile, /^COPY --from=build \/app\/dist-web \.\/dist-web$/m);
});
