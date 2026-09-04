import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGrokMcpBridge } from "../src/harness/grok-mcp.ts";

function echoTool(execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    name: "echo",
    label: "Echo",
    description: "Echo a value",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    execute,
  } as ToolDefinition;
}

function permission(rawInput: unknown): RequestPermissionRequest {
  return {
    sessionId: "session",
    toolCall: { toolCallId: "call", rawInput },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  };
}

async function connect(url: string, bearerToken: string) {
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  await client.connect(transport);
  return client;
}

test("Grok MCP exposes only registered tools and consumes a matching one-shot permission", async (t) => {
  const controller = new AbortController();
  const calls: unknown[] = [];
  const bridge = await createGrokMcpBridge(
    [
      echoTool(async (_id, params) => {
        calls.push(params);
        return { content: [{ type: "text", text: String((params as { value: string }).value) }], details: {} };
      }),
    ],
    { signal: controller.signal },
  );
  t.after(async () => bridge.close());
  const client = await connect(bridge.url, bridge.bearerToken);
  t.after(async () => client.close());

  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["echo"],
  );
  assert.deepEqual([...bridge.acpToolNames], ["use_tool", "qm__echo"]);
  assert.deepEqual(bridge.requestPermission(permission({ tool_name: "qm__echo", tool_input: { value: "ok" } })), {
    outcome: { outcome: "selected", optionId: "reject" },
  });
  assert.equal(bridge.confirmAcpToolSurface(["use_tool", "qm__other"]), false);
  assert.equal(bridge.confirmAcpToolSurface(["list_dir", "use_tool"]), false);
  assert.equal(bridge.confirmAcpToolSurface(["use_tool", "use_tool"]), false);
  assert.equal(bridge.confirmAcpToolSurface(["use_tool"]), true);
  assert.equal(bridge.confirmAcpToolSurface(["use_tool", "qm__echo"]), true);
  assert.deepEqual(bridge.requestPermission(permission({ tool_name: "qm__echo", tool_input: { value: "ok" } })), {
    outcome: { outcome: "selected", optionId: "allow" },
  });
  const result = await client.callTool({ name: "echo", arguments: { value: "ok" } });
  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
  assert.deepEqual(calls, [{ value: "ok" }]);
  await assert.rejects(client.callTool({ name: "echo", arguments: { value: "ok" } }), /matching permission/);
});

test("Grok MCP defaults to denial for unknown or malformed structured tool identity", async (t) => {
  const controller = new AbortController();
  const bridge = await createGrokMcpBridge(
    [echoTool(async () => ({ content: [{ type: "text", text: "unexpected" }], details: {} }))],
    { signal: controller.signal, maxBodyBytes: 128 },
  );
  t.after(async () => bridge.close());
  assert.equal(bridge.confirmAcpToolSurface(["use_tool", "qm__echo"]), true);

  for (const rawInput of [
    undefined,
    { tool_name: "echo", tool_input: { value: "x" } },
    { tool_name: "qm__missing", tool_input: { value: "x" } },
    { tool_name: "qm__echo", tool_input: { value: 1 } },
  ])
    assert.deepEqual(bridge.requestPermission(permission(rawInput)), {
      outcome: { outcome: "selected", optionId: "reject" },
    });

  const response = await fetch(bridge.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 401);
  const oversized = await fetch(bridge.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bridge.bearerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ payload: "x".repeat(256) }),
  });
  assert.equal(oversized.status, 413);
  await bridge.close();
  await assert.rejects(fetch(bridge.url, { method: "POST" }));
});

test("Grok MCP maps execution errors and terminates only after returning the tool result", async (t) => {
  const controller = new AbortController();
  let terminated = 0;
  const finish = echoTool(async () => ({
    content: [{ type: "text", text: "finished" }],
    details: {},
    terminate: true,
  }));
  finish.name = "finish";
  const failure = echoTool(async () => {
    throw new Error("tool failed");
  });
  failure.name = "failure";
  const bridge = await createGrokMcpBridge([finish, failure], {
    signal: controller.signal,
    onTerminate: () => {
      terminated += 1;
    },
  });
  t.after(async () => bridge.close());
  const client = await connect(bridge.url, bridge.bearerToken);
  t.after(async () => client.close());
  assert.equal(bridge.confirmAcpToolSurface(["use_tool", "qm__finish", "qm__failure"]), true);
  bridge.requestPermission(permission({ tool_name: "qm__failure", tool_input: { value: "x" } }));
  const failed = await client.callTool({ name: "failure", arguments: { value: "x" } });
  assert.equal(failed.isError, true);
  assert.deepEqual(failed.content, [{ type: "text", text: "tool failed" }]);
  bridge.requestPermission(permission({ tool_name: "qm__finish", tool_input: { value: "x" } }));
  const finished = await client.callTool({ name: "finish", arguments: { value: "x" } });
  assert.deepEqual(finished.content, [{ type: "text", text: "finished" }]);
  assert.equal(terminated, 1);
});

test("Grok MCP does not inherit termination across parallel HTTP requests", async (t) => {
  const controller = new AbortController();
  let terminated = 0;
  let waitingResolve!: () => void;
  const waiting = new Promise<void>((resolve) => {
    waitingResolve = resolve;
  });
  let releaseResolve!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const finish = echoTool(async () => ({
    content: [{ type: "text", text: "finished" }],
    details: {},
    terminate: true,
  }));
  finish.name = "finish";
  const unrelated = echoTool(async () => {
    waitingResolve();
    await release;
    return { content: [{ type: "text", text: "unrelated" }], details: {} };
  });
  unrelated.name = "unrelated";
  const bridge = await createGrokMcpBridge([finish, unrelated], {
    signal: controller.signal,
    onTerminate: () => {
      terminated += 1;
    },
  });
  t.after(async () => bridge.close());
  const client = await connect(bridge.url, bridge.bearerToken);
  t.after(async () => client.close());
  assert.equal(bridge.confirmAcpToolSurface(["use_tool", "qm__finish", "qm__unrelated"]), true);
  bridge.requestPermission(permission({ tool_name: "qm__unrelated", tool_input: { value: "x" } }));
  const unrelatedResult = client.callTool({ name: "unrelated", arguments: { value: "x" } });
  await waiting;
  bridge.requestPermission(permission({ tool_name: "qm__finish", tool_input: { value: "x" } }));
  assert.deepEqual((await client.callTool({ name: "finish", arguments: { value: "x" } })).content, [
    { type: "text", text: "finished" },
  ]);
  assert.equal(terminated, 1);

  releaseResolve();
  assert.deepEqual((await unrelatedResult).content, [{ type: "text", text: "unrelated" }]);
  assert.equal(terminated, 1);
});

test("Grok MCP request cancellation independently reaches an in-flight QM tool", async (t) => {
  const turnController = new AbortController();
  const requestController = new AbortController();
  let toolSignal: AbortSignal | undefined;
  let startedResolve: (() => void) | undefined;
  let abortedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    abortedResolve = resolve;
  });
  const bridge = await createGrokMcpBridge(
    [
      echoTool(async (_id, _params, signal) => {
        toolSignal = signal;
        startedResolve?.();
        await new Promise<void>((resolve) =>
          signal?.addEventListener(
            "abort",
            () => {
              abortedResolve?.();
              resolve();
            },
            { once: true },
          ),
        );
        throw new Error("cancelled");
      }),
    ],
    { signal: turnController.signal },
  );
  t.after(async () => bridge.close());
  const client = await connect(bridge.url, bridge.bearerToken);
  t.after(async () => client.close());
  assert.equal(bridge.confirmAcpToolSurface(["use_tool", "qm__echo"]), true);
  bridge.requestPermission(permission({ tool_name: "qm__echo", tool_input: { value: "wait" } }));
  const pending = client.callTool({ name: "echo", arguments: { value: "wait" } }, undefined, {
    signal: requestController.signal,
  });
  await started;

  requestController.abort();
  await assert.rejects(pending);
  await aborted;
  assert.equal(toolSignal?.aborted, true);
  assert.equal(turnController.signal.aborted, false);
});
