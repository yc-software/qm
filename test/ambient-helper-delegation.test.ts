import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { settle } from "./support/settle.ts";
import type { Agent } from "../src/agent/agent.ts";
import { ambientActorId } from "../src/resolution/ambient-wake.ts";
import { slackSurfaceOrigin } from "../src/surfaces/slack/adapter.ts";

test("an unprompted wake's helper runs in its channel and reports back, out of other wakes' reach", async () => {
  let helper = "";
  const seen: unknown[] = [];
  const agent: Agent = {
    async runTurn(turn) {
      const tools = turn.tools.sessionSyscalls!;
      if (turn.session.parentSessionId) return { reply: "memo found", modelCalls: 1 };
      if (!helper) helper = await tools.open({ task: "find the memo" }).then((o) => (o.ok ? o.sessionId : o.message));
      else if (turn.session.threadRef.endsWith(":2")) seen.push(await tools.write({ target: helper, text: "stop" }));
      else seen.push(...(await tools.receive!(0)).map((m) => m.text));
      return { reply: "done", modelCalls: 1 };
    },
  };
  const built = buildApp(testConfig({ workers: 1 }), { agent });
  built.runtime.start();
  const wake = (ts: string) =>
    built.app
      .turn({
        surface: "slack",
        surfaceOrigin: slackSurfaceOrigin({ accountId: "default", teamId: "T1", userId: "U0" }),
        actor: { externalId: ambientActorId() },
        conversation: { kind: "channel", threadRef: `slack:C1:ambient:${ts}`, channelRef: "C1", audience: [] },
        text: "a deal came up",
        origin: { kind: "automation" },
        async: true,
      })
      .then((queued) => built.runs.waitFor(queued.runId!, 60_000));
  await wake("1");
  await settle(async () => seen.length > 0);
  await wake("2");
  assert.match(String(seen[0]), /<content>memo found<\/content>/, helper);
  assert.deepEqual(seen[1], { ok: false, message: "you no longer have access to the target session" });
});
