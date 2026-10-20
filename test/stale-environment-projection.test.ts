import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructMessagesFromHistory, withoutStaleSnapshots } from "../src/harness/replay.ts";
import { foldTape, planTapeSeed } from "../src/harness/tape-fold.ts";
import { environmentNote } from "../src/core/attachments.ts";
import { CONTEXT_SUMMARY_HEADER } from "../src/harness/context-compaction.ts";
import type { TapeRecord } from "../src/sessions/session-store.ts";
import type { SessionEntry } from "../src/types.ts";

const snapshot = (n: number) => `## Already scheduled here\n- cron OLD-${n}\n\n## The user's local time\nclock ${n}`;
const environment = (n: number, snap = snapshot(n)) =>
  environmentNote(
    [
      `The user shared 1 file: inbox/f${n}.txt`,
      `This message is from @alice${n}.`,
      snap,
      `## What you remember\n- fact ${n}`,
    ].join("\n\n"),
  );
const user = (seq: number, n: number, snap = snapshot(n)) =>
  ({
    seq,
    type: "user",
    createdAt: seq,
    scopeLabel: "personal:u",
    payload: { text: `ask ${n}`, environment: environment(n, snap), stateSnapshot: snap, runId: `run-${n}` },
  }) as unknown as SessionEntry;
const reply = (seq: number) =>
  ({
    seq,
    type: "assistant",
    createdAt: seq,
    scopeLabel: "personal:u",
    payload: { text: "ok" },
  }) as unknown as SessionEntry;
const summary = (seq: number) =>
  ({
    seq,
    type: "system",
    createdAt: seq,
    scopeLabel: "personal:u",
    payload: { kind: "context_summary", throughSeq: 0, text: "earlier work" },
  }) as unknown as SessionEntry;
const compacted = [user(1, 1), reply(2), user(3, 2), reply(4), summary(5), user(6, 3), reply(7)];

const userTexts = (messages: readonly unknown[]) =>
  messages
    .filter((m) => (m as { role: string }).role === "user")
    .map((m) => (m as { content: Array<{ text: string }> }).content.map((b) => b.text).join(""))
    .map((text) => text.replace(`${CONTEXT_SUMMARY_HEADER}\nearlier work`, "").trim())
    .filter(Boolean);

function assertProjected(texts: string[]) {
  assert.equal(texts.length, 3);
  for (const [i, text] of texts.entries()) {
    const n = i + 1;
    assert.match(text, new RegExp(`ask ${n}`));
    assert.match(text, new RegExp(`inbox/f${n}\\.txt`));
    assert.match(text, new RegExp(`@alice${n}`));
    assert.match(text, new RegExp(`fact ${n}`));
    assert.match(text, /<environment>[\s\S]*<\/environment>/);
  }
  assert.doesNotMatch(texts[0]!, /cron OLD|clock/);
  assert.doesNotMatch(texts[1]!, /cron OLD|clock/);
  assert.match(texts[2]!, /cron OLD-3[\s\S]*clock 3/);
}

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const tapeRows = (harness: string): TapeRecord[] =>
  compacted
    .filter((e) => e.type !== "system")
    .map(
      (e) =>
        ({
          kind: "message",
          harness,
          createdAt: e.createdAt,
          scopeLabel: "personal:u",
          payload:
            e.type === "user"
              ? {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `${(e.payload as { text: string }).text}\n\n${(e.payload as { environment: string }).environment}`,
                    },
                  ],
                  timestamp: e.createdAt,
                }
              : {
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                  timestamp: e.createdAt,
                  stopReason: "stop",
                  usage: { ...zero, cost: { ...zero, total: 0 } },
                },
        }) as unknown as TapeRecord,
    );

test("after compaction a rebuilt history drops the kept turns' state snapshots and keeps their files, speaker and memory", () => {
  assertProjected(userTexts(withoutStaleSnapshots(reconstructMessagesFromHistory(compacted), compacted)));
});

test("after compaction the recorded model messages drop the kept turns' state snapshots", () => {
  const rows = tapeRows("pi");
  assertProjected(userTexts(withoutStaleSnapshots(foldTape(rows), compacted)));
  assert.match(userTexts(foldTape(rows))[0]!, /cron OLD-1/);
});

test("after a harness switch the rebuilt history still names who spoke", () => {
  assert.equal(planTapeSeed(tapeRows("codex"), "pi", "serve").seed, null);
  assertProjected(userTexts(withoutStaleSnapshots(reconstructMessagesFromHistory(compacted), compacted)));
});

test("between compactions every turn replays exactly as sent, so the cached prefix stays the same", () => {
  const history = compacted.filter((e) => e.type !== "system");
  const messages = reconstructMessagesFromHistory(history);
  assert.deepEqual(withoutStaleSnapshots(messages, history), messages);
});

test("the turn being resumed keeps its own snapshot", () => {
  const texts = userTexts(withoutStaleSnapshots(reconstructMessagesFromHistory(compacted), compacted, "run-2"));
  assert.doesNotMatch(texts[0]!, /cron OLD-1/);
  assert.match(texts[1]!, /cron OLD-2/);
});

test("a later turn sent with the same environment keeps it", () => {
  const history = [user(1, 1), reply(2), summary(3), { ...user(4, 1), seq: 4 } as SessionEntry];
  const texts = userTexts(withoutStaleSnapshots(reconstructMessagesFromHistory(history), history));
  assert.match(texts[1]!, /cron OLD-1/);
});

test("kept context containing replacement patterns is replayed literally", () => {
  const kept = "## What you remember\n- costs $& and $' and $`";
  const env = environmentNote([kept, snapshot(1)].join("\n\n"));
  const entry = {
    ...user(1, 1),
    payload: { text: "ask 1", environment: env, stateSnapshot: snapshot(1), runId: "run-1" },
  } as unknown as SessionEntry;
  const history = [entry, reply(2), summary(3)];
  const [text] = userTexts(withoutStaleSnapshots(reconstructMessagesFromHistory(history), history));
  assert.equal(text, `ask 1\n\n${environmentNote(kept)}`);
});

test("a turn whose environment was only its snapshot replays as the bare message", () => {
  const only = [
    {
      seq: 1,
      type: "user",
      createdAt: 1,
      scopeLabel: "personal:u",
      payload: { text: "hi", environment: environmentNote(snapshot(1)), stateSnapshot: snapshot(1) },
    } as unknown as SessionEntry,
    summary(2),
  ];
  assert.deepEqual(userTexts(withoutStaleSnapshots(reconstructMessagesFromHistory(only), only)), ["hi"]);
});
