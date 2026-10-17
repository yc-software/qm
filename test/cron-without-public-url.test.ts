import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

// #1488: the web UI's New-cron pane asks the agent to create the cron. The agent's cron tool
// runs in-process against the control service, but the orchestrator only minted its control
// claims when PUBLIC_API_URL was configured (the URL sandboxes curl), so on a deployment
// without it the tool answered control_unavailable and the agent went hunting for
// AGENT_API_URL in the sandbox instead.
for (const apiBaseUrl of [undefined, "https://core.example.test"]) {
  test(`the agent's cron tool works ${apiBaseUrl ? "with" : "without"} a public self-API URL`, async () => {
    const built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "cron-no-url-")),
        signingSecret: "cron-no-url-secret",
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
      }),
    );
    const res = await built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "web:U1:new-cron" },
      text: "!cron-create Gmail unread digest",
    });
    assert.equal(res.status, "ok", res.reason);
    const id = /cron created: (\S+)/.exec(res.reply ?? "")?.[1];
    assert.ok(id, `expected a created cron, got: ${res.reply}`);
    assert.ok(await built.app.getCron(id!));
  });
}
