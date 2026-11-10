import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { SEAT_MODEL_ID } from "../src/model/seat-model.ts";
import { scopeId } from "../src/types.ts";

function sideCalls(t: TestContext): void {
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
    const events = [
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], usage: {} } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "side call" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  });
}

function serve(built: ReturnType<typeof buildApp>) {
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    seat: built.seat,
    sessions: built.sessions,
    featureFlags: built.featureFlags,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function nextStep(call: ReturnType<typeof serve>["call"], seen: Set<string>) {
  for (let i = 0; i < 400; i++) {
    const { body } = await call("GET", "/v1/seat/steps?principalId=alice");
    const step = (body.steps as Array<{ id: string }>).find((s) => !seen.has(s.id));
    if (step) {
      seen.add(step.id);
      return (await call("GET", `/v1/seat/steps/${step.id}?principalId=alice`)).body.step as {
        id: string;
        request: { system: unknown; tools: Array<{ name: string }>; messages: unknown[] };
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no seat step arrived");
}

const webTurn = (built: ReturnType<typeof buildApp>, threadRef: string, kind: "dm" | "channel" = "dm") =>
  built.app.turn({
    surface: "web",
    actor: { externalId: "alice" },
    conversation: kind === "dm" ? { kind, threadRef } : { kind, threadRef, channelRef: "C-seat" },
    text: "What did we talk about?",
    model: SEAT_MODEL_ID,
    async: true,
  });

test("the seat is hidden until the feature is on, then only offered in the person's own scope", async () => {
  const built = buildApp(testConfig({ anthropicApiKey: "sk-ant-api03-company" }), { agent: undefined });
  const srv = serve(built);
  try {
    const picker = async () =>
      (await srv.call("GET", "/v1/runtime-config?principalId=alice&scopeId=personal:alice")).body as {
        models: string[];
        modelCatalog: Record<string, { name: string }>;
      };
    assert.ok(!(await picker()).models.includes(SEAT_MODEL_ID));
    assert.equal((await srv.call("GET", "/v1/seat/steps?principalId=alice")).status, 403);
    const refused = await webTurn(built, "web:alice:seat-off");
    assert.equal(refused.status, "refused");
    assert.match(refused.reason ?? "", /isn't available on this deployment/);

    await built.featureFlags.setEnabled("agent_seat", scopeId("personal", "alice"), true, "admin");
    const offered = await picker();
    assert.ok(offered.models.includes(SEAT_MODEL_ID));
    assert.equal(offered.modelCatalog[SEAT_MODEL_ID]?.name, "You (Agent Seat)");
    assert.deepEqual((await srv.call("GET", "/v1/seat/steps?principalId=alice")).body, { steps: [] });
    await built.app.upsertChannels(
      [{ channelId: "C-seat", name: "seat-room", isPrivate: true }],
      [{ channelId: "C-seat", principalId: "alice" }],
    );
    const shared = await webTurn(built, "web:alice:seat-channel", "channel");
    assert.equal(shared.status, "refused");
    assert.match(shared.reason ?? "", /only plays in your own personal conversations/);
    assert.equal(
      (
        await srv.call("PUT", "/v1/runtime-config", {
          principalId: "alice",
          scopeId: "personal:alice",
          modelId: SEAT_MODEL_ID,
        })
      ).status,
      400,
    );
  } finally {
    await srv.close();
  }
});

test("a web turn on the seat runs through the real harness: the human calls a tool, reads its result, and replies", async (t) => {
  sideCalls(t);
  const built = buildApp(testConfig({ anthropicApiKey: "sk-ant-api03-company" }), { agent: undefined });
  await built.featureFlags.setEnabled("agent_seat", scopeId("personal", "alice"), true, "admin");
  await built.userModelCredentials.setOAuth("alice", "anthropic", {
    accessToken: "sk-ant-oat01-alice",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setPersonalModelAuth("alice", true, "anthropic");
  const srv = serve(built);
  const submitted = await webTurn(built, "web:alice:seat-e2e");
  assert.equal(submitted.status, "queued", submitted.reason);
  built.runtime.start();
  try {
    const seen = new Set<string>();
    const first = await nextStep(srv.call, seen);
    assert.match(JSON.stringify(first.request.messages), /What did we talk about\?/);
    const history = first.request.tools.find((tool) => tool.name === "history");
    assert.ok(history, first.request.tools.map((tool) => tool.name).join(", "));
    assert.equal(
      (
        await srv.call("POST", `/v1/seat/steps/${first.id}/move`, {
          principalId: "alice",
          content: [{ type: "tool_use", name: "history", input: { query: "anything" } }],
        })
      ).status,
      200,
    );

    const second = await nextStep(srv.call, seen);
    assert.match(JSON.stringify(second.request.messages.at(-1)), /tool_result/);
    await srv.call("POST", `/v1/seat/steps/${second.id}/move`, {
      principalId: "alice",
      content: [{ type: "text", text: "pong from the seat" }],
    });

    const finished = await built.runs.waitFor(submitted.runId!, 20_000);
    assert.equal(finished.status, "done", JSON.stringify(finished.result));
    const session = await built.sessions.getByThread(finished.sessionId);
    const items = session ? await built.sessions.getItems(session.id) : [];
    assert.ok(items.some((item) => item.kind === "ToolResult" && item.tool === "history"));
    assert.ok(
      items.some((item) => item.kind === "AgentMessage" && /pong from the seat/.test(item.text ?? "")),
      JSON.stringify(items.map((item) => item.kind)),
    );
  } finally {
    await built.runtime.stop();
    await srv.close();
  }
});
