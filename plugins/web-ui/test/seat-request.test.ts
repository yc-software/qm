import assert from "node:assert/strict";
import test from "node:test";
import {
  argsTemplate,
  buildMove,
  draftFromBlocks,
  messageViews,
  renderBlock,
  systemTexts,
  withoutImageData,
  type SeatRequest,
} from "../src/seat-request.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const request: SeatRequest = {
  model: "claude-test",
  system: [
    { type: "text", text: "You are QM." },
    { type: "text", text: "Be brief." },
  ],
  tools: [
    {
      name: "execute",
      description: "Run a shell command.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_seconds: { type: "integer" },
          scope: { type: "string", enum: ["scoped", "scratch"] },
          background: { type: "boolean" },
        },
        required: ["command", "scope", "background"],
      },
    },
  ],
  messages: [
    { role: "user", content: "list files" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Looking." },
        { type: "tool_use", id: "tu1", name: "execute", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "a.txt\nb.txt" }], is_error: true },
        { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
      ],
    },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
    { role: "user", content: "thanks" },
  ],
};

test("system blocks are shown verbatim whether the request uses a string or text blocks", () => {
  assert.deepEqual(systemTexts(request), ["You are QM.", "Be brief."]);
  assert.deepEqual(systemTexts({ system: "Plain system." }), ["Plain system."]);
  assert.deepEqual(systemTexts({}), []);
});

test("messages render every block verbatim with the latest ones open", () => {
  const views = messageViews(request);
  assert.deepEqual(
    views.map((m) => [m.role, m.open, m.preview]),
    [
      ["user", false, "list files"],
      ["assistant", true, "Looking."],
      ["user", true, "tool_result tu1 · error a.txt b.txt"],
      ["assistant", true, "thinking hmm"],
      ["user", true, "thanks"],
    ],
  );
  assert.deepEqual(views[1]!.blocks[1], {
    label: "tool_use execute · tu1",
    body: '{\n  "command": "ls"\n}',
    code: true,
  });
  assert.equal(views[2]!.blocks[0]!.body, "a.txt\nb.txt");
  assert.equal(views[2]!.blocks[1]!.body, "[image image/png, 70 B]");
  assert.equal(renderBlock({ type: "redacted_thinking", data: "x" }).body, "[redacted]");
});

test("raw request never carries image bytes", () => {
  const raw = JSON.stringify(withoutImageData(request));
  assert.ok(!raw.includes(png));
  assert.ok(raw.includes("[image image/png, 70 B]"));
  assert.ok(JSON.stringify(request).includes(png));
});

test("a picked tool starts from its required arguments", () => {
  assert.deepEqual(JSON.parse(argsTemplate(request.tools!, "execute")), {
    command: "",
    scope: "scoped",
    background: false,
  });
  assert.equal(argsTemplate(request.tools!, "missing"), "{}");
});

test("a move mixes reply text and tool calls, and refuses bad arguments", () => {
  const tools = request.tools!;
  assert.deepEqual(buildMove({ text: "On it.", calls: [{ name: "execute", args: '{"command":"pwd"}' }] }, tools), {
    content: [
      { type: "text", text: "On it." },
      { type: "tool_use", name: "execute", input: { command: "pwd" } },
    ],
  });
  assert.deepEqual(buildMove({ text: "", calls: [{ name: "execute", args: "" }] }, tools), {
    content: [{ type: "tool_use", name: "execute", input: {} }],
  });
  assert.deepEqual(buildMove({ text: "  ", calls: [] }, tools), { error: "Write a reply or add a tool call." });
  assert.deepEqual(buildMove({ text: "", calls: [{ name: "", args: "{}" }] }, tools), {
    error: "Pick a tool for each call.",
  });
  assert.deepEqual(buildMove({ text: "", calls: [{ name: "execute", args: "[1]" }] }, tools), {
    error: "execute arguments must be a JSON object.",
  });
  assert.match(
    (buildMove({ text: "", calls: [{ name: "execute", args: "{command:" }] }, tools) as { error: string }).error,
    /^execute arguments are not valid JSON: /,
  );
  assert.deepEqual(buildMove({ text: "", calls: [{ name: "nope", args: "{}" }] }, tools), {
    error: "nope is not one of this request's tools.",
  });
});

test("a model's answer becomes an editable draft", () => {
  assert.deepEqual(
    draftFromBlocks([
      { type: "text", text: "First." },
      { type: "tool_use", id: "x", name: "execute", input: { command: "ls" } },
      { type: "text", text: "Second." },
    ]),
    { text: "First.\n\nSecond.", calls: [{ name: "execute", args: '{\n  "command": "ls"\n}' }] },
  );
});
