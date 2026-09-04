import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterTapeForAudience,
  foldTape,
  lintFold,
  planTapeSeed,
  rehydrateFoldImages,
  tapeNeedsInterruptHeal,
} from "../src/harness/tape-fold.ts";
import { INTERRUPTED_TOOL_RESULT } from "../src/harness/context-compaction.ts";
import type { TapeRecord } from "../src/sessions/session-store.ts";
import type { Principal, ScopeId } from "../src/types.ts";

const scope = "channel:C1" as ScopeId;
const org = "org:default-org" as ScopeId;

let seq = 0;
function row(partial: Partial<TapeRecord> & Pick<TapeRecord, "kind" | "payload">): TapeRecord {
  return { sessionId: "s", seq: seq++, scopeLabel: scope, createdAt: 1000 + seq, ...partial } as TapeRecord;
}
const user = (text: string, extra: Partial<TapeRecord> = {}) =>
  row({ kind: "message", payload: { role: "user", content: [{ type: "text", text }], timestamp: 1 }, ...extra });
const assistant = (blocks: unknown[], extra: Partial<TapeRecord> = {}) =>
  row({ kind: "message", payload: { role: "assistant", content: blocks, timestamp: 2, stopReason: "stop" }, ...extra });
const toolResult = (id: string, text: string) =>
  row({
    kind: "message",
    payload: {
      role: "toolResult",
      toolCallId: id,
      toolName: "exec",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 3,
    },
  });
const turnEnd = (entrySeq: number) => row({ kind: "annotation", payload: { turnEnd: true }, entrySeq });

test("message rows replay verbatim, annotations are invisible", () => {
  seq = 0;
  const rows = [user("hi"), assistant([{ type: "text", text: "hello" }]), turnEnd(2)];
  const out = foldTape(rows);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], rows[0]!.payload);
  assert.deepEqual(out[1], rows[1]!.payload);
});

test("fold is prefix-stable across message appends", () => {
  seq = 0;
  const rows = [
    user("q1"),
    assistant([{ type: "text", text: "a1" }]),
    turnEnd(1),
    user("q2"),
    assistant([{ type: "toolCall", id: "c1", name: "exec", arguments: {} }]),
    toolResult("c1", "ok"),
    assistant([{ type: "text", text: "a2" }]),
    turnEnd(5),
  ];
  for (let n = 1; n <= rows.length; n++) {
    const prefix = JSON.stringify(foldTape(rows.slice(0, n - 1)));
    const grown = JSON.stringify(foldTape(rows.slice(0, n)));
    assert.ok(grown.startsWith(prefix.slice(0, prefix.length - 1)), `append ${n} rewrote the folded prefix`);
  }
});

test("legacy_import replaces everything before it", () => {
  seq = 0;
  const frozen = [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 0 }];
  const rows = [
    user("pre-import row that must vanish"),
    row({ kind: "context_event", payload: { event: "legacy_import", messages: frozen }, coversEntrySeq: 10 }),
    user("live row"),
  ];
  const out = foldTape(rows);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], frozen[0]);
  assert.deepEqual((out[1] as { content: [{ text: string }] }).content[0].text, "live row");
});

test("repeated legacy imports make a retried bootstrap fold-idempotent", () => {
  seq = 0;
  const frozen = [{ role: "user", content: [{ type: "text", text: "thread seed" }], timestamp: 0 }];
  const rows = [
    row({ kind: "context_event", payload: { event: "legacy_import", messages: frozen } }),
    row({ kind: "context_event", payload: { event: "legacy_import", messages: frozen } }),
  ];
  assert.deepEqual(foldTape(rows), frozen);
});

test("compaction replaces the prefix up to its watermark boundary, keeps recent turns", () => {
  seq = 0;
  const rows = [
    user("old q"),
    assistant([{ type: "text", text: "old a" }]),
    turnEnd(1),
    user("recent q"),
    assistant([{ type: "text", text: "recent a" }]),
    turnEnd(3),
    row({ kind: "context_event", payload: { event: "compaction", text: "the old stuff" }, coversEntrySeq: 1 }),
    user("post q"),
  ];
  const out = foldTape(rows) as Array<{ role: string; content: [{ text: string }] }>;
  assert.deepEqual(
    out.map((m) => m.content[0].text),
    ["[Earlier conversation summary]\nthe old stuff", "recent q", "recent a", "post q"],
  );
});

test("interrupt event heals dangling tool calls with error results", () => {
  seq = 0;
  const rows = [
    user("q"),
    assistant([{ type: "toolCall", id: "c9", name: "exec", arguments: { cmd: "sleep" } }]),
    row({ kind: "context_event", payload: { event: "interrupt" } }),
  ];
  const out = foldTape(rows);
  const last = out[out.length - 1] as {
    role: string;
    toolCallId: string;
    isError: boolean;
    content: [{ text: string }];
  };
  assert.equal(last.role, "toolResult");
  assert.equal(last.toolCallId, "c9");
  assert.equal(last.isError, true);
  assert.equal(last.content[0].text, INTERRUPTED_TOOL_RESULT);
  assert.ok(lintFold(out).ok);
});

test("aborted assistant's dangling tool call is not healed — pi drops the message at replay", () => {
  seq = 0;
  const abortedAssistant = row({
    kind: "message",
    payload: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c9", name: "exec", arguments: { cmd: "sleep" } }],
      timestamp: 2,
      stopReason: "aborted",
    },
  });
  const rows = [
    user("q"),
    assistant([{ type: "toolCall", id: "c1", name: "exec", arguments: {} }]),
    toolResult("c1", "ok"),
    abortedAssistant,
    row({ kind: "context_event", payload: { event: "interrupt" } }),
    user("next turn"),
  ];
  assert.ok(!tapeNeedsInterruptHeal(rows.slice(0, 4)), "aborted dangler needs no heal");
  const out = foldTape(rows) as Array<{ role: string; toolCallId?: string }>;
  assert.ok(
    !out.some((m) => m.role === "toolResult" && m.toolCallId === "c9"),
    "no synthetic result for a call pi will drop with its aborted message",
  );
  assert.ok(lintFold(out).ok);
});

test("a poisoned tape — errored assistants, consecutive users, pre-existing interrupt — serves clean", () => {
  seq = 0;
  const erroredAssistant = () =>
    row({
      kind: "message",
      payload: { role: "assistant", content: [], timestamp: 4, stopReason: "error" },
    });
  const rows = [
    user("q"),
    assistant([{ type: "toolCall", id: "c1", name: "exec", arguments: {} }]),
    toolResult("c1", "ok"),
    row({
      kind: "message",
      payload: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c9", name: "exec", arguments: {} }],
        timestamp: 2,
        stopReason: "aborted",
      },
    }),
    row({ kind: "context_event", payload: { event: "interrupt" } }),
    user("next turn"),
    erroredAssistant(),
    user("retry note"),
    erroredAssistant(),
  ];
  const out = foldTape(rows) as Array<{ role: string; toolCallId?: string }>;
  assert.ok(!out.some((m) => m.role === "toolResult" && m.toolCallId === "c9"));
  assert.ok(lintFold(out).ok);
  assert.ok(!tapeNeedsInterruptHeal(rows));
});

test("lintFold rejects a toolResult answering an aborted assistant's call", () => {
  seq = 0;
  const rows = [
    user("q"),
    row({
      kind: "message",
      payload: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c9", name: "exec", arguments: {} }],
        timestamp: 2,
        stopReason: "aborted",
      },
    }),
    toolResult("c9", "orphaned on the wire"),
  ];
  assert.ok(!lintFold(foldTape(rows)).ok);
});

test("audience filter withholds message rows the whole room isn't entitled to, never events", () => {
  seq = 0;
  const me = { id: "U1", type: "internal" } as unknown as Principal;
  const other = { id: "U2", type: "internal" } as unknown as Principal;
  const rows = [
    user("public", {}),
    row({
      kind: "message",
      payload: { role: "user", content: [{ type: "text", text: "U1's private note" }], timestamp: 3 },
      scopeLabel: "personal:U1" as ScopeId,
    }),
    row({
      kind: "message",
      payload: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "reach",
        content: [{ type: "text", text: "U1's private DM text" }],
        isError: false,
        timestamp: 4,
      },
      scopeLabel: "personal:U1" as ScopeId,
    }),
    row({
      kind: "context_event",
      payload: { event: "compaction", text: "s" },
      coversEntrySeq: 0,
      scopeLabel: "personal:U1" as ScopeId,
    }),
  ];
  const solo = filterTapeForAudience(rows, [me], scope, org);
  assert.equal(solo.filter((r) => r.kind === "message").length, 3);
  const room = filterTapeForAudience(rows, [me, other], scope, org);
  const roomMessages = room.filter((r) => r.kind === "message");
  assert.equal(roomMessages.length, 2, "private user row hidden; toolResult row substituted");
  const substituted = roomMessages[1]!.payload as { toolCallId: string; isError: boolean; content: [{ text: string }] };
  assert.equal(substituted.toolCallId, "c1");
  assert.equal(substituted.isError, true);
  assert.equal(substituted.content[0].text, INTERRUPTED_TOOL_RESULT);
  assert.ok(!JSON.stringify(room).includes("private DM text"), "withheld bytes never survive");
  assert.equal(room.filter((r) => r.kind === "context_event").length, 1, "events always survive");
  assert.equal(filterTapeForAudience(rows, [], scope, org).length, 0, "empty audience sees nothing");
});

test("lintFold flags provider-fatal shapes", () => {
  assert.ok(!lintFold([{ role: "toolResult", toolCallId: "x", content: [] }]).ok);
  assert.ok(
    !lintFold([
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "t", arguments: {} }] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]).ok,
  );
  assert.ok(
    lintFold([
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "t", arguments: {} }] },
      { role: "toolResult", toolCallId: "c1", toolName: "t", content: [{ type: "text", text: "r" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
    ]).ok,
  );
});

test("compaction with no boundary at/below its watermark keeps everything (duplication, never amnesia)", () => {
  seq = 0;
  const rows = [
    user("q1"),
    assistant([{ type: "text", text: "a1" }]),
    row({ kind: "context_event", payload: { event: "compaction", text: "sum" }, coversEntrySeq: 0 }),
  ];
  const out = foldTape(rows) as Array<{ content: [{ text: string }] }>;
  assert.deepEqual(
    out.map((m) => m.content[0].text),
    ["[Earlier conversation summary]\nsum", "q1", "a1"],
  );
});

test("lintFold flags duplicate tool call ids", () => {
  const call = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "t", arguments: {} }] };
  const result = { role: "toolResult", toolCallId: "c1", toolName: "t", content: [{ type: "text", text: "r" }] };
  assert.ok(!lintFold([{ role: "user", content: [] }, call, result, call, result]).ok);
});

test("planTapeSeed serves a clean fold only in serve mode, falls back on defects", () => {
  seq = 0;
  const clean = [user("q"), assistant([{ type: "text", text: "a" }]), turnEnd(1)];
  const cleanRows = clean.map((r) => ({ ...r, harness: r.kind === "message" ? "pi" : undefined })) as TapeRecord[];
  assert.equal(planTapeSeed(cleanRows, "pi", "shadow").seed, null, "shadow never serves");
  const served = planTapeSeed(cleanRows, "pi", "serve");
  assert.ok(served.seed && served.seed.length === 2, "serve mode seeds a clean fold");
  seq = 0;
  const dangling = [user("q"), assistant([{ type: "toolCall", id: "c1", name: "t", arguments: {} }])] as TapeRecord[];
  assert.equal(planTapeSeed(dangling, "pi", "serve").seed, null, "lint failure falls back");
  assert.ok(tapeNeedsInterruptHeal(dangling), "trailing dangling call is heal-able");
  seq = 0;
  const foreign = [row({ kind: "message", harness: "opencode", payload: { info: { role: "user" }, parts: [] } })];
  const skipped = planTapeSeed(foreign, "pi", "serve");
  assert.equal(skipped.seed, null);
  assert.equal(skipped.skip, "foreign-harness");
});

test("interrupt heal converts a heal-able tape into a servable one", () => {
  seq = 0;
  const rows = [
    user("q"),
    assistant([{ type: "toolCall", id: "c1", name: "t", arguments: {} }]),
    row({ kind: "context_event", payload: { event: "interrupt" } }),
  ];
  assert.ok(!tapeNeedsInterruptHeal(rows), "healed tape needs no further heal");
  const plan = planTapeSeed(rows, "pi", "serve");
  assert.ok(plan.seed, "healed tape serves");
});

test("legacy_patch appends without replacing verbatim rows", () => {
  seq = 0;
  const rows = [
    user("live q"),
    assistant([{ type: "text", text: "live a" }]),
    turnEnd(1),
    row({
      kind: "context_event",
      payload: {
        event: "legacy_patch",
        messages: [{ role: "user", content: [{ type: "text", text: "missed" }], timestamp: 9 }],
      },
      coversEntrySeq: 3,
    }),
  ];
  const out = foldTape(rows) as Array<{ content: [{ text: string }] }>;
  assert.deepEqual(
    out.map((m) => m.content[0].text),
    ["live q", "live a", "missed"],
  );
});

test("lintFold rejects byteless image blocks and non-user first message", () => {
  assert.ok(
    !lintFold([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]).ok,
    "assistant-first is provider-fatal",
  );
  assert.ok(
    !lintFold([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", artifactRef: "a1", mimeType: "image/png" },
        ],
      },
    ]).ok,
    "an unresolved stripped image must fall back",
  );
  assert.ok(
    lintFold([{ role: "user", content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] }]).ok,
    "an image WITH bytes is fine",
  );
});

test("image artifact refs rehydrate into a servable fold without mutating tape rows", async () => {
  seq = 0;
  const image = { type: "image", artifactRef: "a1", mimeType: "image/png" };
  const rows = [
    row({
      kind: "message",
      harness: "pi",
      payload: { role: "user", content: [{ type: "text", text: "look" }, image], timestamp: 1 },
    }),
    assistant([{ type: "text", text: "seen" }], { harness: "pi" }),
    turnEnd(1),
  ];
  let loads = 0;
  const folded = foldTape(rows);
  const hydrated = await rehydrateFoldImages(
    folded,
    async (artifactRef) => {
      loads++;
      assert.equal(artifactRef, "a1");
      return { data: "aGk=", mimeType: "image/png", sizeBytes: 2 };
    },
    10,
  );
  const block = (hydrated[0] as { content: Array<Record<string, unknown>> }).content[1]!;
  assert.deepEqual(block, { type: "image", mimeType: "image/png", data: "aGk=" });
  assert.equal((image as { data?: string }).data, undefined, "durable tape payload stays byte-free");
  assert.ok(planTapeSeed(rows, "pi", "serve", hydrated).seed, "rehydrated image history serves");
  assert.equal(loads, 1);
});

test("image rehydration memoizes storage reads but charges duplicate blocks to the byte budget", async () => {
  seq = 0;
  const rows = [
    row({
      kind: "message",
      harness: "pi",
      payload: {
        role: "user",
        content: [
          { type: "image", artifactRef: "missing", mimeType: "image/png" },
          { type: "image", artifactRef: "missing", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    }),
  ];
  let loads = 0;
  const hydrated = await rehydrateFoldImages(
    foldTape(rows),
    async () => {
      loads++;
      return { data: "aGk=", mimeType: "image/png", sizeBytes: 2 };
    },
    2,
  );
  assert.equal(loads, 1, "one artifact is opened at most once per fold");
  const content = (hydrated[0] as { content: Array<{ type: string; data?: string; text?: string }> }).content;
  assert.equal(content[1]!.data, "aGk=", "the newest duplicate gets the budget");
  assert.equal(content[0]!.type, "text", "the older duplicate is evicted to a placeholder, not left byteless");
  assert.notEqual(planTapeSeed(rows, "pi", "serve", hydrated).seed, null, "a budget-evicted fold still serves");
});

test("image rehydration stops loading unique refs once the aggregate budget is exhausted", async () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "image", artifactRef: "first", mimeType: "image/png" },
        { type: "image", artifactRef: "second", mimeType: "image/png" },
      ],
    },
  ];
  const loaded: string[] = [];
  const hydrated = await rehydrateFoldImages(
    messages,
    async (ref, remainingBytes) => {
      loaded.push(ref);
      assert.equal(remainingBytes, 2);
      return { data: "aGk=", mimeType: "image/png", sizeBytes: 2 };
    },
    2,
  );
  assert.deepEqual(loaded, ["second"], "newest image wins the budget; the exhausted older ref is never opened");
  const content = (hydrated[0] as { content: Array<{ type: string; text?: string }> }).content;
  assert.match(content[0]!.text ?? "", /image removed/, "older image evicted to a placeholder");
});

test("an image larger than the REMAINING budget is evicted to a placeholder, not left byteless", async () => {
  seq = 0;
  const rows = [
    row({
      kind: "message",
      harness: "pi",
      payload: {
        role: "user",
        content: [
          { type: "image", artifactRef: "a", mimeType: "image/png" },
          { type: "image", artifactRef: "b", mimeType: "image/png" },
          { type: "image", artifactRef: "c", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    }),
  ];
  const SIZE = 4;
  const hydrated = await rehydrateFoldImages(
    foldTape(rows),
    async (_ref, remainingBytes) =>
      SIZE > remainingBytes ? "over-budget" : { data: "AAAA", mimeType: "image/png", sizeBytes: SIZE },
    10,
  );
  const content = (hydrated[0] as { content: Array<{ type: string; text?: string; data?: string }> }).content;
  assert.equal(content[2]!.data, "AAAA", "newest hydrated");
  assert.equal(content[1]!.data, "AAAA", "second-newest hydrated");
  assert.equal(content[0]!.type, "text", "oldest evicted to placeholder");
  assert.match(content[0]!.text ?? "", /image removed/);
  assert.notEqual(planTapeSeed(rows, "pi", "serve", hydrated).seed, null, "fold still serves");
});

test("a never-captured image (omitted, no ref) folds to the placeholder — reconstruction wouldn't replay it either", async () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "q" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "execute", arguments: {} }], timestamp: 2 },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "execute",
      content: [{ type: "image", omitted: true, mimeType: "image/png" }],
      isError: false,
      timestamp: 3,
    },
  ];
  const out = await rehydrateFoldImages(messages, async () => null, 1000);
  const block = (out[2] as { content: Array<{ type: string; text?: string }> }).content[0]!;
  assert.equal(block.type, "text");
  assert.match(block.text!, /image removed/);
  assert.ok(lintFold(out).ok, "the fold lints once the omitted block is a placeholder");
});

test("image rehydration leaves missing artifacts fail-closed", async () => {
  seq = 0;
  const rows = [
    user("look", {
      payload: {
        role: "user",
        content: [{ type: "image", artifactRef: "missing", mimeType: "image/png" }],
        timestamp: 1,
      },
    }),
  ];
  const hydrated = await rehydrateFoldImages(foldTape(rows), async () => null, 10);
  assert.equal(planTapeSeed(rows, "pi", "serve", hydrated).seed, null);
});

test("image rehydration preserves the taped MIME identity", async () => {
  const messages = [{ role: "user", content: [{ type: "image", artifactRef: "a1", mimeType: "image/png" }] }];
  const hydrated = await rehydrateFoldImages(
    messages,
    async () => ({ data: "aGk=", mimeType: "image/jpeg", sizeBytes: 2 }),
    2,
  );
  assert.equal(lintFold(hydrated).ok, false);
  assert.deepEqual(hydrated, messages);
});

test("image rehydration requires a taped MIME identity", async () => {
  const messages = [{ role: "user", content: [{ type: "image", artifactRef: "a1" }] }];
  const hydrated = await rehydrateFoldImages(
    messages,
    async () => ({ data: "aGk=", mimeType: "image/png", sizeBytes: 2 }),
    2,
  );
  assert.equal(lintFold(hydrated).ok, false);
  assert.deepEqual(hydrated, messages);
});

test("compacted-away image refs consume no reads or hydration budget", async () => {
  seq = 0;
  const rows = [
    row({
      kind: "message",
      harness: "pi",
      payload: { role: "user", content: [{ type: "image", artifactRef: "old", mimeType: "image/png" }], timestamp: 1 },
    }),
    assistant([{ type: "text", text: "old answer" }], { harness: "pi" }),
    turnEnd(1),
    row({
      kind: "message",
      harness: "pi",
      payload: { role: "user", content: [{ type: "image", artifactRef: "kept", mimeType: "image/png" }], timestamp: 2 },
    }),
    assistant([{ type: "text", text: "new answer" }], { harness: "pi" }),
    turnEnd(3),
    row({ kind: "context_event", payload: { event: "compaction", text: "old image summarized" }, coversEntrySeq: 1 }),
  ];
  const loaded: string[] = [];
  const hydrated = await rehydrateFoldImages(
    foldTape(rows),
    async (ref) => {
      loaded.push(ref);
      return { data: "aGk=", mimeType: "image/png", sizeBytes: 2 };
    },
    2,
  );
  assert.deepEqual(loaded, ["kept"]);
  assert.ok(planTapeSeed(rows, "pi", "serve", hydrated).seed);
});

test("dangling calls heal only after every image is rehydrated", async () => {
  seq = 0;
  const rows = [
    row({
      kind: "message",
      harness: "pi",
      payload: { role: "user", content: [{ type: "image", artifactRef: "a1", mimeType: "image/png" }], timestamp: 1 },
    }),
    assistant([{ type: "toolCall", id: "c1", name: "exec", arguments: {} }], { harness: "pi" }),
  ];
  assert.ok(!tapeNeedsInterruptHeal(rows), "an unresolved image prevents durable mutation");
  const hydrated = await rehydrateFoldImages(
    foldTape(rows),
    async () => ({ data: "aGk=", mimeType: "image/png", sizeBytes: 2 }),
    2,
  );
  assert.ok(tapeNeedsInterruptHeal(rows, hydrated));
});
