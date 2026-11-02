import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("../deploy/core/Dockerfile", import.meta.url), "utf8");
const buildStage = dockerfile.slice(dockerfile.indexOf("AS web-ui-build"), dockerfile.indexOf("RUN npm run build"));

test("core image builds the web UI with its referenced static assets", () => {
  assert.match(buildStage, /^COPY plugins\/web-ui\/public \.\/public$/m);
  assert.match(
    buildStage,
    /^COPY docs\/images\/slack-app-config-token-setup\.gif \/app\/docs\/images\/slack-app-config-token-setup\.gif$/m,
  );
});
