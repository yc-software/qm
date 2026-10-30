import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("../deploy/core/Dockerfile", import.meta.url), "utf8");
const webStage = dockerfile.slice(dockerfile.indexOf("AS web-ui-build"), dockerfile.indexOf("npm run build"));

test("the core image builds the web bundle with its referenced static assets", () => {
  assert.match(webStage, /^COPY plugins\/web-ui\/public \.\/public$/m);
  assert.match(
    webStage,
    /^COPY docs\/images\/slack-app-config-token-setup\.gif \/app\/docs\/images\/slack-app-config-token-setup\.gif$/m,
  );
});
