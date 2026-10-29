import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { messageRevision } from "../src/core/message-revisions.ts";
import { sleep } from "../src/util/async.ts";
import type { TurnRequest } from "../src/types.ts";

const actor = { externalId: "U1", displayName: "Ada" };
const rootTs = slackTs();

function slackTs(): string {
  return (Date.now() / 1000).toFixed(6);
}

function channelTurn(text: string, messageTs: string): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: `ch:C1:${rootTs}`, channelRef: "C1", audience: [actor] },
    text,
    origin: { kind: "human", messageTs },
  };
}

test("an edit the ingest path could not record is caught up at the end of the next turn", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "rev-")) }));
  try {
    const first = await built.app.turn(channelTurn("hello there", rootTs));
    assert.equal(first.status, "ok");
    const session = await built.sessions.getByThread(`ch:C1:${rootTs}`);
    assert.ok(session);

    await built.surfaceCache.ingest([
      { container: "C1", ts: rootTs, authorId: "U1", text: "hello there", createdAt: 1 },
    ]);
    await built.surfaceCache.ingest([
      { container: "C1", ts: rootTs, authorId: "U1", text: "hello there, edited", editedAt: Date.now() + 50 },
    ]);
    assert.equal(
      (await built.sessions.getEntries(session!.id)).filter((e) => messageRevision(e)).length,
      0,
      "nothing has recorded the edit yet",
    );

    const second = await built.app.turn(channelTurn("and again", slackTs()));
    assert.equal(second.status, "ok");
    const marks = (await built.sessions.getEntries(session!.id)).flatMap((e) => {
      const r = messageRevision(e);
      return r ? [r] : [];
    });
    assert.deepEqual(
      marks.map((m) => [m.action, m.ts, m.text]),
      [["edited", rootTs, "hello there, edited"]],
    );

    await sleep(60);
    const asked: number[] = [];
    const cache = built.surfaceCache;
    const revisedSince = cache.revisedSince.bind(cache);
    cache.revisedSince = async (container, since, opts) => {
      asked.push(since);
      return revisedSince(container, since, opts);
    };
    const third = await built.app.turn(channelTurn("once more", slackTs()));
    assert.equal(third.status, "ok");
    assert.equal(
      (await built.sessions.getEntries(session!.id)).filter((e) => messageRevision(e)).length,
      1,
      "the catch-up does not re-record on later turns",
    );
    const marker = (await built.sessions.getEntries(session!.id)).find((e) => messageRevision(e))!;
    assert.equal(asked.length, 1);
    assert.ok(asked[0]! <= marker.createdAt, "the turn right after a marker still re-checks it");
    const fourth = await built.app.turn(channelTurn("and once more", slackTs()));
    assert.equal(fourth.status, "ok");
    assert.equal(asked.length, 2);
    assert.ok(asked[1]! > marker.createdAt, "then the anchor has moved past the marker");
  } finally {
    await built.runtime.stop();
  }
});
