import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("../deploy/web-ui/Dockerfile", import.meta.url), "utf8");
const buildStage = dockerfile.slice(0, dockerfile.indexOf("RUN npm run build"));

test("web UI image builds with its referenced static assets", () => {
  assert.match(buildStage, /^COPY plugins\/web-ui\/public \.\/public$/m);
  assert.match(
    buildStage,
    /^COPY docs\/images\/slack-app-config-token-setup\.gif \/docs\/images\/slack-app-config-token-setup\.gif$/m,
  );
});
