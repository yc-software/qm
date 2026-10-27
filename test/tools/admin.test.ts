import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Check } from "typebox/value";
import { createAdminCall } from "../../src/tools/admin.ts";
import { createAgentTools } from "../../src/harness/agent-tools.ts";
import { createTurnToolState } from "../../src/harness/turn-tool-state.ts";
import type { ToolContext } from "../../src/tools/primitives.ts";

test("admin sends only fixed routes with encoded identifiers and preserves HTTP failures", async () => {
  const requests: { url: string; token: string; method: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      url: req.url!,
      token: String(req.headers["x-agent-capability"]),
      method: req.method!,
      body: Buffer.concat(chunks).toString(),
    });
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("synthetic route denial");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const call = createAdminCall(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "synthetic-capability");
    const tool = createAgentTools(
      createTurnToolState({ current: { admin: { call, operationsAvailable: true } } as unknown as ToolContext }),
      { controlTools: true },
    ).find((t) => t.name === "admin")!;
    const args = { action: "configure", scope: "channel:test/?evil=1", resource: "soul", value: { content: "hello" } };
    assert.equal(Check(tool.parameters, args), true);
    const result = await tool.execute("configure", args, undefined, undefined, {} as never);
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), {
      status: 403,
      body: "synthetic route denial",
    });
    assert.deepEqual(requests, [
      {
        url: "/v1/admin/scopes/channel%3Atest%2F%3Fevil%3D1/soul?",
        token: "synthetic-capability",
        method: "PUT",
        body: '{"content":"hello"}',
      },
    ]);
    for (const args of [
      { action: "request", url: "https://example.test" },
      { action: "config", scope: ".." },
      { action: "configure", scope: "org:test", resource: "..", value: {} },
      { action: "whoami", path: "/grants", method: "POST" },
      { action: "invite_external", value: { email: "user@example.test", expiresAt: 1, role: "org_admin" } },
      { action: "session", scope: "org:test", id: "test", limit: 201 },
      { action: "configure", scope: "org:test", resource: "service-credentials", value: {} },
      { action: "session_llm", scope: "org:test", id: "test", turnSeq: "1" },
    ])
      await assert.rejects(() => call(args));
    assert.equal(requests.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("admin never forwards a capability through redirects", async () => {
  let redirected = false;
  const server = createServer((req, res) => {
    if (req.url === "/escape") redirected = true;
    res.writeHead(302, { location: "/escape" });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const call = createAdminCall(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "synthetic-capability");
    await assert.rejects(() => call({ action: "whoami" }));
    assert.equal(redirected, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("ordinary turns only receive the inexpensive admin status action", () => {
  const tool = createAgentTools(createTurnToolState({ current: {} as unknown as ToolContext }), {
    controlTools: true,
  }).find((t) => t.name === "admin")!;
  assert.equal(Check(tool.parameters, { action: "whoami" }), true);
  assert.equal(Check(tool.parameters, { action: "memory", scope: "org:test" }), false);
});

test("cancelled admin calls never reach HTTP", async () => {
  const signal = AbortSignal.abort(new Error("synthetic stop"));
  const call = createAdminCall("http://127.0.0.1:1", "synthetic-capability");
  await assert.rejects(() => call({ action: "whoami" }, signal), /synthetic stop/);
  let received: AbortSignal | undefined;
  const native = createAgentTools(
    createTurnToolState({
      current: {
        admin: {
          operationsAvailable: true,
          call: async (_args: Record<string, unknown>, inputSignal?: AbortSignal) => {
            received = inputSignal;
            return { status: 200, body: {} };
          },
        },
      } as unknown as ToolContext,
      abortSignal: signal,
    }),
    { controlTools: true },
  ).find((t) => t.name === "admin")!;
  await native.execute("stopped", { action: "whoami" }, undefined, undefined, {} as never);
  assert.equal(received, signal);
});

test("admin error diagnostics retain request evidence and redact secrets", async () => {
  const tool = createAgentTools(
    createTurnToolState({
      current: {
        admin: {
          operationsAvailable: true,
          call: async () => ({
            status: 403,
            body: { error: "synthetic denial", apiKey: "synthetic-private-key" },
            requestId: "req-synthetic",
          }),
        },
      } as unknown as ToolContext,
    }),
    { controlTools: true },
  ).find((t) => t.name === "admin")!;
  const result = await tool.execute("error", { action: "whoami" }, undefined, undefined, {} as never);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /synthetic denial/);
  assert.match(text, /req-synthetic/);
  assert.doesNotMatch(text, /synthetic-private-key/);
});
