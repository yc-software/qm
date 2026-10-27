import { test } from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { createAgentTools } from "../../src/harness/agent-tools.ts";
import { createTurnToolState, type TurnToolStateInit } from "../../src/harness/turn-tool-state.ts";
import type { ToolContext } from "../../src/tools/primitives.ts";
import { fakeToolContext, type Emitted, emittedItem, call, tool, textOut } from "../support/agent-tools.ts";

test("cron/webhook register only when controlTools is on; instructions registers with controlTools OR surfaceTools", () => {
  const off = createAgentTools(createTurnToolState({ current: fakeToolContext() }));
  assert.ok(!off.some((t) => ["cron", "webhook", "instructions"].includes(t.name)), "off by default");
  const on = createAgentTools(createTurnToolState({ current: fakeToolContext() }), { controlTools: true }).map(
    (t) => t.name,
  );
  for (const name of ["cron", "webhook", "instructions"])
    assert.ok(on.includes(name), `${name} registers when controlTools is on`);
  const surfaceOnly = createAgentTools(createTurnToolState({ current: fakeToolContext() }), { surfaceTools: true }).map(
    (t) => t.name,
  );
  assert.ok(surfaceOnly.includes("instructions"), "instructions registers when surfaceTools is on");
  assert.ok(!surfaceOnly.includes("cron") && !surfaceOnly.includes("webhook"), "cron/webhook stay control-only");
});

test("cron create dispatches and reports the created cron + resolved recipient", async () => {
  const out = textOut(
    await call(tool("cron"), {
      action: "create",
      title: "Gmail digest",
      schedule: { everyMs: 3_600_000 },
      task: "check gmail",
      recipient: "Bob",
    }),
  );
  assert.match(out, /Created cron/);
  assert.match(out, /Gmail digest/);
  assert.match(out, /Addressed to Bob \(DM\)/);
});

test("cron create requires a schedule and a task/text — crisp [error], no throw", async () => {
  assert.match(textOut(await call(tool("cron"), { action: "create", task: "x" })), /\[error\].*requires `schedule`/);
  assert.match(
    textOut(await call(tool("cron"), { action: "create", schedule: { everyMs: 1000 } })),
    /\[error\].*requires `task` .* or `text`/,
  );
});

test("cron note dispatches, and requires a non-empty note", async () => {
  assert.match(
    textOut(await call(tool("cron"), { action: "note", id: "cron-1", note: "Quiet. Updated data. No issues." })),
    /Noted — the next fire of cron-1 will see it\./,
  );
  assert.match(textOut(await call(tool("cron"), { action: "note", id: "cron-1" })), /\[error\].*requires `note`/);
  assert.match(
    textOut(await call(tool("cron"), { action: "note", id: "cron-1", note: "   " })),
    /\[error\].*requires `note`/,
  );
});

test("cron note admits it when a newer note superseded the write, instead of claiming success", async () => {
  const tc: ToolContext = {
    ...fakeToolContext(),
    async cronNote() {
      return { ok: true, applied: false };
    },
  };
  const out = textOut(await call(tool("cron", tc), { action: "note", id: "cron-1", note: "old shift report" }));
  assert.match(out, /\[not stored\] a newer shift-change note for cron-1 already exists/);
  assert.doesNotMatch(out, /Noted — the next fire/);
});

test("cron note rejects arguments exceeding the advertised cap before dispatch", async () => {
  const tc: ToolContext = {
    ...fakeToolContext(),
    async cronNote() {
      return { ok: false, code: "bad_request", message: "the note is 401 chars — the cap is 400." };
    },
  };
  assert.match(
    textOut(await call(tool("cron", tc), { action: "note", id: "cron-1", note: "x".repeat(401) })),
    /\[error\] Invalid arguments for cron action note/,
  );
});

test("cron list/get/runs/patch/delete/run/disable each dispatch", async () => {
  assert.match(textOut(await call(tool("cron"), { action: "list" })), /cron-1/);
  assert.match(textOut(await call(tool("cron"), { action: "get", id: "cron-1" })), /Gmail digest/);
  assert.match(textOut(await call(tool("cron"), { action: "runs", id: "cron-1", limit: 1 })), /checked inbox/);
  assert.match(
    textOut(await call(tool("cron"), { action: "patch", id: "cron-1", title: "renamed" })),
    /Updated cron.*renamed/s,
  );
  assert.match(textOut(await call(tool("cron"), { action: "delete", id: "cron-1" })), /Deleted cron cron-1/);
  assert.match(textOut(await call(tool("cron"), { action: "run", id: "cron-1" })), /Fired cron cron-1/);
  assert.match(textOut(await call(tool("cron"), { action: "disable", id: "cron-1" })), /Paused cron cron-1/);
});

test("cron list paginates live-first/newest-first with a footer naming the next offset", async () => {
  const mk = (i: number, over: Record<string, unknown> = {}) => ({
    id: `cron-${String(i).padStart(3, "0")}`,
    ownerScopeId: "personal:U1",
    owner: "U1",
    createdBy: "U1",
    enabled: true,
    createdAt: i,
    schedule: { everyMs: 3_600_000 },
    title: `t${i}`,
    action: "do the thing",
    ...over,
  });
  const crons = [
    mk(100, { enabled: false, action: `long ${"x".repeat(400)}` }),
    mk(101, { enabled: false, archived: true }),
    ...Array.from({ length: 30 }, (_, i) => mk(i)),
  ];
  const visible = [mk(200, { id: "cron-vis", scopeName: "#team" })];
  const tc = { ...fakeToolContext(), cronList: async () => ({ crons, visible }) } as ToolContext;
  const t = tool("cron", tc);

  const page1 = textOut(await call(t, { action: "list" }));
  assert.match(page1, /\(showing 1–25 of 33; next page: offset: 25\)/);
  assert.equal(page1.match(/^- /gm)?.length, 25);
  assert.match(
    page1.split("\n")[0] ?? "",
    /\(read-only, #team\) cron-vis/,
    "enabled entries sort together regardless of ownership; newest first",
  );
  assert.doesNotMatch(page1, /cron-100|cron-101/, "paused/archived sink despite newer createdAt");
  assert.doesNotMatch(page1, /task text is trimmed/, "no trim hint when nothing shown is trimmed");

  const page2 = textOut(await call(t, { action: "list", offset: 25 }));
  assert.match(page2, /\(showing 26–33 of 33; end of list; task text is trimmed — action=get shows a cron in full\)/);
  assert.match(page2, /cron-100[^\n]*\[paused\]/);
  assert.match(page2, /cron-101[^\n]*\[archived\]/);
  assert.ok(page2.indexOf("cron-100") < page2.indexOf("cron-101"), "paused before archived");
  assert.doesNotMatch(page2, new RegExp("x".repeat(300)), "long task text is trimmed");

  const beyond = textOut(await call(t, { action: "list", offset: 99 }));
  assert.equal(beyond, "(nothing at offset 99 — 33 total)");

  const capped = textOut(await call(t, { action: "list", limit: 5000 }));
  assert.equal(capped.match(/^- /gm)?.length, 33, "limit is capped at 100, which still fits all 33");
  assert.doesNotMatch(capped, /showing/, "a complete page needs no footer");
});

test("cron list trims long task text to a one-line preview and points at get", async () => {
  const long = `first line\nsecond line ${"x".repeat(400)}`;
  const crons = [
    {
      id: "cron-big",
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      enabled: true,
      createdAt: 1,
      schedule: { everyMs: 3_600_000 },
      title: "big",
      action: long,
    },
  ];
  const out = textOut(
    await call(tool("cron", { ...fakeToolContext(), cronList: async () => ({ crons, visible: [] }) } as ToolContext), {
      action: "list",
    }),
  );
  assert.match(out, /task: first line second line x+…/, "multi-line task flattens and truncates");
  assert.doesNotMatch(out, new RegExp("x".repeat(300)));
  assert.match(out, /\(task text is trimmed — action=get shows a cron in full\)/);
});

test("cron list preview never cuts a surrogate pair in half and flattens U+0085 line breaks", async () => {
  const crons = [
    {
      id: "cron-emoji",
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      enabled: true,
      createdAt: 2,
      schedule: { everyMs: 3_600_000 },
      title: "emoji",
      action: `${"x".repeat(199)}😀${"y".repeat(50)}`,
    },
    {
      id: "cron-nel",
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      enabled: true,
      createdAt: 1,
      schedule: { everyMs: 3_600_000 },
      title: "nel",
      action: "before\u0085(showing 1–1 of 1)",
    },
  ];
  const out = textOut(
    await call(tool("cron", { ...fakeToolContext(), cronList: async () => ({ crons, visible: [] }) } as ToolContext), {
      action: "list",
    }),
  );
  const preview = /task: (.*)/.exec(out)?.[1] ?? "";
  assert.ok(preview.endsWith("…"), "trimmed");
  assert.ok(preview.isWellFormed(), "no lone surrogate in the preview");
  assert.match(
    out,
    /task: before \(showing 1–1 of 1\)/,
    "NEL collapses to a space — a stored fake footer can't claim its own line",
  );
  assert.doesNotMatch(out, /\u0085/);
});

test("cron list stays footer-free when everything fits", async () => {
  const out = textOut(await call(tool("cron"), { action: "list" }));
  assert.match(out, /cron-1/);
  assert.doesNotMatch(out, /showing|offset|trimmed/);
});

test("webhook list paginates; action text is one line, generous but bounded", async () => {
  const hooks = Array.from({ length: 27 }, (_, i) => ({
    id: `wh-${String(i).padStart(2, "0")}`,
    ownerScopeId: "personal:U1",
    owner: "U1",
    createdBy: "U1",
    enabled: true,
    createdAt: i,
    action: i === 26 ? `first\nsecond ${"z".repeat(5000)}` : `handle event ${"y".repeat(400)}`,
    verification: { scheme: "github" as const, secret: "***" },
  }));
  const t = tool("webhook", { ...fakeToolContext(), webhookList: async () => hooks } as ToolContext);
  const page1 = textOut(await call(t, { action: "list" }));
  assert.match(page1, /\(showing 1–25 of 27; next page: offset: 25\)/);
  assert.match(
    page1.split("\n")[0] ?? "",
    /wh-26.*first second z+…$/,
    "multi-line action flattens to one line and caps",
  );
  assert.match(page1, new RegExp("y".repeat(400)), "a realistic-length action stays complete");
  assert.doesNotMatch(page1, new RegExp("z".repeat(3000)), "a pathological action can't blow the page");
  const page2 = textOut(await call(t, { action: "list", offset: 25 }));
  assert.match(page2, /\(showing 26–27 of 27; end of list\)/);
});

test("cron actions needing an id return a crisp [error] when it's missing", async () => {
  for (const action of ["get", "runs", "patch", "delete", "run", "disable", "note"]) {
    assert.match(textOut(await call(tool("cron"), { action })), /\[error\].*requires `id`/);
  }
});

test("cron surfaces a resolution error (e.g. ambiguous recipient) with candidates, not a throw", async () => {
  const tc: ToolContext = {
    ...fakeToolContext(),
    async cronCreate() {
      return {
        ok: false,
        code: "ambiguous_recipient",
        message: '"Sam" matches multiple teammates',
        candidates: [
          { id: "U2", label: "Sam Lee" },
          { id: "U3", label: "Sam Park" },
        ],
      };
    },
  };
  const out = textOut(
    await call(tool("cron", tc), { action: "create", schedule: { firstFireAt: 1 }, text: "hi", recipient: "Sam" }),
  );
  assert.match(out, /\[error\].*matches multiple teammates/);
  assert.match(out, /Sam Lee \(U2\)/);
  assert.match(out, /Sam Park \(U3\)/);
});

test("webhook create surfaces BOTH the url and the secret verbatim", async () => {
  const out = textOut(
    await call(tool("webhook"), {
      action: "create",
      task: "handle it",
      verification: { scheme: "github", secret: "shh-123" },
    }),
  );
  assert.match(out, /https:\/\/portal\.example\/v1\/webhooks\/incoming\/wh-1/);
  assert.match(out, /shh-123/);
  assert.match(out, /won't fire until the sender is pointed/);
});

test("webhook create requires task + verification; list and disable dispatch", async () => {
  assert.match(
    textOut(await call(tool("webhook"), { action: "create", task: "x" })),
    /\[error\].*requires `task` .* and `verification`/,
  );
  assert.match(textOut(await call(tool("webhook"), { action: "list" })), /wh-1/);
  assert.match(textOut(await call(tool("webhook"), { action: "disable", id: "wh-1" })), /Disabled webhook wh-1/);
  assert.match(textOut(await call(tool("webhook"), { action: "disable" })), /\[error\].*requires `id`/);
});

test("instructions reads the scope's own text; replace requires content and reports the version", async () => {
  assert.equal(textOut(await call(tool("instructions"), { action: "read" })), "Be terse.");
  assert.match(textOut(await call(tool("instructions"), { action: "replace", content: "New text." })), /version 4/);
  assert.match(textOut(await call(tool("instructions"), { action: "replace" })), /\[error\].*needs `content`/);
});

test("instructions with no own text does not return inherited policy", async () => {
  for (const instructions of [null, ""]) {
    const tc: ToolContext = {
      ...fakeToolContext(),
      instructionsRead: () => ({ effectiveInstructions: "Org policy.", instructions, instructionsVersion: 0 }),
    };
    assert.equal(textOut(await call(tool("instructions", tc), { action: "read" })), "(no instructions set)");
  }
});

test("instructions read then replace keeps inherited policy out of saved instructions", async () => {
  let saved = "Be terse.";
  const tc: ToolContext = {
    ...fakeToolContext(),
    instructionsRead: () => ({
      effectiveInstructions: `Org policy.\n\n${saved}`,
      instructions: saved,
      instructionsVersion: 3,
    }),
    async instructionsWrite(content) {
      saved = content;
      return { ok: true, version: 4 };
    },
  };
  const instructions = tool("instructions", tc);
  const content = textOut(await call(instructions, { action: "read" }));
  await call(instructions, { action: "replace", content: `${content}\nUse plain text.` });
  assert.equal(saved, "Be terse.\nUse plain text.");
});

test("in a channel, instructions also reads and writes ambient replies and the bot ledger", async () => {
  let ambientEnabled: boolean | undefined;
  let bots: Record<string, { mode: "ignore" | "rollup" | "action" | "user"; rollupHours?: number }> = {
    newsbot: { mode: "rollup", rollupHours: 6 },
  };
  const writes: string[] = [];
  const tc: ToolContext = {
    ...fakeToolContext(),
    async getChannelBehavior() {
      return { ok: true, bots, ...(ambientEnabled === undefined ? {} : { ambientEnabled }) };
    },
    async setChannelBehavior(nextBots, nextAmbientEnabled) {
      if (nextBots) bots = nextBots;
      if (nextAmbientEnabled !== undefined) ambientEnabled = nextAmbientEnabled ?? undefined;
      return { ok: true, bots, ...(ambientEnabled === undefined ? {} : { ambientEnabled }) };
    },
    async instructionsWrite(content) {
      writes.push(content);
      return { ok: true, version: 4 };
    },
  };
  const read = async () => textOut(await call(tool("instructions", tc), { action: "read" }));
  assert.match(await read(), /Be terse\.[\s\S]*Ambient replies: default[\s\S]*newsbot: rollup \(every 6h\)/);
  assert.match(
    textOut(await call(tool("instructions", tc), { action: "replace", ambientEnabled: true })),
    /channel settings updated/,
  );
  assert.deepEqual(writes, [], "a settings-only change leaves the instructions text alone");
  assert.match(await read(), /Ambient replies: on/);
  await call(tool("instructions", tc), { action: "replace", content: "keep watching" });
  assert.deepEqual(writes, ["keep watching"]);
  assert.match(await read(), /Ambient replies: on/);
  await call(tool("instructions", tc), {
    action: "replace",
    ambientEnabled: null,
    bots: { newsbot: { mode: "ignore" } },
  });
  assert.match(await read(), /Ambient replies: default[\s\S]*newsbot: ignore/);
});

test("instructions edit swaps one exact passage and refuses ambiguous or missing matches", async () => {
  const writes: Array<{ content: string; expectedVersion?: number }> = [];
  const tc: ToolContext = {
    ...fakeToolContext(),
    instructionsRead() {
      return {
        effectiveInstructions: "Org policy.\n\nBe terse. Use $1 sparingly.\nwatch tweets\nwatch tweets",
        instructions: "Be terse. Use $1 sparingly.\nwatch tweets\nwatch tweets",
        instructionsVersion: 3,
      };
    },
    async instructionsWrite(content, expectedVersion) {
      writes.push({ content, ...(expectedVersion !== undefined ? { expectedVersion } : {}) });
      return { ok: true, version: 4 };
    },
  };
  const edit = (args: Record<string, unknown>) => call(tool("instructions", tc), { action: "edit", ...args });
  assert.match(textOut(await edit({ old: "watch tweets", new: "x" })), /\[error\].*more than once/);
  assert.match(textOut(await edit({ old: "absent", new: "x" })), /\[error\].*no exact match/);
  assert.match(textOut(await edit({ content: "everything" })), /\[error\].*requires `old`/);
  assert.match(textOut(await edit({ old: "Org policy.", new: "x" })), /no exact match/);
  assert.deepEqual(writes, []);
  assert.match(textOut(await edit({ old: "Be terse.", new: "Be $& brief." })), /version 4/);
  assert.deepEqual(writes, [
    { content: "Be $& brief. Use $1 sparingly.\nwatch tweets\nwatch tweets", expectedVersion: 3 },
  ]);
  assert.ok(!Check(tool("instructions").parameters, { action: "write", content: "x" }));
});

test("instructions rejects channel settings outside a channel", async () => {
  const tc: ToolContext = {
    ...fakeToolContext(),
    async getChannelBehavior() {
      return { ok: false, message: "channel settings apply only inside a channel." };
    },
  };
  assert.match(
    textOut(await call(tool("instructions", tc), { action: "replace", content: "Be terse.", ambientEnabled: true })),
    /\[error\].*apply only in a channel/,
  );
  assert.equal(textOut(await call(tool("instructions", tc), { action: "read" })), "Be terse.");
});

test("control tools degrade to a crisp [error] when the turn has no self-API (CONTROL_UNAVAILABLE)", async () => {
  const { CONTROL_UNAVAILABLE } = await import("../../src/tools/primitives.ts");
  const tc: ToolContext = {
    ...fakeToolContext(),
    async cronCreate() {
      return CONTROL_UNAVAILABLE;
    },
    async webhookList() {
      return CONTROL_UNAVAILABLE;
    },
    async getChannelBehavior() {
      return { ok: false, message: "channel settings aren't available on this turn" };
    },
    instructionsRead() {
      return CONTROL_UNAVAILABLE;
    },
  };
  assert.match(
    textOut(await call(tool("cron", tc), { action: "create", schedule: { everyMs: 1000 }, task: "x" })),
    /\[error\].*aren't available on this turn/,
  );
  assert.match(
    textOut(await call(tool("webhook", tc), { action: "list" })),
    /\[error\].*aren't available on this turn/,
  );
  assert.match(
    textOut(await call(tool("instructions", tc), { action: "read" })),
    /\[error\].*aren't available on this turn/,
  );
});

test("typed control tools emit tool_call then tool_result like every other tool", async () => {
  const emitted: Emitted[] = [];
  const ref: TurnToolStateInit = {
    current: fakeToolContext(),
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "personal:U1",
  };
  const cronTool = createAgentTools(createTurnToolState(ref), { controlTools: true }).find((t) => t.name === "cron")!;
  await call(cronTool, { action: "list" });
  assert.deepEqual(
    emitted.map((e) => `${e.kind}:${e.fields.tool}`),
    ["ToolCall:cron", "ToolResult:cron"],
  );
});
