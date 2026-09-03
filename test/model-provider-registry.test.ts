import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_PROVIDERS as CLI_MODEL_PROVIDERS } from "../cli/src/config.ts";
import { KNOWN_PROVIDERS as WEB_MODEL_PROVIDERS } from "../plugins/web-ui/src/model-providers.ts";
import { MODEL_PROVIDERS } from "../src/model/pi-models.ts";
import { PROVIDER_IDS } from "../src/model/provider-endpoints.ts";

test("model provider registries agree across core, CLI, endpoints, and web", () => {
  assert.deepEqual([...CLI_MODEL_PROVIDERS], [...MODEL_PROVIDERS]);
  assert.deepEqual([...PROVIDER_IDS], [...MODEL_PROVIDERS]);
  assert.deepEqual([...WEB_MODEL_PROVIDERS], [...MODEL_PROVIDERS]);
});
