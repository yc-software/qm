import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTools } from "../../src/harness/agent-tools.ts";
import { createTurnToolState, type TurnToolStateInit } from "../../src/harness/turn-tool-state.ts";
import { type ToolContext } from "../../src/tools/primitives.ts";
import { fakeToolContext, type Emitted, emittedItem, call, callWith } from "../support/agent-tools.ts";

test("tool entries carry the call id + faithful model-facing result (WAL replay record)", async () => {
  const emitted: Emitted[] = [];
  const ref: TurnToolStateInit = {
    current: fakeToolContext(),
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "personal:U1",
  };
  const [execute, , read, , memory] = createAgentTools(createTurnToolState(ref));

  await callWith(execute, "call-exec", { command: "echo hi", purpose: "Run test command" });
  await callWith(read, "call-read", { action: "read", path: "a.txt" });
  await callWith(memory, "call-recall", { action: "search", query: "billing" });

  for (const id of ["call-exec", "call-read", "call-recall"]) {
    const pair = emitted.filter((e) => e.fields.callId === id);
    assert.deepEqual(
      pair.map((e) => e.kind),
      ["ToolCall", "ToolResult"],
      `${id} pairs call→result by id`,
    );
  }

  const result = (id: string) => emitted.find((e) => e.kind === "ToolResult" && e.fields.callId === id)!.fields;
  assert.equal(result("call-read").text, "data");
  assert.equal(result("call-read").isError, false);
  assert.match(result("call-recall").text, /Owns the billing service/);
  assert.match(result("call-exec").text, /ran echo hi/);
  assert.match(result("call-exec").text, /\[exit 0\]/);
});

test("not-found read and denied command record isError + the faithful error text", async () => {
  const emitted: Emitted[] = [];
  const denyTC: ToolContext = {
    ...fakeToolContext(),
    async execute() {
      const { CommandDenied } = await import("../../src/tools/primitives.ts");
      throw new CommandDenied("rm -rf /", "denied by policy");
    },
  };
  const ref: TurnToolStateInit = {
    current: denyTC,
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "org:default-org",
  };
  const [execute, , read] = createAgentTools(createTurnToolState(ref));
  await callWith(execute, "c1", { command: "rm -rf /", purpose: "Run test command" });
  await callWith(read, "c2", { action: "read", path: "missing.txt" });

  const denied = emitted.find((e) => e.kind === "ToolResult" && e.fields.tool === "execute")!.fields;
  assert.equal(denied.isError, true);
  assert.match(denied.text, /denied by policy/);

  const missing = emitted.find((e) => e.kind === "ToolResult" && e.fields.tool === "files")!.fields;
  assert.equal(missing.found, false);
  assert.equal(missing.isError, true);
  assert.match(missing.text, /no such file/);
});

test("a denied command still emits a tool_result (denied), and a missing read records found:false", async () => {
  const emitted: Emitted[] = [];
  const denyTC: ToolContext = {
    ...fakeToolContext(),
    async execute() {
      const { CommandDenied } = await import("../../src/tools/primitives.ts");
      throw new CommandDenied("rm -rf /", "denied by policy");
    },
  };
  const ref: TurnToolStateInit = {
    current: denyTC,
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "org:default-org",
  };
  const [execute, , read] = createAgentTools(createTurnToolState(ref));

  await call(execute, { command: "rm -rf /", purpose: "Run test command" });
  await call(read, { action: "read", path: "missing.txt" });

  const denied = emitted.find((e) => e.kind === "ToolResult" && e.fields.tool === "execute");
  assert.equal(denied?.fields.denied, true);
  const missing = emitted.find((e) => e.kind === "ToolResult" && e.fields.tool === "files");
  assert.equal(missing?.fields.found, false);
});

test("no emit sink → tools still run, nothing logged (unit path)", async () => {
  const [execute] = createAgentTools(createTurnToolState({ current: fakeToolContext() }));
  const r = await call(execute, { command: "echo ok", purpose: "Run test command" });
  assert.ok(r);
});

test("execute forwards the agent's timeout_seconds into tc.execute; omitting it sends no opts", async () => {
  const sink: { lastExecOpts?: { timeoutSeconds?: number } | undefined } = {};
  const [execute] = createAgentTools(createTurnToolState({ current: fakeToolContext(sink) }));

  await call(execute, { command: "npm ci", timeout_seconds: 240, purpose: "Run test command" });
  assert.deepEqual(sink.lastExecOpts, { timeoutSeconds: 240 });

  await call(execute, { command: "echo hi", purpose: "Run test command" });
  assert.equal(sink.lastExecOpts, undefined);
});

test("publish reply states owner + resolved audience in human terms (ADR 0003 D7)", async () => {
  const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  const withAudience = (audience: unknown): ToolContext => ({
    ...fakeToolContext(),
    async publish(input) {
      return {
        id: "dep-1",
        ...(input.name ? { name: input.name } : {}),
        version: 1,
        url: `/d/${input.name ?? "dep-1"}/`,
        audience,
      } as never;
    },
  });

  const org = textOf(
    await call(
      createAgentTools(createTurnToolState({ current: withAudience({ kind: "org", orgId: "acme" }) })).find(
        (tool) => tool.name === "apps",
      ),
      {
        action: "publish",
        entrypoint: "x",
        name: "site",
      },
    ),
  );
  assert.match(org, /Owned by you/);
  assert.match(org, /anyone at acme/);

  const members = textOf(
    await call(
      createAgentTools(
        createTurnToolState({ current: withAudience({ kind: "members", channelRef: "C1", memberCount: 3 }) }),
      ).find((tool) => tool.name === "apps"),
      {
        action: "publish",
        entrypoint: "x",
        name: "site",
      },
    ),
  );
  assert.match(members, /reachable by the 3 people currently in #C1/);

  const channel = textOf(
    await call(
      createAgentTools(createTurnToolState({ current: withAudience({ kind: "members", channelRef: "C1" }) })).find(
        (tool) => tool.name === "apps",
      ),
      { action: "publish", entrypoint: "x", name: "site" },
    ),
  );
  assert.match(channel, /access follows the visibility and membership of its shared scopes/);
  assert.doesNotMatch(channel, /0 people/);

  const owner = textOf(
    await call(
      createAgentTools(createTurnToolState({ current: withAudience({ kind: "owner" }) })).find(
        (tool) => tool.name === "apps",
      ),
      { action: "publish", entrypoint: "x", name: "site" },
    ),
  );
  assert.match(owner, /owner-only/);

  const noted = textOf(
    await call(
      createAgentTools(
        createTurnToolState({
          current: withAudience({
            kind: "owner",
            note: "couldn't enumerate the channel's members to auto-share — share manually",
          }),
        }),
      ).find((tool) => tool.name === "apps"),
      { action: "publish", entrypoint: "x", name: "site" },
    ),
  );
  assert.match(noted, /share manually/);
});

test("publish reply: the reply never carries a capability token, even from a stale stored endpoint", async () => {
  const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  const stale: ToolContext = {
    ...fakeToolContext(),
    async publish(input) {
      return {
        id: "dep-1",
        ...(input.name ? { name: input.name } : {}),
        version: 1,
        url: "https://site.apps.example.com/",
        audience: { kind: "owner" },
      } as never;
    },
  };
  const out = textOf(
    await call(
      createAgentTools(createTurnToolState({ current: stale })).find((tool) => tool.name === "apps"),
      { action: "publish", entrypoint: "x", name: "site" },
    ),
  );
  assert.match(out, /https:\/\/site\.apps\.example\.com\//, "the bare URL is in the reply");
  assert.doesNotMatch(out, /access=/, "no capability token in the reply");
  assert.doesNotMatch(out, /anyone with this link/, "reach is described by the audience, never a bearer claim");
  assert.match(out, /owner/i, "the true audience is stated");
});
test("background dispatches each action and emits tool_call/tool_result", async () => {
  const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  const emitted: Emitted[] = [];
  const ref: TurnToolStateInit = {
    current: fakeToolContext(),
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "personal:U1",
  };
  const background = createAgentTools(createTurnToolState(ref)).find((t) => t.name === "background");
  assert.ok(background);

  const started = textOf(
    await call(
      createAgentTools(createTurnToolState(ref)).find((t) => t.name === "execute"),
      { background: true, command: "npm run build", purpose: "Run background tests" },
    ),
  );
  assert.match(started, /started bg-1/);
  assert.match(started, /running/);

  const polled = textOf(await call(background, { action: "poll", process_id: "bg-1", since_cursor: 7 }));
  assert.match(polled, /more output/);
  assert.match(polled, /cursor 18/);
  assert.match(polled, /exited 0/);

  const wrote = textOf(await call(background, { action: "send_input", process_id: "bg-1", data: "ABCD-1234\n" }));
  assert.match(wrote, /wrote 10B to bg-1 stdin/);

  const stopped = textOf(await call(background, { action: "stop", process_id: "bg-1" }));
  assert.match(stopped, /signalled bg-1/);

  const listed = textOf(await call(background, { action: "list" }));
  assert.match(listed, /bg-1/);
  assert.match(listed, /bg: npm test/);

  const bg = emitted.filter((e) => e.fields.tool === "background");
  assert.equal(bg.length, 8);
  assert.equal(emitted.filter((e) => e.fields.tool === "execute").length, 2);
});

test("background watch reports an already exited job as a successful tail result", async () => {
  const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  const emitted: Emitted[] = [];
  const ref: TurnToolStateInit = {
    current: {
      ...fakeToolContext(),
      async backgroundWatch(processId) {
        return {
          processId,
          completed: true,
          registryStatus: "exited",
          exitCode: 0,
          outputTail: "final line\n",
          cursor: 42,
        };
      },
    },
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "personal:U1",
  };
  const background = createAgentTools(createTurnToolState(ref)).find((t) => t.name === "background");

  const watched = textOf(await call(background, { action: "watch", process_id: "bg-1" }));

  assert.match(watched, /job already exited \(code 0\) — no watch armed; here is the tail of its output:/);
  assert.match(watched, /final line/);
  const result = emitted.find((e) => e.kind === "ToolResult")!.fields;
  assert.equal(result.completed, true);
  assert.equal(result.error, undefined);
});

test("background per-action validation returns a crisp [error] instead of throwing", async () => {
  const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  const background = createAgentTools(createTurnToolState({ current: fakeToolContext() })).find(
    (t) => t.name === "background",
  );
  assert.ok(background);

  assert.match(textOf(await call(background, { action: "start" })), /invalid background arguments/);
  assert.match(textOf(await call(background, { action: "poll" })), /\[error\].*requires `process_id`/);
  assert.match(textOf(await call(background, { action: "stop" })), /\[error\].*requires `process_id`/);
  assert.match(
    textOf(await call(background, { action: "send_input", process_id: "bg-1" })),
    /\[error\].*requires `data`/,
  );
  assert.match(textOf(await call(background, { action: "send_input", data: "x" })), /\[error\].*requires `process_id`/);
});

test("background surfaces a policy denial/approval as a tool_result, not a throw", async () => {
  const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  const denyTC: ToolContext = {
    ...fakeToolContext(),
    async backgroundStart(command) {
      const { CommandDenied } = await import("../../src/tools/primitives.ts");
      throw new CommandDenied(command, "denied by policy");
    },
  };
  const out = textOf(
    await call(
      createAgentTools(createTurnToolState({ current: denyTC })).find((t) => t.name === "execute"),
      { background: true, command: "rm -rf /", purpose: "Run background tests" },
    ),
  );
  assert.match(out, /\[denied by policy\]/);

  const approvalTC: ToolContext = {
    ...fakeToolContext(),
    async backgroundStart(command) {
      const { NeedsApproval } = await import("../../src/tools/primitives.ts");
      throw new NeedsApproval(command, "needs a human");
    },
  };
  const state = createTurnToolState({ current: approvalTC });
  const pending = state.halt.approvals();
  const out2 = textOf(
    await call(
      createAgentTools(state).find((t) => t.name === "execute"),
      { background: true, command: "deploy prod", purpose: "Run background tests" },
    ),
  );
  assert.match(out2, /\[blocked: needs human approval\]/);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.command, "deploy prod");
});
