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

const QUESTION = "can you summarize the time constraints discussed here for the customer workshop next month";

const SOUP = [
  { ts: "10.1", author: "bob", text: "the new gallery exhibit is open through the end of the month" },
  { ts: "10.2", author: "alice", text: "nice, my cousin is visiting then" },
  { ts: "10.3", author: "bob", text: "here is a poster you might like", files: ["gallery-poster.heic"] },
  { ts: "10.4", author: "alice", text: "", files: ["vacation-photo.jpg"] },
  { ts: "10.5", author: "alice", text: "a designer sent me an unrelated prototype" },
  { ts: "10.6", author: "alice", text: "should we choose dates for the customer workshop next month?" },
];

test("exemplar: a narrow question runs topic-scoped — no soup replay, no pushed files, history pullable", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-exemplar-topic-"));
  const built = buildApp(testConfig({ dataDir }));
  built.runtime.start();
  try {
    const channel = "C_TOPIC_FIXTURE";

    await built.app.ingestSurfaceEvents(
      SOUP.map((m, i) => ({
        container: channel,
        ts: m.ts,
        authorId: `U-${m.author}`,
        authorName: m.author,
        text: m.text,
        createdAt: i + 1,
      })),
      "slack",
      { name: "agent", mentionId: "U_BOT" },
    );

    const root = "20.1";
    const alice = { externalId: "U_ALICE", displayName: "alice" };
    const req: TurnRequest = {
      surface: "slack",
      actor: alice,
      conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [alice] },
      deliveryTarget: `slack:${channel}:${root}`,
      text: QUESTION,
      liveActor: true,
      async: true,
    };
    await built.app.turn(req);

    const deadline = Date.now() + 5_000;
    let entries: any[] = [];
    while (Date.now() < deadline) {
      const sub = await built.sessions.getByThread(`ch:${channel}:${root}`);
      if (sub) entries = await built.sessions.getEntries(sub.id);
      if (
        entries.some(
          (e: any) => e.type === "user" && String((e.payload as any)?.text ?? "").includes("time constraints"),
        )
      )
        break;
      await sleep(50);
    }
    const users = entries.filter((e: any) => e.type === "user").map((e: any) => e.payload as any);
    assert.ok(
      users.some((p) => (p.text ?? "").includes("time constraints") && p.name === "alice"),
      "the question is in its own thread session, attributed",
    );

    for (const m of SOUP) {
      if (!m.text) continue;
      assert.ok(
        !users.some((p) => (p.text ?? "").includes(m.text.slice(0, 40))),
        `overheard soup replayed into the session: ${m.text.slice(0, 60)}`,
      );
    }

    const allPayloads = entries.map((e: any) => JSON.stringify(e.payload ?? {}));
    for (const f of ["vacation-photo.jpg", "gallery-poster.heic"]) {
      assert.ok(!allPayloads.some((s) => s.includes(f)), `backscroll file pushed into the turn: ${f}`);
    }

    let fulfilling = true;
    const fulfiller = (async () => {
      while (fulfilling) {
        const pending = await (built.app as any).pendingContextRequests("slack");
        for (const r of pending)
          await (built.app as any).fulfillContextRequest(r.id, {
            result: { messages: SOUP.map((m) => ({ ts: m.ts, author: m.author, text: m.text })) },
          });
        await sleep(20);
      }
    })();
    const root2 = "21.1";
    await built.app.turn({
      surface: "slack",
      actor: alice,
      conversation: { kind: "channel", threadRef: `ch:${channel}:${root2}`, channelRef: channel, audience: [alice] },
      deliveryTarget: `slack:${channel}:${root2}`,
      text: "!whats_new",
      liveActor: true,
      async: true,
    });
    let pulled = false;
    const d2 = Date.now() + 5_000;
    while (Date.now() < d2 && !pulled) {
      const sub2 = await built.sessions.getByThread(`ch:${channel}:${root2}`);
      if (sub2) {
        const e2 = await built.sessions.getEntries(sub2.id);
        pulled = e2.some(
          (e: any) =>
            e.type === "tool_result" && (e.payload as any)?.tool === "whats_new" && (e.payload as any)?.ok === true,
        );
      }
      if (!pulled) await sleep(50);
    }
    fulfilling = false;
    await fulfiller;
    assert.ok(pulled, "the channel history is readable on demand (whats_new succeeded)");
  } finally {
    await built.runtime.stop();
  }
});
