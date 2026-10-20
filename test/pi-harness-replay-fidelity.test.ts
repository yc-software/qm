import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness, EMPTY_ENDING_NOTE } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { forModelContext } from "../src/harness/context-compaction.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import type { SessionEntry } from "../src/types.ts";
import { createMemoryRunSignalStore, type RunSignalStore } from "../src/runs/run-signal-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { artifactImageLoader } from "../src/harness/replay-images.ts";
import { createPostgresToolOutputStore, type ToolOutputStore } from "../src/sessions/tool-output.ts";

type Body = { messages?: unknown[]; input?: unknown[] };
type Reply = Array<Record<string, unknown>>;

function anthropicSse(blocks: Reply, stop: string): Response {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg",
        type: "message",
        role: "assistant",
        content: [],
        model: "m",
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: block.signature },
      });
    } else if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 3 } });
  events.push({ type: "message_stop" });
  const body = events.map((event) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function openaiSse(items: Reply): Response {
  const events: Array<Record<string, unknown>> = [{ type: "response.created", response: { id: "resp" } }];
  items.forEach((item, output_index) => {
    const emptied = { message: { content: [] }, reasoning: { summary: [] } }[item.type as string] ?? { arguments: "" };
    const added = { ...item, ...emptied };
    events.push({ type: "response.output_item.added", output_index, item: added });
    events.push({ type: "response.output_item.done", output_index, item });
  });
  events.push({
    type: "response.completed",
    response: {
      id: "resp",
      status: "completed",
      output: items,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  });
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonb(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonb);
  if (!value || typeof value !== "object") return value;
  const keys = Object.keys(value).sort((a, b) => a.length - b.length || Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Object.fromEntries(keys.map((key) => [key, jsonb((value as Record<string, unknown>)[key])]));
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, v]) => [key, withoutCacheControl(v)]),
  );
}

async function runTurn(
  input: string,
  history: SessionEntry[],
  replies: Array<(body: Body) => Response>,
  overrides: Partial<HarnessTurnInput> = {},
  signals?: RunSignalStore,
  onHistory?: () => Promise<void>,
) {
  const harness = createPiHarness({ apiKey: "sk-test", ...(signals ? { signals } : {}) });
  const emitted: SessionEntry[] = [];
  const bodies: Body[] = [];
  let seq = (history.at(-1)?.seq ?? 0) + 1;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    bodies.push(body);
    return replies[bodies.length - 1]!(body);
  }) as typeof globalThis.fetch;
  try {
    const result = await harness.turns.runTurn({
      session: { id: "fidelity" } as HarnessTurnInput["session"],
      runId: `run-${seq}`,
      input,
      systemPrompt: "BASE",
      history,
      tools: {
        async history(query: string) {
          if (query === "boom") throw new Error("history index unavailable");
          await onHistory?.();
          return ["user#1: the budget doc is in shared/q2.md"];
        },
      } as unknown as ToolContext,
      scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
      orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
      emit: async (e: NewEntry) => {
        const appended: SessionEntry = {
          sessionId: "fidelity",
          seq: seq++,
          parentSeq: null,
          type: e.type,
          payload: jsonb(e.payload),
          scopeLabel: e.scopeLabel,
          createdAt: Date.now(),
        };
        emitted.push(appended);
        return appended;
      },
      recordModelCall: () => {},
      ...overrides,
    });
    return { result, emitted, bodies };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("the next turn's anthropic request replays the previous turn byte-for-byte: thinking, narration, tool call, result, reply", async () => {
  const step1: Reply = [
    { type: "thinking", thinking: "I should search history.", signature: "sig-one" },
    { type: "text", text: "Checking the history first." },
    { type: "tool_use", id: "toolu_1", name: "history", input: { query: "budget", limit: 5 } },
    { type: "tool_use", id: "toolu_2", name: "history", input: { query: "boom" } },
    { type: "tool_use", id: "toolu_3", name: "no_such_tool", input: { x: 1 } },
    { type: "tool_use", id: "toolu_4", name: "history", input: { limit: "many" } },
  ];
  const step2: Reply = [
    { type: "thinking", thinking: "Found it.", signature: "sig-two" },
    { type: "text", text: "It is in shared/q2.md." },
  ];
  const first = await runTurn(
    "where is the budget doc?",
    [],
    [() => anthropicSse(step1, "tool_use"), () => anthropicSse(step2, "end_turn")],
  );
  assert.equal(first.result.reply, "It is in shared/q2.md.");
  assert.equal(first.bodies.length, 2);
  const invalid = first.emitted.filter((e) => (e.payload as { callId?: string }).callId === "toolu_4");
  assert.deepEqual(
    invalid.map((e) => [e.type, (e.payload as { isError?: boolean }).isError]),
    [
      ["tool_call", undefined],
      ["tool_result", true],
    ],
  );

  const second = await runTurn("thanks, and the Q3 one?", forModelContext(first.emitted), [
    () => anthropicSse([{ type: "text", text: "No Q3 doc yet." }], "end_turn"),
  ]);
  const before = withoutCacheControl(first.bodies[1]!.messages) as unknown[];
  const after = withoutCacheControl(second.bodies[0]!.messages) as unknown[];
  const finalAssistant = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Found it.", signature: "sig-two" },
      { type: "text", text: "It is in shared/q2.md." },
    ],
  };
  assert.equal(JSON.stringify(after.slice(0, before.length + 1)), JSON.stringify([...before, finalAssistant]));
  assert.deepEqual(after.slice(before.length + 1), [
    { role: "user", content: [{ type: "text", text: "thanks, and the Q3 one?" }] },
  ]);
});

test("a turn on a later day is prompted under that day's marker and replays it byte-for-byte on the next turn", async () => {
  const reply = (text: string) => () => anthropicSse([{ type: "text", text }], "end_turn");
  const userTexts = (body: Body) =>
    (body.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
      .filter((m) => m.role === "user")
      .map((m) => m.content.find((b) => b.type === "text")?.text);
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-16T17:00:00Z") });
  try {
    const friday = await runTurn("the deadline is Friday", [], [reply("Noted.")]);
    mock.timers.setTime(Date.parse("2026-10-19T18:00:00Z"));
    const monday = await runTurn("has the deadline passed?", forModelContext(friday.emitted), [reply("Yes.")]);
    assert.deepEqual(userTexts(monday.bodies[0]!), [
      "── Friday, October 16, 2026 ──\nthe deadline is Friday",
      "── Monday, October 19, 2026 ──\nhas the deadline passed?",
    ]);
    const later = await runTurn("thanks", forModelContext([...friday.emitted, ...monday.emitted]), [reply("Sure.")]);
    const before = withoutCacheControl(monday.bodies[0]!.messages) as unknown[];
    const after = withoutCacheControl(later.bodies[0]!.messages) as unknown[];
    assert.equal(JSON.stringify(after.slice(0, before.length)), JSON.stringify(before));
    assert.equal(userTexts(later.bodies[0]!).at(-1), "thanks");
  } finally {
    mock.timers.reset();
  }
});

test("the next turn's OpenAI Responses request replays the previous turn's reasoning items, messages and calls exactly", async () => {
  const reasoning = (id: string, text: string) => ({
    type: "reasoning",
    id,
    summary: [{ type: "summary_text", text }],
    encrypted_content: `enc-${id}`,
  });
  const message = (id: string, text: string) => ({
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });
  const step1: Reply = [
    reasoning("rs_1", "Search history."),
    message("msg_1", "Checking the history first."),
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "history",
      arguments: '{"query":"budget","limit":5}',
    },
  ];
  const step2: Reply = [reasoning("rs_2", ""), message("msg_2", "It is in shared/q2.md.")];
  const overrides: Partial<HarnessTurnInput> = {
    runtime: { modelId: "gpt-5.4" },
    providerKeys: { openai: "sk-openai" },
  };
  const first = await runTurn(
    "where is the budget doc?",
    [],
    [() => openaiSse(step1), () => openaiSse(step2)],
    overrides,
  );
  assert.equal(first.result.reply, "It is in shared/q2.md.");
  const second = await runTurn(
    "thanks, and the Q3 one?",
    forModelContext(first.emitted),
    [() => openaiSse([message("msg_3", "No Q3 doc yet.")])],
    overrides,
  );
  const before = first.bodies[1]!.input!;
  const after = second.bodies[0]!.input!;
  const finalItems = [
    reasoning("rs_2", ""),
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "It is in shared/q2.md.", annotations: [] }],
      status: "completed",
      id: "msg_2",
    },
  ];
  assert.equal(JSON.stringify(after.slice(0, before.length + 2)), JSON.stringify([...before, ...finalItems]));
  assert.deepEqual(after.slice(before.length + 2), [
    { role: "user", content: [{ type: "input_text", text: "thanks, and the Q3 one?" }] },
  ]);
});

test("a steer and an empty-ending re-prompt replay as the exact user messages the model saw", async () => {
  const signals = createMemoryRunSignalStore();
  const first = await runTurn(
    "where is the budget doc?",
    [],
    [
      () =>
        anthropicSse([{ type: "tool_use", id: "toolu_1", name: "history", input: { query: "budget" } }], "tool_use"),
      () => anthropicSse([{ type: "thinking", thinking: "Nothing to add.", signature: "sig-empty" }], "end_turn"),
      () => anthropicSse([{ type: "text", text: "Q2 is in shared/q2.md; no Q3 doc." }], "end_turn"),
    ],
    { prepareSteer: async (text) => ({ text: `<steer>${text}</steer>` }) },
    signals,
    async () => {
      await signals.send("run-1", { kind: "steer", text: "also check Q3", ts: "steer.1" });
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  );
  assert.equal(first.result.reply, "Q2 is in shared/q2.md; no Q3 doc.");
  assert.equal(first.bodies.length, 3);
  const steered = first.emitted.find((e) => (e.payload as { steered?: boolean }).steered)!;
  assert.equal(
    (steered.payload as { text?: string }).text,
    "also check Q3",
    "the transcript keeps what the person typed",
  );

  const second = await runTurn("thanks", forModelContext(first.emitted), [
    () => anthropicSse([{ type: "text", text: "Anytime." }], "end_turn"),
  ]);
  const before = withoutCacheControl(first.bodies[2]!.messages) as unknown[];
  const after = withoutCacheControl(second.bodies[0]!.messages) as unknown[];
  assert.match(JSON.stringify(before), /<steer>also check Q3<\/steer>/);
  assert.ok(JSON.stringify(before).includes(JSON.stringify(EMPTY_ENDING_NOTE)), "the re-prompt reached the model");
  assert.equal(
    JSON.stringify(after.slice(0, before.length + 1)),
    JSON.stringify([
      ...before,
      { role: "assistant", content: [{ type: "text", text: "Q2 is in shared/q2.md; no Q3 doc." }] },
    ]),
  );
});

const PNG_A = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("user and steer images replay as the exact image blocks the model saw, restored from their durable files", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  for (const [id, data] of [
    ["art-photo", PNG_A],
    ["art-steer", PNG_B],
  ] as const)
    await files.put({
      id,
      ownerScopeId: "personal:tester" as never,
      createdBy: "tester",
      name: `${id}.png`,
      path: `${id}.png`,
      mimetype: "image/png",
      data: Buffer.from(data, "base64"),
      direction: "in",
      createdAt: 1,
    });
  const signals = createMemoryRunSignalStore();
  const first = await runTurn(
    "what is in this photo?",
    [],
    [
      () => anthropicSse([{ type: "tool_use", id: "toolu_1", name: "history", input: { query: "photo" } }], "tool_use"),
      () => anthropicSse([{ type: "text", text: "A single pixel, twice." }], "end_turn"),
    ],
    {
      images: [{ mimeType: "image/png", dataBase64: PNG_A, artifactId: "art-photo" }],
      prepareSteer: async (text) => ({
        text,
        images: [{ mimeType: "image/png", dataBase64: PNG_B, artifactId: "art-steer" }],
      }),
    },
    signals,
    async () => {
      await signals.send("run-1", { kind: "steer", text: "and this one", ts: "steer.img" });
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  );
  assert.equal(first.result.reply, "A single pixel, twice.");
  assert.doesNotMatch(JSON.stringify(first.emitted), new RegExp(PNG_A.slice(30, 60)), "no image bytes in entries");

  const second = await runTurn(
    "thanks",
    forModelContext(first.emitted),
    [() => anthropicSse([{ type: "text", text: "Anytime." }], "end_turn")],
    { loadImage: artifactImageLoader(files, () => true) },
  );
  const before = withoutCacheControl(first.bodies[1]!.messages) as unknown[];
  const after = withoutCacheControl(second.bodies[0]!.messages) as unknown[];
  const image = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  const sent = JSON.stringify(before);
  assert.ok(sent.includes(JSON.stringify(image(PNG_A))) && sent.includes(JSON.stringify(image(PNG_B))));
  assert.equal(
    JSON.stringify(after.slice(0, before.length + 1)),
    JSON.stringify([...before, { role: "assistant", content: [{ type: "text", text: "A single pixel, twice." }] }]),
  );
});

test("a tool result that cannot be recorded stops the turn with that error before the model sees it", async () => {
  const failing = new Error("session store unavailable");
  let modelCalledAgain = false;
  await assert.rejects(
    runTurn(
      "where is the budget doc?",
      [],
      [
        () =>
          anthropicSse([{ type: "tool_use", id: "toolu_1", name: "history", input: { query: "budget" } }], "tool_use"),
        () => {
          modelCalledAgain = true;
          return anthropicSse([{ type: "text", text: "unreachable" }], "end_turn");
        },
      ],
      {
        emit: async (e: NewEntry) => {
          if (e.type === "tool_result") throw failing;
          return {
            sessionId: "fidelity",
            seq: 1,
            parentSeq: null,
            type: e.type,
            payload: e.payload,
            scopeLabel: e.scopeLabel,
            createdAt: 0,
          };
        },
      },
    ),
    (err) => err === failing,
  );
  assert.equal(modelCalledAgain, false);
});

test("a parallel call's result is recorded as soon as its tool returns, while a sibling is still running", async () => {
  const recorded: Array<{ type: string; callId?: unknown }> = [];
  let seenBeforeSlowFinished: string[] = [];
  let seq = 1;
  const result = await runTurn(
    "check both",
    [],
    [
      () =>
        anthropicSse(
          [
            { type: "tool_use", id: "toolu_fast", name: "history", input: { query: "fast" } },
            { type: "tool_use", id: "toolu_slow", name: "history", input: { query: "slow" } },
          ],
          "tool_use",
        ),
      () => anthropicSse([{ type: "text", text: "done" }], "end_turn"),
    ],
    {
      tools: {
        async history(query: string) {
          if (query === "slow") {
            await new Promise((resolve) => setTimeout(resolve, 100));
            seenBeforeSlowFinished = recorded.filter((e) => e.type === "tool_result").map((e) => String(e.callId));
          }
          return [`result for ${query}`];
        },
      } as unknown as ToolContext,
      emit: async (e: NewEntry) => {
        recorded.push({ type: e.type, callId: (e.payload as { callId?: unknown }).callId });
        return {
          sessionId: "fidelity",
          seq: seq++,
          parentSeq: null,
          type: e.type,
          payload: e.payload,
          scopeLabel: e.scopeLabel,
          createdAt: 0,
        };
      },
    },
  );
  assert.equal(result.result.reply, "done");
  assert.deepEqual(seenBeforeSlowFinished, ["toolu_fast"]);
});

test("a replayed image is read from the file store once, not on every turn", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  await files.put({
    id: "art-once",
    ownerScopeId: "personal:tester" as never,
    createdBy: "tester",
    name: "once.png",
    path: "once.png",
    mimetype: "image/png",
    data: Buffer.from(PNG_A, "base64"),
    direction: "in",
    createdAt: 1,
  });
  let opens = 0;
  const open = files.open.bind(files);
  files.open = async (id) => {
    opens += 1;
    return open(id);
  };
  const load = artifactImageLoader(files, () => true);
  const first = await load({ artifactId: "art-once", mimeType: "image/png" }, 10_000_000);
  const second = await load({ artifactId: "art-once", mimeType: "image/png" }, 10_000_000);
  assert.deepEqual([first, second, opens], [{ data: PNG_A, sizeBytes: 70 }, { data: PNG_A, sizeBytes: 70 }, 1]);
});

const PG_URL = process.env.DATABASE_URL;

async function withPgSession(
  fn: (ctx: {
    emit: HarnessTurnInput["emit"];
    history: () => Promise<SessionEntry[]>;
    toolOutput: ToolOutputStore;
  }) => Promise<void>,
): Promise<void> {
  const { randomUUID } = await import("node:crypto");
  const { createPostgresSessionStore } = await import("../src/sessions/postgres-session-store.ts");
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: PG_URL });
  const schema = `replay_pg_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new globalThis.URL(PG_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const store = createPostgresSessionStore(url.toString());
  const raw = new pg.Pool({ connectionString: url.toString() });
  try {
    const session = await store.getOrCreateByThread(
      "web:replay",
      "dm",
      "personal:tester" as SessionEntry["scopeLabel"],
    );
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    await raw.query("INSERT INTO qm_settings(key,value) VALUES('tool_result_inline_tokens','256')");
    await fn({
      toolOutput: createPostgresToolOutputStore({
        pool: { q: async (sql, params) => (await raw.query(sql, params)).rows },
        bytesFor: () => createMemoryDurableByteStore(),
      }),
      emit: (entry) => store.append({ ...lease, turnId: "run-pg" }, entry),
      history: async () => forModelContext(await store.getEntries(session.id)),
    });
    await store.releaseLease(lease);
  } finally {
    await raw.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

const bigResult = "row ünï 🚀 ".repeat(4_000);
const pgTools = {
  async history() {
    return [bigResult];
  },
} as unknown as ToolContext;

test(
  "after a round trip through Postgres items, the next anthropic request replays a cut result and a delivery byte-for-byte",
  { skip: PG_URL ? false : "set DATABASE_URL" },
  async () => {
    await withPgSession(async ({ emit, history, toolOutput }) => {
      const step1: Reply = [
        { type: "thinking", thinking: "I should search history.", signature: "sig-one" },
        { type: "text", text: "Checking." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "history",
          input: { query: "budget", type: "dm", nested: { a: [1] } },
        },
        { type: "tool_use", id: "toolu_2", name: "history", input: { limit: "many" } },
      ];
      const step2: Reply = [
        { type: "thinking", thinking: "Found it.", signature: "sig-two" },
        { type: "text", text: "Done." },
      ];
      const tools = { ...pgTools, toolOutput } as ToolContext;
      const first = await runTurn(
        "where is the budget doc?",
        [],
        [() => anthropicSse(step1, "tool_use"), () => anthropicSse(step2, "end_turn")],
        { emit, tools },
      );
      const scopeLabel = "personal:tester" as SessionEntry["scopeLabel"];
      await emit({ type: "assistant", payload: { text: "Daily digest", via: "cron" }, scopeLabel });
      const second = await runTurn(
        "and Q3?",
        await history(),
        [() => anthropicSse([{ type: "text", text: "None." }], "end_turn")],
        { emit, tools },
      );
      const before = withoutCacheControl(first.bodies[1]!.messages) as unknown[];
      const after = withoutCacheControl(second.bodies[0]!.messages) as unknown[];
      assert.ok(!JSON.stringify(before).includes(bigResult.trim()));
      assert.match(JSON.stringify(before), /tool-output\/md5\/[0-9a-f]{32}/);
      assert.equal(JSON.stringify(after.slice(0, before.length)), JSON.stringify(before));
      assert.deepEqual(after.slice(before.length), [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Found it.", signature: "sig-two" },
            { type: "text", text: "Done." },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "Daily digest" }] },
        { role: "user", content: [{ type: "text", text: "and Q3?" }] },
      ]);
    });
  },
);

test(
  "after a round trip through Postgres items, the next OpenAI Responses request replays the previous turn exactly",
  { skip: PG_URL ? false : "set DATABASE_URL" },
  async () => {
    await withPgSession(async ({ emit, history }) => {
      const reasoning = (id: string, text: string) => ({
        type: "reasoning",
        id,
        summary: [{ type: "summary_text", text }],
        encrypted_content: `enc-${id}`,
      });
      const message = (id: string, text: string) => ({
        type: "message",
        id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      });
      const overrides: Partial<HarnessTurnInput> = {
        runtime: { modelId: "gpt-5.4" },
        providerKeys: { openai: "sk-openai" },
        emit,
        tools: pgTools,
      };
      const step1: Reply = [
        reasoning("rs_1", "Search history."),
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "history",
          arguments: '{"type":"dm","query":"budget"}',
        },
      ];
      const first = await runTurn(
        "where is the budget doc?",
        [],
        [() => openaiSse(step1), () => openaiSse([reasoning("rs_2", ""), message("msg_2", "Done.")])],
        overrides,
      );
      const second = await runTurn(
        "and Q3?",
        await history(),
        [() => openaiSse([message("msg_3", "None.")])],
        overrides,
      );
      const before = first.bodies[1]!.input!;
      const after = second.bodies[0]!.input!;
      assert.ok(JSON.stringify(before).includes(bigResult.trim()));
      assert.equal(JSON.stringify(after.slice(0, before.length)), JSON.stringify(before));
    });
  },
);
