import { test } from "node:test";
import assert from "node:assert/strict";
import { createSlackHistoryReader } from "../src/slack/history.ts";
import { parseSlackContextSource, slackAccountConfigsFromEnv } from "../src/slack/config.ts";
import { createSurfaceToolDeps, type SurfaceToolsContext } from "../src/core/orchestrator/surface-tools.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";
import type { BotIdentity } from "../src/slack/directory.ts";

const ids = { botUserId: "UBOT", ownBotId: "BBOT" } as BotIdentity;

test("context source defaults live and invalid modes fail closed", () => {
  assert.equal(parseSlackContextSource(undefined), "live");
  assert.equal(parseSlackContextSource(""), "live");
  for (const source of ["live", "shadow", "mirror"]) assert.equal(parseSlackContextSource(source), source);
  assert.throws(() => parseSlackContextSource("miror"));
});

test("default live context never reads or writes mirror and expands recent channel threads", async () => {
  const calls: string[] = [];
  const core = {
    readSurfaceMessages: async () => {
      throw new Error("must not read mirror");
    },
    rememberSurfaceHistory: async () => {
      throw new Error("must not backfill");
    },
  } as unknown as SlackCoreClient;
  const client = {
    conversations: {
      history: async () => {
        calls.push("history");
        return {
          messages: [
            { ts: "2", text: "new" },
            { ts: "1", text: "parent", reply_count: 1 },
          ],
        };
      },
      replies: async () => {
        calls.push("replies");
        return {
          messages: [
            { ts: "1", text: "parent" },
            { ts: "1.5", thread_ts: "1", text: "live reply" },
          ],
        };
      },
    },
  };
  const result = await createSlackHistoryReader({ core, ids })(client, "C1", undefined, undefined, true);
  assert.deepEqual(calls, ["history", "replies"]);
  assert.ok(result.raw.some((message) => message.text === "live reply"));
  assert.equal(result.note, undefined);
});

test("shadow compares counts and text but returns live context without waiting for the mirror", async (t) => {
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const logs: string[] = [];
  let mirrorReads = 0;
  t.mock.method(console, "info", (line: string) => {
    logs.push(line);
  });
  const core = {
    readSurfaceMessages: async () => {
      mirrorReads++;
      return pending;
    },
    rememberSurfaceHistory: async () => {
      throw new Error("must not backfill");
    },
  } as unknown as SlackCoreClient;
  const client = {
    conversations: {
      history: async () => ({
        messages: [
          { ts: "1", text: "live secret text" },
          { ts: "2", text: "second secret" },
        ],
      }),
    },
  };
  const read = createSlackHistoryReader({ core, ids, source: "shadow" });
  const result = await read(client, "C-secret");
  await read(client, "C-secret");
  assert.equal(mirrorReads, 1);
  assert.equal(result.raw[0]?.text, "second secret");
  assert.equal(logs.length, 0);
  release([{ ts: "1", text: "stale secret text" }]);
  await new Promise((resolve) => setImmediate(resolve));
  const comparison = JSON.parse(logs[0]!);
  assert.equal(comparison.liveMessagesMissingFromMirror, 1);
  assert.equal(comparison.textMismatches, 1);
  assert.ok(logs.every((line) => !line.includes("secret")));
});

test("shadow failures never replace or fail the live result", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "info", (line: string) => {
    logs.push(line);
  });
  const core = {
    readSurfaceMessages: async () => {
      throw new Error("private error details");
    },
  } as unknown as SlackCoreClient;
  const client = { conversations: { replies: async () => ({ messages: [{ ts: "1", text: "live" }] }) } };
  assert.equal(
    (await createSlackHistoryReader({ core, ids, source: "shadow" })(client, "C1", "1")).raw[0]?.text,
    "live",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(logs.some((line) => line.includes("read_failed")));
  assert.ok(logs.every((line) => !line.includes("private error")));
});

test("live and shadow default search cannot source mirror data", async () => {
  for (const source of [undefined, "live", "shadow"] as const) {
    let cacheReads = 0;
    const tools = createSurfaceToolDeps({
      deps: {
        deliveries: {},
        slackContextSource: source,
        surfaceCache: {
          containerState: async () => null,
          search: async () => {
            cacheReads++;
            return [{ text: "mirror secret" }];
          },
        },
        surfaceContext: {
          pull: async () => ({
            messages: [{ ts: "1", text: "live match" }],
            note: "Retry in 60 seconds; setup at https://qm.test/admin/?setup=slack",
          }),
        },
      },
      input: { surface: "slack", surfaceTools: true },
      actor: { id: "U1" },
      conversation: { kind: "channel" },
      defaultDestination: { type: "slack", target: "C1:1" },
    } as unknown as SurfaceToolsContext)!;
    const result = await tools.search("match");
    assert.equal(result.source, "live");
    assert.equal(result.hits?.[0]?.snippet, "live match");
    assert.match(result.message!, /60 seconds.*setup=slack/);
    assert.equal((await tools.search("match", { source: "mirror" })).ok, false);
    assert.equal(cacheReads, 0);
  }
});

test("secondary Slack accounts inherit the explicitly selected shadow mode", () => {
  const [account] = slackAccountConfigsFromEnv({
    SLACK_CONTEXT_SOURCE: "shadow",
    SLACK_ACCOUNTS: JSON.stringify([{ id: "secondary", botToken: "xoxb-test", appToken: "xapp-test" }]),
  });
  assert.equal(account?.contextSource, "shadow");
});

test("shadow distinguishes stored messages with wrong parents from ingestion loss", async (t) => {
  const { createMemorySurfaceCache } = await import("../src/surface-cache/surface-cache.ts");
  const cache = createMemorySurfaceCache();
  await cache.ingest([
    { container: "C1", ts: "1", text: "root" },
    { container: "C1", ts: "2", sub: "wrong", text: "reply" },
  ]);
  const logs: string[] = [];
  t.mock.method(console, "info", (line: string) => logs.push(line));
  const reader = createSlackHistoryReader({
    ids,
    source: "shadow",
    core: {
      readSurfaceMessages: cache.readMessages,
      rememberSurfaceHistory: async () => {
        throw new Error("shadow must never repair what it measures");
      },
    } as unknown as SlackCoreClient,
  });
  await reader(
    {
      conversations: {
        replies: async () => ({
          messages: [
            { ts: "1", text: "root" },
            { ts: "2", thread_ts: "1", text: "reply" },
            { ts: "3", thread_ts: "1", text: "absent" },
          ],
        }),
      },
    },
    "C1",
    "1",
  );
  await new Promise((resolve) => setImmediate(resolve));
  const result = JSON.parse(logs[0]!);
  assert.equal(result.liveMessagesMissingFromStorage, 1);
  assert.equal(result.liveMessagesMissingFromMirror, 2);
  assert.equal(result.threadParentMismatches, 1);
  assert.equal(result.storedMessages, 2);
  assert.equal(result.matchingMessages, 1);
});

test("shadow normalizes mentions without erasing literal entity or attachment differences", async (t) => {
  const { createMemorySurfaceCache } = await import("../src/surface-cache/surface-cache.ts");
  const cache = createMemorySurfaceCache();
  await cache.ingest([
    { container: "C1", ts: "1", text: "Hi <@U1> &lt;", mentions: { U1: "Alice" } },
    { container: "C1", ts: "2", text: "<" },
    { container: "C1", ts: "3", text: "file", files: [{ fileId: "old" }] },
  ]);
  const logs: string[] = [];
  t.mock.method(console, "info", (line: string) => logs.push(line));
  const reader = createSlackHistoryReader({
    ids,
    source: "shadow",
    core: { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient,
  });
  await reader(
    {
      conversations: {
        history: async () => ({
          messages: [
            { ts: "3", text: "file", files: [{ id: "new" }] },
            { ts: "2", text: "&amp;lt;" },
            { ts: "1", text: "Hi <@U1> &amp;lt;" },
          ],
        }),
      },
    },
    "C1",
  );
  await new Promise((resolve) => setImmediate(resolve));
  const result = JSON.parse(logs[0]!);
  assert.equal(result.textMismatches, 1);
  assert.equal(result.fileMismatches, 1);
  assert.equal(result.matchingMessages, 1);
  assert.equal(result.liveMessagesMissingFromStorage, 0);
});

test("mirror selects channel roots and expands five recent threads with Slack page ordering", async () => {
  const { createMemorySurfaceCache } = await import("../src/surface-cache/surface-cache.ts");
  const cache = createMemorySurfaceCache();
  const ts = (n: number) => String(n).padStart(6, "0");
  await cache.ingest(Array.from({ length: 205 }, (_, i) => ({ container: "C1", ts: ts(i), text: "root" })));
  await cache.ingest(
    Array.from({ length: 250 }, (_, i) => ({ container: "C1", ts: ts(300 + i), sub: ts(204), text: "reply" })),
  );
  const read = createSlackHistoryReader({
    ids,
    source: "mirror",
    core: { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient,
  });
  const roots = await read({}, "C1");
  assert.equal(roots.raw.length, 200);
  assert.equal(roots.raw[0]?.ts, ts(5));
  assert.equal(roots.raw.at(-1)?.ts, ts(204));
  const thread = await read({}, "C1", ts(204));
  assert.equal(thread.raw.length, 200);
  assert.equal(thread.raw[0]?.ts, ts(204));
  assert.equal(thread.raw.at(-1)?.ts, ts(498));
  const expanded = await read({}, "C1", undefined, undefined, true);
  assert.equal(expanded.raw.length, 399);
  assert.equal(expanded.raw.at(-1)?.ts, ts(498));
});

test("shadow never certifies failed or truncated live thread expansion as complete", async (t) => {
  const { createMemorySurfaceCache } = await import("../src/surface-cache/surface-cache.ts");
  const cache = createMemorySurfaceCache();
  await cache.ingest([{ container: "C1", ts: "1", text: "root" }]);
  const logs: string[] = [];
  t.mock.method(console, "info", (line: string) => logs.push(line));
  for (const fail of [true, false]) {
    const reader = createSlackHistoryReader({
      ids,
      source: "shadow",
      core: { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient,
    });
    await reader(
      {
        conversations: {
          history: async () => ({ messages: [{ ts: "1", text: "root", reply_count: 1 }] }),
          replies: async () => {
            if (fail) throw new Error("rate limited");
            return { messages: [{ ts: "1", text: "root" }], has_more: true };
          },
        },
      },
      "C1",
      undefined,
      undefined,
      true,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const result = JSON.parse(logs.at(-1)!);
    assert.equal(result.matchingMessages, 1);
    assert.equal(result.liveComplete, false);
    assert.equal(result.liveExpansionFailures, fail ? 1 : 0);
    assert.equal(result.liveTruncatedExpansions, fail ? 0 : 1);
  }
});
