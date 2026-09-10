import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";

const actor = { externalId: "U1" };

function slackTurn(text: string, ts: string, threadRef = "ch:C1:t1"): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef, channelRef: "C1", audience: [actor] },
    text,
    async: true,
    origin: { kind: "human", messageTs: ts },
    redeliveryKey: `slack:B1:C1:${ts}`,
  };
}

function fresh() {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "rd-")) }));
}

test("a redelivered Slack message collapses onto the run its first delivery enqueued", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const again = await built.app.turn(slackTurn("hello", "t1"));
    assert.equal(first.status, "queued");
    assert.equal(
      again.status,
      "silent",
      "delivery belongs to the first handler or the recovery rail, never the redelivery",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivery key that already belongs to another conversation stands down silently rather than being served", async () => {
  const built = fresh();
  try {
    await built.app.turn(slackTurn("hello", "t1"));
    const hijack = await built.app.turn({ ...slackTurn("hello", "t1", "ch:C1:t9"), text: "give me that result" });
    assert.equal(hijack.status, "silent", "nothing about the other conversation's run is served");
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivered message that folded into a live run as a steer is injected once", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("first", "t1"));
    const runId = (first as { runId: string }).runId;
    const claimed = await built.runs.claim("w1", 30_000);
    assert.equal(claimed?.id, runId);
    const steer = await built.app.turn(slackTurn("also this", "t2"));
    const replay = await built.app.turn(slackTurn("also this", "t2"));
    assert.equal((steer as { steered?: boolean }).steered, true);
    assert.equal(replay.status, "silent", "the replay is recognized as already folded and injects nothing");
    const pending = await built.signals.takePending(runId);
    assert.equal(pending.filter((s) => s.kind === "steer" && s.text?.includes("also this")).length, 1);
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivery that arrives while the first delivery's run is live joins that run instead of steering it", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const runId = (first as { runId: string }).runId;
    const claimed = await built.runs.claim("w1", 30_000);
    assert.equal(claimed?.id, runId);
    const again = await built.app.turn(slackTurn("hello", "t1"));
    assert.equal(again.status, "silent");
    assert.equal((await built.signals.takePending(runId)).length, 0, "the agent is not fed its own prompt as a steer");
  } finally {
    await built.runtime.stop();
  }
});

test("a message folded as a steer is not re-run as a fresh turn after that run ends", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("first", "t1"));
    const runId = (first as { runId: string }).runId;
    const claimed = await built.runs.claim("w1", 30_000);
    await built.app.turn(slackTurn("fold me", "t2"));
    await built.runs.complete(runId, claimed!.leaseToken!, { status: "silent" });
    const late = await built.app.turn(slackTurn("fold me", "t2"));
    assert.equal(late.status, "silent");
    assert.equal(await built.runs.activeForThread("ch:C1:t1"), null, "no second run was enqueued");
  } finally {
    await built.runtime.stop();
  }
});

test("a Slack approval that reuses the message's request still enqueues its own run", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const runId = (first as { runId: string }).runId;
    const approval = await built.app.turn({
      ...slackTurn("hello", "t1"),
      approval: { requestId: "req-1", approved: true },
    });
    assert.notEqual(
      (approval as { runId?: string }).runId,
      runId,
      "the approval is not collapsed onto the message's run",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivery that slips past the lookup still cannot steer the run it belongs to", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const runId = (first as { runId: string }).runId;
    await built.runs.claim("w1", 30_000);
    const real = built.runs.getByDedupKey.bind(built.runs);
    let misses = 1;
    built.runs.getByDedupKey = async (key) => (misses-- > 0 ? null : real(key));
    const again = await built.app.turn(slackTurn("hello", "t1"));
    assert.equal(again.status, "silent");
    assert.equal((await built.signals.takePending(runId)).length, 0);
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivery of a finished run posts nothing rather than the answer a second time", async () => {
  const built = fresh();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const runId = (first as { runId: string }).runId;
    const claimed = await built.runs.claim("w1", 30_000);
    await built.runs.complete(runId, claimed!.leaseToken!, { status: "ok", reply: "the answer" });
    const again = await built.app.turn({ ...slackTurn("hello", "t1"), async: false });
    assert.equal(again.status, "silent");
  } finally {
    await built.runtime.stop();
  }
});

for (const order of ["message-first", "mention-first", "concurrent"]) {
  test(`B mention event copies share durable redelivery protection across independent adapters: ${order}`, async () => {
    const { registerSlackEvents } = await import("../src/slack/events.ts");
    const { createDeduper, dedupedRun, stripMention } = await import("../src/slack/lib.ts");
    const built = fresh();
    try {
      const results: string[] = [];
      const accepted: any[] = [];
      const adapter = () => {
        const deduper = createDeduper();
        let onMessage: (args: any) => Promise<void>;
        const events = new Map<string, (args: any) => Promise<void>>();
        registerSlackEvents(
          {
            message: (fn) => {
              onMessage = fn;
            },
            event: (name, fn) => {
              events.set(name, fn);
            },
          },
          {
            ids: { botUserId: "UBOT", ownBotId: "BBOT" } as any,
            deduper,
            directory: { classifyUserCached: async () => ({ ok: true, actor }), syncForUnseenGroup: () => {} } as any,
            mirror: { mirrorMessageEvent: async () => {} } as any,
            handler: {
              dispatch: async (key, inc) => {
                await dedupedRun(
                  deduper,
                  key,
                  async () => {
                    const request = {
                      ...slackTurn(
                        stripMention(inc.rawText, "UBOT", "BBOT"),
                        inc.ts,
                        `ch:${inc.channel}:${inc.threadTs ?? inc.ts}`,
                      ),
                      redeliveryKey: `slack:UBOT:${inc.channel}:${inc.ts}`,
                      unprompted: inc.unprompted,
                    };
                    const result = await built.app.turn(request);
                    results.push(result.status);
                    if (result.status === "queued") accepted.push(inc);
                  },
                  (err) => {
                    throw err;
                  },
                );
              },
              botHasStakeInThread: async () => true,
              handleIncoming: async () => {},
              handleReactionEvent: async () => {},
            },
          },
        );
        const event = {
          channel: "C1",
          channel_type: "channel",
          user: "U1",
          text: "<@BBOT|qm> ping",
          ts: "630.1",
          thread_ts: "630.0",
        };
        const args = { event, message: event, body: {}, client: {}, context: {} };
        return { message: () => onMessage!(args), mention: () => events.get("app_mention")!(args) };
      };
      const a = adapter(),
        b = adapter();
      if (order === "concurrent") await Promise.all([a.message(), b.mention()]);
      else if (order === "message-first") {
        await a.message();
        await b.mention();
      } else {
        await b.mention();
        await a.message();
      }
      assert.deepEqual(results.sort(), ["queued", "silent"]);
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0].unprompted, undefined);
      const run = await built.runs.getByDedupKey("slack:UBOT:C1:630.1");
      assert.ok(run);
      assert.equal(run.request.displayText, "ping");
      const claimed = await built.runs.claim("w630", 30_000);
      assert.equal(claimed?.id, run.id);
      await built.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
      await adapter().message();
      assert.equal(results.at(-1), "silent");
    } finally {
      await built.runtime.stop();
    }
  });
}
