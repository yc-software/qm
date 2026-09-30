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
import { CONTEXT_SUMMARY_HEADER, INTERRUPTED_TOOL_RESULT } from "../src/harness/context-compaction.ts";
import type { TapeRecord } from "../src/sessions/session-store.ts";
import type { Principal, ScopeId } from "../src/types.ts";

const scope = "channel:C1" as ScopeId;
const org = "org:default-org" as ScopeId;

let seq = 0;
function row(partial: Partial<TapeRecord> & Pick<TapeRecord, "kind" | "payload">): TapeRecord {
  return { sessionId: "s", seq: seq++, scopeLabel: scope, createdAt: 1000 + seq, ...partial } as TapeRecord;
}
const text = (value: string) => ({ type: "text", text: value });
const toolCall = (id: string, name = "exec", args: Record<string, unknown> = {}) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const userMsg = (value: string, timestamp = 1) => ({ role: "user", content: [text(value)], timestamp });
const assistantMsg = (content: string | unknown[], timestamp = 2) => ({
  role: "assistant",
  content: typeof content === "string" ? [text(content)] : content,
  timestamp,
});
const user = (value: string, extra: Partial<TapeRecord> = {}) =>
  row({ kind: "message", payload: userMsg(value), ...extra });
const assistant = (blocks: unknown[], extra: Partial<TapeRecord> = {}) =>
  row({ kind: "message", payload: { role: "assistant", content: blocks, timestamp: 2, stopReason: "stop" }, ...extra });
const aborted = (id: string, args: Record<string, unknown> = {}) =>
  row({
    kind: "message",
    payload: { role: "assistant", content: [toolCall(id, "exec", args)], timestamp: 2, stopReason: "aborted" },
  });
const toolResult = (id: string, value: string) =>
  row({
    kind: "message",
    payload: {
      role: "toolResult",
      toolCallId: id,
      toolName: "exec",
      content: [text(value)],
      isError: false,
      timestamp: 3,
    },
  });
const turnEnd = (entrySeq: number) => row({ kind: "annotation", payload: { turnEnd: true }, entrySeq });
const event = (payload: Record<string, unknown>, extra: Partial<TapeRecord> = {}) =>
  row({ kind: "context_event", payload, ...extra });
const legacyImport = (messages: unknown[]) => [event({ event: "legacy_import", messages })];
const interrupt = () => event({ event: "interrupt" });
const compaction = (summary: string, coversEntrySeq: number) =>
  event({ event: "compaction", text: summary }, { coversEntrySeq });

type Folded = Array<{
  role: string;
  toolCallId?: string;
  timestamp?: number;
  content: Array<{ type: string; text?: string; data?: string }>;
}>;
const fold = (rows: TapeRecord[]) => foldTape(rows) as Folded;
const roles = (out: Folded) => out.map((m) => m.role);
const firstTexts = (out: Folded) => out.map((m) => m.content[0]!.text);
const joined = (m: Folded[number]) => m.content.map((c) => c.text).join(" ");

const image = (artifactRef: string, mimeType: string | null = "image/png") => ({
  type: "image",
  artifactRef,
  ...(mimeType ? { mimeType } : {}),
});
const imageRow = (refs: string[], timestamp = 1) =>
  row({
    kind: "message",
    harness: "pi",
    payload: { role: "user", content: refs.map((ref) => image(ref)), timestamp },
  });
const png = { data: "aGk=", mimeType: "image/png", sizeBytes: 2 };
const contentOf = (messages: unknown[], index = 0) =>
  (messages[index] as { content: Array<{ type: string; text?: string; data?: string }> }).content;

test("message rows replay verbatim, annotations are invisible", () => {
  seq = 0;
  const rows = [user("hi"), assistant([text("hello")]), turnEnd(2)];
  const out = foldTape(rows);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], rows[0]!.payload);
  assert.deepEqual(out[1], rows[1]!.payload);
});

const legacyDeliveryLine = "(delivered file(s) to the conversation: flag.png (image/png, 100 bytes))";
const healedDeliveryNote = "[files delivered to the conversation: flag.png (image/png, 100 bytes)]";
const shim = "(continuing after the tool result above)";

test("fold heals a legacy_import assistant-voice delivery line into a user-voice note", () => {
  seq = 0;
  const out = fold(
    legacyImport([
      userMsg("make a flag"),
      assistantMsg([text("here you go"), text(legacyDeliveryLine)]),
      userMsg("thanks", 3),
    ]),
  );
  assert.deepEqual(roles(out), ["user", "assistant", "user", "user"]);
  assert.equal(joined(out[1]!), "here you go");
  assert.equal(out[2]!.content[0]!.text, healedDeliveryNote);
  assert.equal(out[2]!.timestamp, 2);
  assert.ok(lintFold(out).ok);
});

test("fold drops a legacy_import assistant message that was only the continuation shim", () => {
  seq = 0;
  const out = fold(
    legacyImport([
      userMsg("check the build"),
      assistantMsg([toolCall("c1", "execute")]),
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "execute",
        content: [text("built ok")],
        isError: false,
        timestamp: 3,
      },
      assistantMsg(shim, 4),
      userMsg("ship it", 5),
    ]),
  );
  assert.deepEqual(roles(out), ["user", "assistant", "toolResult", "user"]);
  assert.ok(!out.some((m) => m.content.some((c) => c.text?.includes("continuing after the tool result"))));
  assert.ok(lintFold(out).ok);
});

test("fold keeps genuine assistant text alongside a dropped continuation shim", () => {
  seq = 0;
  const out = fold(
    legacyImport([userMsg("hi"), assistantMsg([text("real answer"), text(shim)]), userMsg("thanks", 3)]),
  );
  assert.deepEqual(roles(out), ["user", "assistant", "user"]);
  assert.equal(joined(out[1]!), "real answer");
  assert.ok(lintFold(out).ok);
});

test("fold drops a legacy_import assistant message that was only a delivery line", () => {
  seq = 0;
  const out = fold(legacyImport([userMsg("make a flag"), assistantMsg(legacyDeliveryLine), userMsg("thanks", 3)]));
  assert.deepEqual(roles(out), ["user", "user", "user"]);
  assert.equal(out[1]!.content[0]!.text, healedDeliveryNote);
  assert.ok(lintFold(out).ok);
});

test("fold heals legacy_patch messages the same way", () => {
  seq = 0;
  const out = fold([
    user("make a flag"),
    event({ event: "legacy_patch", messages: [assistantMsg(legacyDeliveryLine)] }),
  ]);
  assert.deepEqual(roles(out), ["user", "user"]);
  assert.equal(out[1]!.content[0]!.text, healedDeliveryNote);
});

test("fold never launders a live model-typed delivery line into an authoritative note", () => {
  seq = 0;
  const rows = [user("make a flag"), assistant([text(legacyDeliveryLine)]), user("thanks")];
  assert.deepEqual(
    foldTape(rows),
    rows.map((r) => r.payload),
  );
});

test("fold leaves new-format delivery notes and ordinary parentheticals in imports untouched", () => {
  seq = 0;
  const imported = [userMsg("make a flag"), assistantMsg("(on it)"), userMsg(healedDeliveryNote, 3)];
  assert.deepEqual(foldTape(legacyImport(imported)), imported);
});

test("fold is prefix-stable across message appends", () => {
  seq = 0;
  const rows = [
    user("q1"),
    assistant([text("a1")]),
    turnEnd(1),
    user("q2"),
    assistant([toolCall("c1")]),
    toolResult("c1", "ok"),
    assistant([text("a2")]),
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
  const frozen = [userMsg("old", 0)];
  const out = fold([
    user("pre-import row that must vanish"),
    event({ event: "legacy_import", messages: frozen }, { coversEntrySeq: 10 }),
    user("live row"),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], frozen[0]);
  assert.deepEqual(out[1]!.content[0]!.text, "live row");
});

test("repeated legacy imports make a retried bootstrap fold-idempotent", () => {
  seq = 0;
  const frozen = [userMsg("thread seed", 0)];
  assert.deepEqual(foldTape([...legacyImport(frozen), ...legacyImport(frozen)]), frozen);
});

test("compaction replaces the prefix up to its watermark boundary, keeps recent turns", () => {
  seq = 0;
  const out = fold([
    user("old q"),
    assistant([text("old a")]),
    turnEnd(1),
    user("recent q"),
    assistant([text("recent a")]),
    turnEnd(3),
    compaction("the old stuff", 1),
    user("post q"),
  ]);
  assert.deepEqual(firstTexts(out), [`${CONTEXT_SUMMARY_HEADER}\nthe old stuff`, "recent q", "recent a", "post q"]);
});

test("compaction strips thinking from kept turns so later blocks bind to a stable prefix", () => {
  seq = 0;
  const think = (sig: string) => ({ type: "thinking", thinking: "", thinkingSignature: sig });
  const out = fold([
    user("old q"),
    assistant([think("old"), text("old a")]),
    turnEnd(1),
    user("recent q"),
    assistant([think("recent"), text("recent a")]),
    turnEnd(3),
    compaction("the old stuff", 1),
    user("post q"),
    assistant([think("post"), text("post a")]),
  ]);
  assert.deepEqual(
    out.map((m) => m.content.map((b) => b.type)),
    [["text"], ["text"], ["text"], ["text"], ["thinking", "text"]],
  );
  assert.deepEqual(out[2]!.content, [text("recent a")]);
});

test("compaction with no boundary at/below its watermark keeps everything (duplication, never amnesia)", () => {
  seq = 0;
  const out = fold([user("q1"), assistant([text("a1")]), compaction("sum", 0)]);
  assert.deepEqual(firstTexts(out), [`${CONTEXT_SUMMARY_HEADER}\nsum`, "q1", "a1"]);
});

test("legacy_patch appends without replacing verbatim rows", () => {
  seq = 0;
  const out = fold([
    user("live q"),
    assistant([text("live a")]),
    turnEnd(1),
    event({ event: "legacy_patch", messages: [userMsg("missed", 9)] }, { coversEntrySeq: 3 }),
  ]);
  assert.deepEqual(firstTexts(out), ["live q", "live a", "missed"]);
});

test("interrupt event heals dangling tool calls with error results into a servable fold", () => {
  for (const [id, name, args] of [
    ["c9", "exec", { cmd: "sleep" }],
    ["c1", "t", {}],
  ] as const) {
    seq = 0;
    const rows = [user("q"), assistant([toolCall(id, name, args)]), interrupt()];
    const out = foldTape(rows);
    const last = out[out.length - 1] as {
      role: string;
      toolCallId: string;
      isError: boolean;
      content: [{ text: string }];
    };
    assert.equal(last.role, "toolResult");
    assert.equal(last.toolCallId, id);
    assert.equal(last.isError, true);
    assert.equal(last.content[0].text, INTERRUPTED_TOOL_RESULT);
    assert.ok(lintFold(out).ok);
    assert.ok(!tapeNeedsInterruptHeal(rows), "healed tape needs no further heal");
    assert.ok(planTapeSeed(rows, "pi", "serve").seed, "healed tape serves");
  }
});

test("aborted assistant's dangling tool call is not healed — pi drops the message at replay", () => {
  seq = 0;
  const rows = [
    user("q"),
    assistant([toolCall("c1")]),
    toolResult("c1", "ok"),
    aborted("c9", { cmd: "sleep" }),
    interrupt(),
    user("next turn"),
  ];
  assert.ok(!tapeNeedsInterruptHeal(rows.slice(0, 4)), "aborted dangler needs no heal");
  const out = fold(rows);
  assert.ok(
    !out.some((m) => m.role === "toolResult" && m.toolCallId === "c9"),
    "no synthetic result for a call pi will drop with its aborted message",
  );
  assert.ok(lintFold(out).ok);
});

test("a poisoned tape — errored assistants, consecutive users, pre-existing interrupt — serves clean", () => {
  seq = 0;
  const errored = () =>
    row({ kind: "message", payload: { role: "assistant", content: [], timestamp: 4, stopReason: "error" } });
  const rows = [
    user("q"),
    assistant([toolCall("c1")]),
    toolResult("c1", "ok"),
    aborted("c9"),
    interrupt(),
    user("next turn"),
    errored(),
    user("retry note"),
    errored(),
  ];
  const out = fold(rows);
  assert.ok(!out.some((m) => m.role === "toolResult" && m.toolCallId === "c9"));
  assert.ok(lintFold(out).ok);
  assert.ok(!tapeNeedsInterruptHeal(rows));
});

test("lintFold rejects a toolResult answering an aborted assistant's call", () => {
  seq = 0;
  assert.ok(!lintFold(foldTape([user("q"), aborted("c9"), toolResult("c9", "orphaned on the wire")])).ok);
});

test("audience filter withholds message rows the whole room isn't entitled to, never events", () => {
  seq = 0;
  const me = { id: "U1", type: "internal" } as unknown as Principal;
  const other = { id: "U2", type: "internal" } as unknown as Principal;
  const privateLabel = { scopeLabel: "personal:U1" as ScopeId };
  const rows = [
    user("public", {}),
    row({ kind: "message", payload: userMsg("U1's private note", 3), ...privateLabel }),
    row({
      kind: "message",
      payload: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "reach",
        content: [text("U1's private DM text")],
        isError: false,
        timestamp: 4,
      },
      ...privateLabel,
    }),
    event({ event: "compaction", text: "s" }, { coversEntrySeq: 0, ...privateLabel }),
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

test("lintFold flags provider-fatal shapes and accepts well-formed ones", () => {
  const call = { role: "assistant", content: [toolCall("c1", "t")] };
  const result = { role: "toolResult", toolCallId: "c1", toolName: "t", content: [text("r")] };
  const cases: Array<[unknown[], boolean, string]> = [
    [[{ role: "toolResult", toolCallId: "x", content: [] }], false, "orphan toolResult"],
    [[call, { role: "user", content: [text("hi")] }], false, "unanswered call"],
    [[{ role: "user", content: [text("q")] }, call, result, { role: "assistant", content: [text("a")] }], true, "ok"],
    [[{ role: "user", content: [] }, call, result, call, result], false, "duplicate tool call ids"],
    [[{ role: "assistant", content: [text("hi")] }], false, "assistant-first is provider-fatal"],
    [[{ role: "user", content: [text("look"), image("a1")] }], false, "an unresolved stripped image must fall back"],
    [
      [{ role: "user", content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] }],
      true,
      "an image WITH bytes",
    ],
  ];
  for (const [messages, ok, label] of cases) assert.equal(lintFold(messages).ok, ok, label);
});

test("planTapeSeed serves a clean fold only in serve mode, falls back on defects", () => {
  seq = 0;
  const clean = [user("q"), assistant([text("a")]), turnEnd(1)];
  const cleanRows = clean.map((r) => ({ ...r, harness: r.kind === "message" ? "pi" : undefined })) as TapeRecord[];
  assert.equal(planTapeSeed(cleanRows, "pi", "shadow").seed, null, "shadow never serves");
  const served = planTapeSeed(cleanRows, "pi", "serve");
  assert.ok(served.seed && served.seed.length === 2, "serve mode seeds a clean fold");
  seq = 0;
  const dangling = [user("q"), assistant([toolCall("c1", "t")])] as TapeRecord[];
  assert.equal(planTapeSeed(dangling, "pi", "serve").seed, null, "lint failure falls back");
  assert.ok(tapeNeedsInterruptHeal(dangling), "trailing dangling call is heal-able");
  seq = 0;
  const foreign = [row({ kind: "message", harness: "opencode", payload: { info: { role: "user" }, parts: [] } })];
  const skipped = planTapeSeed(foreign, "pi", "serve");
  assert.equal(skipped.seed, null);
  assert.equal(skipped.skip, "foreign-harness");
});

test("image artifact refs rehydrate into a servable fold without mutating tape rows", async () => {
  seq = 0;
  const ref = image("a1");
  const rows = [
    row({ kind: "message", harness: "pi", payload: { role: "user", content: [text("look"), ref], timestamp: 1 } }),
    assistant([text("seen")], { harness: "pi" }),
    turnEnd(1),
  ];
  let loads = 0;
  const hydrated = await rehydrateFoldImages(
    foldTape(rows),
    async (artifactRef) => {
      loads++;
      assert.equal(artifactRef, "a1");
      return png;
    },
    10,
  );
  assert.deepEqual(contentOf(hydrated)[1], { type: "image", mimeType: "image/png", data: "aGk=" });
  assert.equal((ref as { data?: string }).data, undefined, "durable tape payload stays byte-free");
  assert.ok(planTapeSeed(rows, "pi", "serve", hydrated).seed, "rehydrated image history serves");
  assert.equal(loads, 1);
});

test("image rehydration memoizes storage reads but charges duplicate blocks to the byte budget", async () => {
  seq = 0;
  const rows = [imageRow(["missing", "missing"])];
  let loads = 0;
  const hydrated = await rehydrateFoldImages(
    foldTape(rows),
    async () => {
      loads++;
      return png;
    },
    2,
  );
  assert.equal(loads, 1, "one artifact is opened at most once per fold");
  const content = contentOf(hydrated);
  assert.equal(content[1]!.data, "aGk=", "the newest duplicate gets the budget");
  assert.equal(content[0]!.type, "text", "the older duplicate is evicted to a placeholder, not left byteless");
  assert.notEqual(planTapeSeed(rows, "pi", "serve", hydrated).seed, null, "a budget-evicted fold still serves");
});

test("image rehydration stops loading unique refs once the aggregate budget is exhausted", async () => {
  const loaded: string[] = [];
  const hydrated = await rehydrateFoldImages(
    [{ role: "user", content: [image("first"), image("second")] }],
    async (ref, remainingBytes) => {
      loaded.push(ref);
      assert.equal(remainingBytes, 2);
      return png;
    },
    2,
  );
  assert.deepEqual(loaded, ["second"], "newest image wins the budget; the exhausted older ref is never opened");
  assert.match(contentOf(hydrated)[0]!.text ?? "", /image removed/, "older image evicted to a placeholder");
});

test("an image larger than the REMAINING budget is evicted to a placeholder, not left byteless", async () => {
  seq = 0;
  const rows = [imageRow(["a", "b", "c"])];
  const SIZE = 4;
  const hydrated = await rehydrateFoldImages(
    foldTape(rows),
    async (_ref, remainingBytes) =>
      SIZE > remainingBytes ? "over-budget" : { data: "AAAA", mimeType: "image/png", sizeBytes: SIZE },
    10,
  );
  const content = contentOf(hydrated);
  assert.equal(content[2]!.data, "AAAA", "newest hydrated");
  assert.equal(content[1]!.data, "AAAA", "second-newest hydrated");
  assert.equal(content[0]!.type, "text", "oldest evicted to placeholder");
  assert.match(content[0]!.text ?? "", /image removed/);
  assert.notEqual(planTapeSeed(rows, "pi", "serve", hydrated).seed, null, "fold still serves");
});

test("a never-captured image (omitted, no ref) folds to the placeholder — reconstruction wouldn't replay it either", async () => {
  const messages = [
    userMsg("q"),
    assistantMsg([toolCall("c1", "execute")]),
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
  const block = contentOf(out, 2)[0]!;
  assert.equal(block.type, "text");
  assert.match(block.text!, /image removed/);
  assert.ok(lintFold(out).ok, "the fold lints once the omitted block is a placeholder");
});

test("image rehydration leaves missing artifacts fail-closed", async () => {
  seq = 0;
  const rows = [user("look", { payload: { role: "user", content: [image("missing")], timestamp: 1 } })];
  const hydrated = await rehydrateFoldImages(foldTape(rows), async () => null, 10);
  assert.equal(planTapeSeed(rows, "pi", "serve", hydrated).seed, null);
});

test("image rehydration requires and preserves the taped MIME identity", async () => {
  for (const [mimeType, loaded] of [
    ["image/png", "image/jpeg"],
    [null, "image/png"],
  ] as const) {
    const messages = [{ role: "user", content: [image("a1", mimeType)] }];
    const hydrated = await rehydrateFoldImages(messages, async () => ({ ...png, mimeType: loaded }), 2);
    assert.equal(lintFold(hydrated).ok, false);
    assert.deepEqual(hydrated, messages);
  }
});

test("compacted-away image refs consume no reads or hydration budget", async () => {
  seq = 0;
  const rows = [
    imageRow(["old"]),
    assistant([text("old answer")], { harness: "pi" }),
    turnEnd(1),
    imageRow(["kept"], 2),
    assistant([text("new answer")], { harness: "pi" }),
    turnEnd(3),
    compaction("old image summarized", 1),
  ];
  const loaded: string[] = [];
  const hydrated = await rehydrateFoldImages(
    foldTape(rows),
    async (ref) => {
      loaded.push(ref);
      return png;
    },
    2,
  );
  assert.deepEqual(loaded, ["kept"]);
  assert.ok(planTapeSeed(rows, "pi", "serve", hydrated).seed);
});

test("dangling calls heal only after every image is rehydrated", async () => {
  seq = 0;
  const rows = [imageRow(["a1"]), assistant([toolCall("c1")], { harness: "pi" })];
  assert.ok(!tapeNeedsInterruptHeal(rows), "an unresolved image prevents durable mutation");
  const hydrated = await rehydrateFoldImages(foldTape(rows), async () => png, 2);
  assert.ok(tapeNeedsInterruptHeal(rows, hydrated));
});
