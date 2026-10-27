import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTools, pauseStampAfterToolCall } from "../../src/harness/agent-tools.ts";
import { createTurnToolState, type TurnToolStateInit } from "../../src/harness/turn-tool-state.ts";
import type { ToolContext } from "../../src/tools/primitives.ts";
import { fakeToolContext, type Emitted, emittedItem, call, surfaceTool } from "../support/agent-tools.ts";

test("the surface tool registers only when surfaceTools is on, and post/read_thread delegate to the tool context", async () => {
  const refOff: TurnToolStateInit = { current: fakeToolContext(), scopeLabel: "channel:C1" };
  const off = createAgentTools(createTurnToolState(refOff)).map((t) => t.name);
  assert.ok(!off.includes("slack"), "off by default (overheard path unchanged)");
  for (const n of [
    "post",
    "react",
    "edit",
    "delete",
    "read_thread",
    "whats_new",
    "search",
    "read_members",
    "read_file",
  ]) {
    assert.ok(!off.includes(n), `${n} is not a standalone tool`);
  }

  const emitted: Emitted[] = [];
  const ref: TurnToolStateInit = {
    current: fakeToolContext(),
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "channel:C1",
  };
  const slack = surfaceTool(ref);
  assert.equal(
    createAgentTools(createTurnToolState(ref), { surfaceTools: true }).filter((t) => t.name === "slack").length,
    1,
    "exactly one surface tool",
  );

  await call(slack, { action: "post", text: "hello there" });
  const posted = emitted.find((e) => e.kind === "ToolResult" && e.fields.action === "post")!.fields;
  assert.equal(posted.ok, true);
  assert.equal(posted.tool, "slack");

  await call(slack, { action: "read_thread" });
  const read = emitted.find((e) => e.kind === "ToolResult" && e.fields.action === "read_thread")!.fields;
  assert.equal(read.ok, true);
  assert.equal(read.count, 0);
});

test("the surface tool's react/edit/delete actions delegate to the tool context", async () => {
  const emitted: Emitted[] = [];
  const ref: TurnToolStateInit = {
    current: fakeToolContext(),
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "channel:C1",
  };
  const slack = surfaceTool(ref);

  await call(slack, { action: "react", ts: "173.4", emoji: "eyes" });
  await call(slack, { action: "edit", ref: "173.4", text: "fixed" });
  await call(slack, { action: "delete", ref: "173.4" });

  const result = (action: string) => emitted.find((e) => e.kind === "ToolResult" && e.fields.action === action)!.fields;
  assert.deepEqual(result("react"), {
    tool: "slack",
    action: "react",
    ok: true,
    callId: "t",
    isError: false,
    text: "[reacted]",
  });
  assert.deepEqual(result("edit"), {
    tool: "slack",
    action: "edit",
    ok: true,
    callId: "t",
    isError: false,
    text: "[edited]",
  });
  assert.deepEqual(result("delete"), {
    tool: "slack",
    action: "delete",
    ok: true,
    callId: "t",
    isError: false,
    text: "[deleted]",
  });

  assert.equal(emitted.find((e) => e.kind === "ToolCall" && e.fields.action === "react")!.fields.ts, "173.4");
  assert.equal(emitted.find((e) => e.kind === "ToolCall" && e.fields.action === "edit")!.fields.ref, "173.4");
  assert.equal(emitted.find((e) => e.kind === "ToolCall" && e.fields.action === "delete")!.fields.ref, "173.4");
});

test("post replies HERE only (placement via ts/broadcast, cross-targets rejected); reach carries every audience", async () => {
  const posts: any[] = [];
  const reaches: any[] = [];
  const capturing = {
    ...fakeToolContext(),
    async post(_text: string, opts?: unknown) {
      posts.push(opts);
      return { ok: true };
    },
    async reach(_text: string, target?: unknown) {
      reaches.push(target);
      return { ok: true, matched: "x" };
    },
  };
  const ref: TurnToolStateInit = { current: capturing, scopeLabel: "channel:C1" };
  const slack = surfaceTool(ref);
  await call(slack, { action: "post", text: "hi" });
  await call(slack, { action: "post", text: "hi", ts: "1.2" });
  await call(slack, { action: "post", text: "hi", broadcast: true });
  assert.deepEqual(posts, [{}, { ts: "1.2" }, { broadcast: true }], "post only ever gets ts/broadcast placement");
  const refused = (await call(slack, { action: "post", text: "hi", channel: "eng" })) as {
    content: Array<{ text: string }>;
  };
  assert.match(refused.content[0]!.text, /only replies in this conversation|reach/);
  assert.equal(posts.length, 3, "the rejected post never reached tc.post");
  await call(slack, { action: "reach", text: "hi", channel: "eng" });
  await call(slack, { action: "reach", text: "hi", recipient: "Alice" });
  await call(slack, { action: "reach", text: "hi", participants: ["U-a", "U-b"] });
  assert.deepEqual(reaches, [{ channel: "eng" }, { recipient: "Alice" }, { participants: ["U-a", "U-b"] }]);
});

test("edit/delete surface an own-messages-only failure as a tool_result, not a throw", async () => {
  const emitted: Emitted[] = [];
  const notOurs = {
    ...fakeToolContext(),
    async edit() {
      return { ok: false, message: "you can only edit your own messages" };
    },
    async delete() {
      return { ok: false, message: "you can only delete your own messages" };
    },
  };
  const ref: TurnToolStateInit = {
    current: notOurs,
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "channel:C1",
  };
  const slack = surfaceTool(ref);
  const editOut = (await call(slack, { action: "edit", ref: "999.9", text: "x" })) as {
    content: Array<{ text: string }>;
  };
  const delOut = (await call(slack, { action: "delete", ref: "999.9" })) as { content: Array<{ text: string }> };
  assert.match(editOut.content[0]!.text, /not edited.*your own messages/);
  assert.match(delOut.content[0]!.text, /not deleted.*your own messages/);
  assert.equal(emitted.find((e) => e.kind === "ToolResult" && e.fields.action === "edit")!.fields.ok, false);
  assert.equal(emitted.find((e) => e.kind === "ToolResult" && e.fields.action === "delete")!.fields.ok, false);
});

test("post reports a clean sentinel when the surface isn't wired this turn", async () => {
  const emitted: Emitted[] = [];
  const noSurface = {
    ...fakeToolContext(),
    async post() {
      return { ok: false, message: "no conversation here" };
    },
    async readThread() {
      return { ok: false, message: "no conversation here" };
    },
  };
  const ref: TurnToolStateInit = {
    current: noSurface,
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "channel:C1",
  };
  const slack = surfaceTool(ref);
  const out = (await call(slack, { action: "post", text: "hi" })) as { content: Array<{ text: string }> };
  assert.match(out.content[0]!.text, /not sent/);
  const result = emitted.find((e) => e.kind === "ToolResult" && e.fields.action === "post")!.fields;
  assert.equal(result.ok, false);
});

test("the surface tool's pull-query actions return pointers/data (not raw bytes)", async () => {
  const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  const emitted: Emitted[] = [];
  const ref: TurnToolStateInit = {
    current: fakeToolContext(),
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "channel:C1",
  };
  const slack = surfaceTool(ref);

  const wn = textOf(await call(slack, { action: "whats_new" }));
  assert.match(wn, /3 new in this thread/);
  assert.match(wn, /2 other threads active/);
  assert.match(wn, /1712345678\.9/);
  assert.match(wn, /pass this as `since`/);

  const hit = textOf(await call(slack, { action: "search", query: "budget" }));
  assert.match(hit, /Bob/);
  assert.match(hit, /budget doc/);
  const miss = textOf(await call(slack, { action: "search", query: "nothing-here" }));
  assert.match(miss, /nothing here matches/);

  const members = textOf(await call(slack, { action: "read_members" }));
  assert.match(members, /Ada/);
  assert.match(members, /Bob/);

  const txt = textOf(await call(slack, { action: "read_file", ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
  assert.match(txt, /hello from the file/);
  const bin = textOf(await call(slack, { action: "read_file", ref: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }));
  assert.match(bin, /not text/);
  assert.doesNotMatch(bin, /hello from the file/);
  const first = textOf(await call(slack, { action: "read_file", ref: "dddddddddddddddddddddddddddddddd" }));
  assert.match(first, /page one\n\[showing up to character 8 of 16 — read_file again with offset 8 for more\]/);
  const second = textOf(await call(slack, { action: "read_file", ref: "dddddddddddddddddddddddddddddddd", offset: 8 }));
  assert.equal(second, "page two");
  const gone = textOf(await call(slack, { action: "read_file", ref: "cccccccccccccccccccccccccccccccc" }));
  assert.match(gone, /couldn't read that file/);

  for (const n of ["whats_new", "search", "read_members", "read_file"]) {
    const pair = emitted.filter((e) => e.fields.action === n).map((e) => e.kind);
    assert.ok(pair.includes("ToolCall") && pair.includes("ToolResult"), `${n} emits call + result`);
  }
});

test("an unknown action returns a crisp error text, not a throw", async () => {
  const ref: TurnToolStateInit = { current: fakeToolContext(), scopeLabel: "channel:C1" };
  const slack = surfaceTool(ref);
  const out = (await call(slack, { action: "frobnicate" })) as { content: Array<{ text: string }> };
  assert.match(out.content[0]!.text, /unknown action "frobnicate"/);
  assert.match(out.content[0]!.text, /post, reach, react, edit, delete/);
});

test("a missing required field for an action returns a crisp error, not a throw", async () => {
  const ref: TurnToolStateInit = { current: fakeToolContext(), scopeLabel: "channel:C1" };
  const slack = surfaceTool(ref);
  const noText = (await call(slack, { action: "post" })) as { content: Array<{ text: string }> };
  assert.match(noText.content[0]!.text, /the "post" action requires `text`/);
  const noQuery = (await call(slack, { action: "search" })) as { content: Array<{ text: string }> };
  assert.match(noQuery.content[0]!.text, /the "search" action requires `query`/);
});

test("each action dispatches to exactly its matching tool-context method", async () => {
  const calls: Array<[string, unknown[]]> = [];
  const spy =
    (name: string, ret: unknown) =>
    (...args: unknown[]) => {
      calls.push([name, args]);
      return Promise.resolve(ret);
    };
  const tc = {
    ...fakeToolContext(),
    post: spy("post", { ok: true }),
    reach: spy("reach", { ok: true, matched: "x" }),
    react: spy("react", { ok: true }),
    edit: spy("edit", { ok: true }),
    delete: spy("delete", { ok: true }),
    readThread: spy("readThread", { ok: true, messages: [] }),
    whatsNew: spy("whatsNew", { ok: true, hereNew: 0, activeSubConversations: 0 }),
    search: spy("search", { ok: true, hits: [], source: "live" }),
    readMembers: spy("readMembers", { ok: true, members: [] }),
    readFile: spy("readFile", { ok: true, content: "x" }),
  } as unknown as ToolContext;
  const slack = surfaceTool({ current: tc, scopeLabel: "channel:C1" });

  await call(slack, { action: "post", text: "hi", files: [{ file_id: "saved" }], sandbox_id: "box" });
  await call(slack, { action: "react", ts: "1.1", emoji: "eyes" });
  await call(slack, { action: "edit", ref: "1.1", text: "y" });
  await call(slack, { action: "delete", ref: "1.1" });
  await call(slack, { action: "read_thread", limit: 5 });
  await call(slack, { action: "whats_new", since: "1.0" });
  await call(slack, { action: "search", query: "q", source: "slack" });
  await call(slack, { action: "read_members" });
  await call(slack, { action: "read_file", ref: "aaaa" });
  await call(slack, { action: "reach", text: "hi", channel: "eng", files: ["report.md"], sandbox_id: "box" });

  assert.deepEqual(
    calls.map((c) => c[0]),
    ["post", "react", "edit", "delete", "readThread", "whatsNew", "search", "readMembers", "readFile", "reach"],
  );
  assert.deepEqual(calls[0]![1], ["hi", {}, [{ file_id: "saved" }], "box"]);
  assert.deepEqual(calls[9]![1], ["hi", { channel: "eng" }, ["report.md"], "box"]);
  assert.deepEqual(calls[1]![1], [{ ts: "1.1", emoji: "eyes" }]);
  assert.deepEqual(calls[2]![1], [{ ref: "1.1", text: "y" }]);
  assert.deepEqual(calls[3]![1], [{ ref: "1.1" }]);
  assert.deepEqual(calls[4]![1], [{ limit: 5 }]);
  assert.deepEqual(calls[5]![1], [{ since: "1.0" }]);
  assert.deepEqual(calls[6]![1], ["q", { source: "slack" }]);
  assert.deepEqual(calls[7]![1], []);
  assert.deepEqual(calls[8]![1], ["aaaa"]);
});

test("the surface tool is NAMED after its surface — a telegram surface produces a `telegram` tool", async () => {
  const names = createAgentTools(createTurnToolState({ current: fakeToolContext(), scopeLabel: "channel:C1" }), {
    surfaceTools: true,
    surfaceName: "telegram",
  }).map((t) => t.name);
  assert.ok(names.includes("telegram"), "the tool is named after the surface");
  assert.ok(!names.includes("slack"), "no `slack` tool when the surface is telegram");
  const emitted: Emitted[] = [];
  const tg = surfaceTool(
    {
      current: fakeToolContext(),
      emit: (e) => {
        emitted.push(emittedItem(e));
      },
      scopeLabel: "channel:C1",
    },
    "telegram",
  );
  await call(tg, { action: "post", text: "hi" });
  const posted = emitted.find((e) => e.kind === "ToolResult" && e.fields.action === "post")!.fields;
  assert.equal(posted.tool, "telegram");
  assert.equal(posted.ok, true);
});

test("readOnly exposes observation and constrained session coordination without execution tools", () => {
  const ref: TurnToolStateInit = { current: fakeToolContext(), scopeLabel: "personal:U1" };
  const full = createAgentTools(createTurnToolState(ref), { controlTools: true, reachExec: true });
  const readOnly = createAgentTools(createTurnToolState(ref), { controlTools: true, reachExec: true, readOnly: true });

  const names = (ts: ReturnType<typeof createAgentTools>) => new Set(ts.map((t) => t.name));
  for (const t of ["execute", "background", "files", "apps", "cron", "webhook", "instructions"]) {
    assert.ok(names(full).has(t), `full toolset has ${t}`);
  }
  assert.deepEqual([...names(readOnly)].sort(), [
    "finish_silently",
    "history",
    "memory",
    "runtime",
    "subagents",
    "swarm",
  ]);
  for (const t of ["execute", "background", "files", "apps", "cron", "webhook", "instructions"]) {
    assert.ok(!names(readOnly).has(t), `read-only toolset drops ${t}`);
  }
});

test("finish_silently on a poll fire terminates the turn at the tool contract; off one it no-ops", async () => {
  const emitted: Emitted[] = [];
  const ref: TurnToolStateInit = {
    current: fakeToolContext(),
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "personal:U1",
    pollFire: true,
  };
  const state = createTurnToolState(ref);
  const finish = createAgentTools(state).find((t) => t.name === "finish_silently");
  const res = (await call(finish, { reason: "nothing new" })) as { terminate?: boolean };
  assert.equal(res.terminate, true);
  assert.equal(state.halt.silent(), true);
  assert.equal(
    emitted.filter(
      (e) => e.kind === "ToolCall" && e.fields.tool === "finish_silently" && e.fields.reason === "nothing new",
    ).length,
    1,
  );
  assert.equal(
    emitted.filter((e) => e.kind === "ToolResult" && e.fields.tool === "finish_silently" && e.fields.silent === true)
      .length,
    1,
  );

  const offFire = createTurnToolState({ ...ref, pollFire: false });
  const finishOff = createAgentTools(offFire).find((t) => t.name === "finish_silently");
  const noop = (await call(finishOff, { reason: "n/a" })) as {
    terminate?: boolean;
    content: Array<{ text?: string }>;
  };
  assert.notEqual(noop.terminate, true, "a person is waiting — the tool must not end the turn");
  assert.equal(offFire.halt.silent(), false);
  assert.match(noop.content[0]?.text ?? "", /no-op/);
});

test("finish_silently ends surface turns and replaces stay_silent", async () => {
  const emitted: Emitted[] = [];
  const ref: TurnToolStateInit = {
    current: fakeToolContext(),
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "personal:U1",
  };
  const state = createTurnToolState(ref);
  const tools = createAgentTools(state, { surfaceTools: true });
  assert.ok(!tools.some((t) => t.name === "stay_silent"));
  const finish = tools.find((t) => t.name === "finish_silently");
  const result = (await call(finish, { reason: "nothing new since the last check" })) as { terminate?: boolean };
  assert.equal(result.terminate, true);
  assert.equal(state.halt.silent(), true);
  assert.equal(
    emitted.filter(
      (e) =>
        e.kind === "ToolCall" &&
        e.fields.tool === "finish_silently" &&
        e.fields.reason === "nothing new since the last check",
    ).length,
    1,
  );
});

test("pauseStampAfterToolCall stamps terminate onto sibling results once silence is requested", async () => {
  const { halt } = createTurnToolState({ current: null, silentRequested: true });
  const stamped = await pauseStampAfterToolCall(halt)({});
  assert.equal(stamped?.terminate, true);
  halt.setSilent(false);
  assert.equal(await pauseStampAfterToolCall(halt)({}), undefined);
});
