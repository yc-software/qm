import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildModelRuntime } from "../src/model/model-runtime.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";

test("a gateway-only session can switch models mid-turn across providers", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-switch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const from = getRequiredModel("claude-opus-4-5", false);
  const to = getRequiredModel("gpt-5", false);
  const modelRuntime = await buildModelRuntime(
    {},
    {
      url: "https://gateway.invalid",
      apiKey: "test-gateway-key",
      apiKeyHeader: "x-test-key",
      models: { [from.id]: "routed-from", [to.id]: "routed-to" },
    },
  );
  const { session } = await createAgentSession({
    model: from,
    modelRuntime,
    noTools: "builtin",
    sessionManager: SessionManager.inMemory(),
    cwd: dir,
    agentDir: dir,
  });
  await session.setModel(to);
  assert.equal(session.model?.id, to.id);
});
