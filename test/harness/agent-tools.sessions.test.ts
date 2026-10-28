import { test } from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { fromJSONSchema, z, type ZodObject } from "zod";
import { createAgentTools, type ToolContextRef } from "../../src/harness/agent-tools.ts";
import type { ToolContext } from "../../src/tools/primitives.ts";
import type { ClientToolDeclaration } from "../../src/types.ts";
import { itemFields, type Item } from "../../src/sessions/items.ts";
import {
  fakeToolContext,
  type Emitted,
  emittedItem,
  call,
  surfaceTool,
  textOut,
  clientTool,
  clientToolRef,
} from "../support/agent-tools.ts";

test("surface messages use Markdown and only Slack tools teach Slack mentions", () => {
  const ref: ToolContextRef = { current: fakeToolContext(), scopeLabel: "channel:C1" };
  for (const name of ["web", "slack", "telegram"]) {
    const tool = surfaceTool(ref, name);
    const text = (tool.parameters as { properties: { text: { description: string } } }).properties.text.description;
    assert.match(text, /Use Markdown, including \[label\]\(url\) links/);
    if (name === "slack") assert.match(text, /<@U…>/);
    else assert.doesNotMatch(text, /Slack|<@U…>|<!subteam/);
  }
});

test("read passes turn cancellation through and cannot record a late success", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<{ content: string; sourceScopeId: string }>();
  const emitted: Emitted[] = [];
  const context = fakeToolContext();
  let received: AbortSignal | undefined;
  context.read = async (_path, signal) => {
    received = signal;
    started.resolve();
    return pending.promise;
  };
  const read = createAgentTools({
    current: context,
    abortSignal: controller.signal,
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
  }).find((t) => t.name === "files");
  const result = call(read, { action: "read", path: "notes.md" });
  await started.promise;
  controller.abort();
  pending.resolve({ content: "late data", sourceScopeId: "personal:U1" });
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(received, controller.signal);
  assert.equal(emitted.filter((e) => e.kind === "ToolResult").length, 0);
});

test("session tools are omitted when the actor feature is disabled", () => {
  assert.equal(
    createAgentTools({ current: fakeToolContext() }, { sessionTools: false }).some((tool) =>
      ["sessions", "subagents"].includes(tool.name),
    ),
    false,
  );
});

test("agent mail is screened separately, logged privately, and delivered once across parallel tools", async () => {
  const tc = fakeToolContext();
  const message = {
    id: "mail",
    senderId: "child",
    recipientId: "parent",
    actor: { id: "U1", type: "internal" as const },
    audience: [],
    text: "child finding",
    createdAt: 1,
  };
  let pending = true;
  const emitted: Emitted[] = [];
  const screens: Array<{ provenance: string; result: string; unscreenable: boolean }> = [];
  tc.sessionSyscalls = {
    open: async () => ({ ok: false, message: "unused" }),
    write: async () => ({ ok: false, message: "unused" }),
    read: async () => ({ ok: false, message: "unused" }),
    receive: async () => (pending ? [message] : []),
    acknowledge: async () => {
      pending = false;
    },
  };
  tc.read = async () => ({ content: "workspace data", sourceScopeId: "org:default-org" });
  const ref: ToolContextRef = {
    current: tc,
    scopeLabel: "personal:U1",
    orgScopeId: "org:default-org",
    emit: (entry) => {
      emitted.push(emittedItem(entry));
    },
    observeToolResult: (input) => {
      screens.push(input);
    },
  };
  const read = createAgentTools(ref).find((tool) => tool.name === "files");
  const results = await Promise.all([
    call(read, { action: "read", path: "a.txt" }),
    call(read, { action: "read", path: "b.txt" }),
  ]);
  assert.equal(results.filter((result) => JSON.stringify(result).includes("child finding")).length, 1);
  assert.ok(
    screens.some((input) => input.result === "child finding" && input.provenance === "external" && !input.unscreenable),
  );
  assert.ok(
    emitted.some((entry) => entry.kind === "ToolResult" && String(entry.fields.text).includes("child finding")),
  );
});

test("conversation coordinators cannot execute commands through any command tool", async () => {
  {
    for (const options of [{ surfaceTools: true, delegateWork: true }, { delegateWork: true }]) {
      const ref: ToolContextRef = { current: fakeToolContext() };
      const tools = createAgentTools(ref, options);
      for (const name of ["execute", "background"]) assert.ok(!tools.some((tool) => tool.name === name));
      const sandbox = tools.find((tool) => tool.name === "sandbox")!;
      assert.match(
        textOut(await call(sandbox, { action: "exec", command: "echo forbidden" })),
        /invalid sandbox arguments/,
      );
      assert.match(
        textOut(
          await call(sandbox, { action: "start_process", command: "echo forbidden", purpose: "Run background tests" }),
        ),
        /invalid sandbox arguments/,
      );
      assert.ok(tools.some((tool) => tool.name === "subagents"));
    }
  }
  assert.ok(
    createAgentTools({ current: fakeToolContext() }, { delegateWork: false }).some((tool) => tool.name === "execute"),
  );
});

test("subagents open exposes noComputer and preserves the internal restriction", async () => {
  const opened: Array<{ readOnly?: boolean }> = [];
  const tc = fakeToolContext();
  tc.sessionSyscalls = {
    open: async (input) => {
      opened.push(input);
      return { ok: true, sessionId: "child", title: "child", liveRunsRemaining: 9 };
    },
    write: async () => ({ ok: false, message: "unused" }),
    read: async () => ({ ok: false, message: "unused" }),
  };
  const session = createAgentTools({ current: tc }).find((tool) => tool.name === "subagents")!;
  const properties = (session.parameters as { properties: Record<string, { description?: string }> }).properties;
  assert.ok(properties.noComputer);
  assert.equal(properties.readOnly, undefined);
  const shape = (fromJSONSchema(session.parameters as Parameters<typeof fromJSONSchema>[0]) as ZodObject).shape;
  assert.ok(!Check(session.parameters, { action: "open", task: "test", noComputer: "true" }));
  for (const noComputer of [undefined, false, true]) {
    const params = { action: "open", task: "test", ...(noComputer === undefined ? {} : { noComputer }) };
    assert.ok(Check(session.parameters, params));
    await call(session, z.object(shape).parse(params));
    assert.equal(opened.at(-1)!.readOnly, noComputer);
  }
  assert.equal(opened.length, 3);
});

test("subagents open schema and dispatch preserve an explicit false fast mode", async () => {
  const tc = fakeToolContext();
  tc.sessionSyscalls = {
    open: async (input) => {
      assert.equal(input.fastMode, false);
      return { ok: true, sessionId: "child", title: "child", liveRunsRemaining: 9 };
    },
    write: async () => ({ ok: false, message: "unused" }),
    read: async () => ({ ok: false, message: "unused" }),
  };
  const session = createAgentTools({ current: tc }).find((tool) => tool.name === "subagents")!;
  assert.ok(Check(session.parameters, { action: "open", task: "test", fastMode: false }));
  assert.ok(!Check(session.parameters, { action: "open", task: "test", fastMode: "false" }));
  assert.match(textOut(await call(session, { action: "open", task: "test", fastMode: false })), /child/);
});

test("subagents followup_task takes its instruction in task, like open", async () => {
  const writes: Array<{ followup?: boolean; text?: string; interrupt?: boolean }> = [];
  const tc = fakeToolContext();
  tc.sessionSyscalls = {
    open: async () => ({ ok: false, message: "unused" }),
    write: async (input) => {
      writes.push(input);
      return input.text || input.interrupt
        ? { ok: true, sessionId: "child", title: "child", delivered: input.followup ? "queued_turn" : "queued_message" }
        : {
            ok: false,
            message: input.followup ? "followup_task requires `task`." : "send_message requires `text`.",
          };
    },
    read: async () => ({ ok: false, message: "unused" }),
  };
  const session = createAgentTools({ current: tc }).find((tool) => tool.name === "subagents")!;
  assert.ok(!Check(session.parameters, { action: "write", target: "child", text: "hi" }));
  assert.match(
    textOut(await call(session, { action: "followup_task", target: "child", task: "next task" })),
    /queued as a new turn/,
  );
  assert.match(
    textOut(await call(session, { action: "send_message", target: "child", text: "fyi" })),
    /delivered; a busy recipient/,
  );
  assert.match(
    textOut(await call(session, { action: "followup_task", target: "child", task: "stop?", interrupt: true })),
    /interrupt applies to send_message/,
  );
  await call(session, { action: "followup_task", target: "child", text: "misplaced" });
  assert.deepEqual(
    writes.map(({ followup, text, interrupt }) => ({ followup, text, interrupt })),
    [
      { followup: true, text: "next task", interrupt: undefined },
      { followup: false, text: "fyi", interrupt: undefined },
      { followup: true, text: undefined, interrupt: undefined },
    ],
  );
});

test("conversation coordinator mailbox checks never block on children", async () => {
  const waits: number[] = [];
  const tc = fakeToolContext();
  tc.sessionSyscalls = {
    receive: async (timeout = 0) => {
      waits.push(timeout);
      return [];
    },
    open: async () => ({ ok: false, message: "unused" }),
    write: async () => ({ ok: false, message: "unused" }),
    read: async () => ({ ok: false, message: "unused" }),
  };
  const session = createAgentTools({ current: tc }, { delegateWork: true }).find((tool) => tool.name === "subagents")!;
  await call(session, { action: "wait", timeoutMs: 60000 });
  assert.ok(waits.length > 0);
  assert.ok(waits.every((timeout) => timeout === 0));
});

test("resource catalog exposes one home per operation and leaves MCP tools intact", async () => {
  const tools = createAgentTools(
    { current: fakeToolContext() },
    {
      controlTools: true,
      mcpTools: [
        {
          name: "example_search",
          serverId: "example",
          remoteName: "search",
          description: "Search",
          inputSchema: { type: "object", properties: {} },
          readOnly: true,
          needsApproval: false,
        },
      ],
    },
  );
  const names = tools.map((tool) => tool.name);
  for (const name of ["files", "apps", "skills", "subagents", "goal", "cron", "example_search"])
    assert.ok(names.includes(name));
  for (const name of [
    "read",
    "write",
    "publish",
    "share",
    "skill",
    "session",
    "create_goal",
    "get_goal",
    "update_goal",
  ])
    assert.ok(!names.includes(name));
  for (const [name, valid, invalid] of [
    ["files", { action: "write", path: "a", data: "" }, { action: "write", path: "a" }],
    ["files", { action: "read", path: "a" }, { action: "read", path: "a", data: "oops" }],
    [
      "files",
      { action: "share", id: "file-id", toScope: "org" },
      { action: "write", path: "a", data: "x", share: [{ scope: "org" }] },
    ],
    [
      "apps",
      { action: "publish", name: "demo", public: true },
      { action: "publish", name: "demo", share: [{ scope: "org", permission: "read" }] },
    ],
    [
      "apps",
      { action: "move", id: "app", toScope: "personal:bob" },
      { action: "move", id: "app", toScope: "personal:bob", permission: "write" },
    ],
    ["goal", { action: "create", objective: "finish" }, { action: "get", objective: "finish" }],
    ["skills", { action: "read", name: "design" }, { action: "read", name: "design", toScope: "org" }],
  ] as const) {
    const tool = tools.find((tool) => tool.name === name)!;
    assert.ok(Check(tool.parameters, valid), JSON.stringify(valid));
    assert.match(textOut(await call(tool, invalid)), /Invalid arguments/, JSON.stringify(invalid));
  }
  assert.ok(JSON.stringify(tools.find((tool) => tool.name === "cron")!.parameters).length < 20000);
});

test("resource actions preserve sharing targets, transfer semantics and file contents", async () => {
  const writes: unknown[] = [];
  const shares: unknown[] = [];
  const publicChanges: unknown[] = [];
  const tc = {
    ...fakeToolContext(),
    async write(...args: Parameters<ToolContext["write"]>) {
      writes.push(args);
    },
    async setDeploymentPublic(id: string, isPublic: boolean) {
      publicChanges.push({ id, isPublic });
      return { id, name: id, public: isPublic };
    },
    async shareArtifact(req: Parameters<ToolContext["shareArtifact"]>[0]) {
      shares.push(req);
      return { ok: false as const, code: "forbidden" as const, message: "not the owner" };
    },
  };
  const tools = createAgentTools({ current: tc }, { controlTools: true });
  const files = tools.find((tool) => tool.name === "files")!;
  await call(files, { action: "write", path: "notes", data: "" });
  const pathShare = { action: "share", path: "notes", scope: "org", sandbox_id: "sb1" };
  assert.ok(Check(files.parameters, pathShare));
  const rejected = await call(files, pathShare);
  assert.match(textOut(rejected), /upload a sandbox path with POST \/v1\/files\/uploads first/);
  assert.deepEqual(writes, [["notes", "", undefined]]);
  const invalidAppShare = { action: "share", id: "app", toScope: "org", unknown: true };
  const apps = tools.find((tool) => tool.name === "apps")!;
  assert.ok(Check(apps.parameters, invalidAppShare));
  assert.match(textOut(await call(apps, invalidAppShare)), /Invalid arguments/);
  assert.deepEqual(shares, []);
  for (const [name, type, action] of [
    ["files", "file", "share"],
    ["apps", "deploy", "share"],
    ["apps", "deploy", "move"],
    ["skills", "skill", "share"],
    ["skills", "skill", "move"],
    ["cron", "cron", "share"],
  ]) {
    const result = await call(
      tools.find((tool) => tool.name === name),
      { action, id: "artifact", toScope: "Bob" },
    );
    assert.match(textOut(result), /not the owner/);
    assert.deepEqual(shares.at(-1), {
      type,
      id: "artifact",
      recipient: "Bob",
      ...(action === "move" ? { move: true } : {}),
    });
  }
  const publicResult = await call(
    tools.find((tool) => tool.name === "apps"),
    {
      action: "share",
      id: "artifact",
      public: true,
    },
  );
  assert.match(textOut(publicResult), /anyone with the link/);
  assert.deepEqual(publicChanges, [{ id: "artifact", isPublic: true }]);
  await call(
    tools.find((tool) => tool.name === "apps"),
    {
      action: "share",
      id: "artifact",
      email: "guest@example.com",
    },
  );
  assert.deepEqual(shares.at(-1), { type: "deploy", id: "artifact", email: "guest@example.com" });

  const before = writes.length;
  await call(files, { action: "read", path: "notes", data: "unexpected" });
  await call(files, { action: "write", path: "notes" });
  assert.equal(writes.length, before);
});

test("apps publish schema no longer advertises audience and rejects it as an unknown argument", async () => {
  const inputs: unknown[] = [];
  const tc = {
    ...fakeToolContext(),
    async publish(input: Parameters<ToolContext["publish"]>[0]) {
      inputs.push(input);
      return { id: "app", version: 1, url: "https://app.example" };
    },
  };
  const apps = createAgentTools({ current: tc }).find((tool) => tool.name === "apps")!;
  assert.equal("audience" in (apps.parameters as { properties: Record<string, unknown> }).properties, false);
  assert.match(textOut(await call(apps, { action: "publish", name: "private", audience: [] })), /Invalid arguments/);
  assert.equal(inputs.length, 0);
  await call(apps, { action: "publish", name: "private" });
  assert.equal((inputs[0] as { share?: unknown }).share, undefined);
});

test("files share preserves artifact IDs, recipient resolution and authorization failures", async () => {
  const requests: unknown[] = [];
  const tc = {
    ...fakeToolContext(),
    async shareArtifact(req: Parameters<ToolContext["shareArtifact"]>[0]) {
      requests.push(req);
      return { ok: false as const, code: "forbidden" as const, message: "not the owner" };
    },
  };
  const files = createAgentTools({ current: tc }, { controlTools: true }).find((tool) => tool.name === "files")!;
  assert.match(
    textOut(await call(files, { action: "share", id: "file-artifact", toScope: "Bob", permission: "write" })),
    /not the owner/,
  );
  assert.deepEqual(requests, [{ type: "file", id: "file-artifact", recipient: "Bob", permission: "write" }]);
  for (const params of [
    { action: "share", path: "notes", scope: "org", id: "file-artifact", toScope: "Bob" },
    { action: "share", id: "file-artifact" },
  ])
    assert.match(textOut(await call(files, params)), /Invalid arguments/);
  assert.equal(requests.length, 1);
});

test("the retired credential tool is absent and execute accepts credential handles", () => {
  const tools = createAgentTools({ current: fakeToolContext() });
  assert.equal(
    tools.some((tool) => tool.name === "credential_exec"),
    false,
  );
  assert.ok(tools.some((tool) => tool.name === "execute"));
});

test("command and management call traces preserve purpose", async () => {
  const calls: Record<string, unknown>[] = [];
  const ref: ToolContextRef = {
    current: fakeToolContext(),
    scopeLabel: "personal:U1",
    emit: (event) => {
      if (event.kind === "ToolCall") calls.push(itemFields(event as Item));
    },
  };
  const tools = createAgentTools(ref);
  for (const [name, params] of [
    ["execute", { command: "pwd" }],
    ["sandbox", { action: "status" }],
    ["execute", { command: "echo ready", background: true }],
    ["execute", { command: "pwd", scope: "scratch" }],
    ["sandbox", { action: "exec" }],
  ] as const)
    await call(
      tools.find((t) => t.name === name),
      { ...params, purpose: "Inspect demo workspace" },
    );
  assert.equal(calls.length, 5);
  assert.ok(calls.every((entry) => entry.purpose === "Inspect demo workspace"));
});

test("declared client tools follow qm's own tools, in name order whatever the declaration order", () => {
  const core = createAgentTools({ current: fakeToolContext() }).map((t) => t.name);
  const names = (declared: ClientToolDeclaration[]) =>
    createAgentTools({ current: fakeToolContext() }, { clientTools: declared }).map((t) => t.name);
  const forward = names([clientTool("ui__get_selection"), clientTool("ui__highlight_rows")]);
  const reversed = names([clientTool("ui__highlight_rows"), clientTool("ui__get_selection")]);
  assert.deepEqual(forward, [...core, "ui__get_selection", "ui__highlight_rows"]);
  assert.deepEqual(reversed, forward, "the tools array is stable from one turn to the next");
});

test("a client tool records the call, waits for the page, and returns its answer as screened external data", async () => {
  const { store, emitted, ref } = clientToolRef();
  const screened: Array<{ tool: string; provenance: string; source?: string }> = [];
  ref.observeToolResult = ({ tool, provenance, source }) => {
    screened.push({ tool, provenance, ...(source ? { source } : {}) });
  };
  const tool = createAgentTools(ref, { clientTools: [clientTool("ui__get_selection")] }).find(
    (t) => t.name === "ui__get_selection",
  );
  const pending = call(tool, { note: "hi" }) as Promise<{ content: Array<{ text: string }>; details: unknown }>;
  await new Promise((r) => setTimeout(r, 10));
  await store.send("run-1", {
    kind: "client_result",
    callId: "t",
    result: { content: "rows 3-5 selected", structured: { rows: [3, 4, 5] } },
  });
  const ret = await pending;
  assert.equal(ret.content[0]?.text, "rows 3-5 selected");
  assert.deepEqual(ret.details, { structured: { rows: [3, 4, 5] } });
  const toolCall = emitted.find((e) => e.kind === "ToolCall")!.fields;
  assert.deepEqual(toolCall, { tool: "ui__get_selection", client: true, args: { note: "hi" }, callId: "t" });
  const toolResult = emitted.find((e) => e.kind === "ToolResult")!.fields;
  assert.equal(toolResult.isError, false);
  assert.equal(toolResult.text, "rows 3-5 selected");
  assert.deepEqual(screened, [{ tool: "ui__get_selection", provenance: "external", source: "client page" }]);
});

test("a client tool passes the page's isError through to the model", async () => {
  const { store, emitted, ref } = clientToolRef();
  await store.send("run-1", {
    kind: "client_result",
    callId: "t",
    result: { content: "no rows match", isError: true },
  });
  const [tool] = createAgentTools(ref, { clientTools: [clientTool("ui__highlight_rows")] }).slice(-1);
  const ret = (await call(tool, {})) as { content: Array<{ text: string }> };
  assert.equal(ret.content[0]?.text, "no rows match");
  assert.equal(emitted.find((e) => e.kind === "ToolResult")!.fields.isError, true);
});

test("a client tool times out with an error the model can act on", async () => {
  const { emitted, ref } = clientToolRef();
  const [tool] = createAgentTools(ref, { clientTools: [clientTool("ui__get_selection", 30)] }).slice(-1);
  const ret = (await call(tool, {})) as { content: Array<{ text: string }> };
  assert.equal(ret.content[0]?.text, "The page didn't respond in time. It may have been closed or navigated away.");
  const toolResult = emitted.find((e) => e.kind === "ToolResult")!.fields;
  assert.equal(toolResult.isError, true);
  assert.equal(toolResult.timedOut, true);
});

test("a client tool stops waiting when the turn is cancelled", async () => {
  const { emitted, cancel, ref } = clientToolRef();
  const [tool] = createAgentTools(ref, { clientTools: [clientTool("ui__get_selection", 60_000)] }).slice(-1);
  const pending = call(tool, {}) as Promise<{ content: Array<{ text: string }> }>;
  cancel.abort();
  const ret = await pending;
  assert.match(ret.content[0]?.text ?? "", /cancelled/);
  assert.equal(emitted.find((e) => e.kind === "ToolResult")!.fields.cancelled, true);
});
