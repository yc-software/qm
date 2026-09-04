import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const REQUEST = "<@U_CAROL> can you review these drafts and flag anything I missed?";

test("exemplar: a thread reply addressed to a teammate arrives author-attributed and the turn may stay silent", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-exemplar-"));
  const built = buildApp(testConfig({ dataDir }));
  built.runtime.start();
  try {
    const channel = "C_DRAFT_FIXTURE";
    const root = "100.1";

    await built.app.ingestSurfaceEvents(
      [
        {
          container: channel,
          ts: root,
          authorId: "U_CAROL",
          authorName: "Carol",
          text: "<@U_BOT> create draft replies for these customers",
          createdAt: 1,
        },
        {
          container: channel,
          ts: "100.3",
          sub: root,
          authorId: "U_ALICE",
          authorName: "Alice",
          text: REQUEST,
          createdAt: 2,
        },
      ],
      "slack",
      { name: "agent", mentionId: "U_BOT" },
    );

    const req: TurnRequest = {
      surface: "slack",
      actor: { externalId: "U_ALICE", displayName: "Alice" },
      conversation: {
        kind: "channel",
        threadRef: `ch:${channel}:${root}`,
        channelRef: channel,
        audience: [{ externalId: "U_ALICE" }],
      },
      deliveryTarget: `slack:${channel}:${root}`,
      text: REQUEST,
      unprompted: true,
      async: true,
    };
    await built.app.turn(req);

    const deadline = Date.now() + 5_000;
    let trigger: any;
    while (Date.now() < deadline && !trigger) {
      const sub = await built.sessions.getByThread(`ch:${channel}:${root}`);
      if (sub) {
        const entries = await built.sessions.getEntries(sub.id);
        trigger = entries.find(
          (e: any) => e.type === "user" && String((e.payload as any)?.text ?? "").includes("review these drafts"),
        );
      }
      if (!trigger) await sleep(50);
    }
    assert.ok(trigger, "the message reached the turn's session");
    assert.equal((trigger.payload as any).name, "Alice", "the trigger is author-attributed");
    assert.equal((trigger.payload as any).text, REQUEST, "the message text is preserved");

    await sleep(500);
    assert.deepEqual(
      await built.deliveries.pending("slack"),
      [],
      "no delivery: the bot neither replied nor acted as Alice",
    );
  } finally {
    await built.runtime.stop();
  }
});
