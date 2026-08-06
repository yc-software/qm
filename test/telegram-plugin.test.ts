import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreClient } from "../src/api/core-client.ts";
import type { TurnResult } from "../src/types.ts";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

class FakeTelegramServer {
  readonly sent: Array<{ method: string; body: any }> = [];
  readonly pendingUpdates: any[] = [];
  getUpdatesCalls = 0;
  stopCalled = false;

  async handle(url: string, init: any): Promise<Response> {
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = init?.body ? JSON.parse(init.body) : {};
    this.sent.push({ method, body });
    if (method === "getUpdates") {
      this.getUpdatesCalls++;
      const batch = this.pendingUpdates.splice(0);
      return jsonResponse({ ok: true, result: batch });
    }
    if (method === "sendMessage" || method === "sendDocument") {
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`unexpected method ${method}`);
  }

  emitMessage(overrides: Record<string, unknown>): void {
    this.pendingUpdates.push({
      update_id: this.pendingUpdates.length + 1,
      message: {
        message_id: 100 + this.pendingUpdates.length,
        chat: { id: 42, type: "private" },
        from: { id: 7, first_name: "Alice", username: "alice" },
        text: "hello",
        ...overrides,
      },
    });
  }
}

class FakeCore implements CoreClient {
  readonly turns: any[] = [];
  readonly acked: string[] = [];
  readonly deliveries: any[] = [];
  readonly enqueueListeners: Array<() => void> = [];
  enqueue(delivery: any): void {
    this.deliveries.push(delivery);
    for (const l of this.enqueueListeners) l();
  }
  result: TurnResult = { status: "ok", reply: "agent reply" };
  queuedRunId: string | undefined;
  private heldRunClaimed = false;
  private runGate: Promise<void> | undefined;
  private releaseRun: (() => void) | undefined;

  async externalSlackParticipants(): Promise<boolean> {
    return false;
  }
  async surfaceHeaderFacts(): Promise<{ agentLabel?: string; modelName: string }> {
    return { modelName: "test-model" };
  }
  onScopeModelChanged(): void {}
  async stageBlob(bytes: Uint8Array): Promise<{ blobId: string; sizeBytes: number }> {
    return { blobId: "blob-1", sizeBytes: bytes.byteLength };
  }
  async readBlob(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async readFileArtifact(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async ingestSurfaceEvents(): Promise<void> {}
  async submitTurn(body: any): Promise<TurnResult> {
    // The real core-client injects the surface (createCoreClient(deps, "telegram"));
    // simulate that here so the turn body reflects the full path.
    this.turns.push({ ...body, surface: "telegram" });
    if (this.queuedRunId) {
      const steered = this.heldRunClaimed;
      this.heldRunClaimed = true;
      return { status: "queued", runId: this.queuedRunId, ...(steered ? { steered: true as const } : {}) };
    }
    return this.result;
  }
  async waitRun(): Promise<TurnResult | null> {
    if (this.runGate) await this.runGate;
    return this.result;
  }
  holdRun(runId: string): void {
    this.queuedRunId = runId;
    this.heldRunClaimed = false;
    this.runGate = new Promise<void>((resolve) => (this.releaseRun = resolve));
  }
  finishRun(result: TurnResult): void {
    this.result = result;
    this.releaseRun?.();
  }
  async activeRunForThread(): Promise<string | undefined> {
    return undefined;
  }
  async signalRunAbort(): Promise<void> {}
  async ackRunDelivery(): Promise<void> {}
  async reportTurnMetrics(): Promise<void> {}
  async reportRunEditRef(): Promise<void> {}
  async getApproval(): Promise<null> {
    return null;
  }
  async pushDirectory(): Promise<void> {}
  async claimDeliveries(type: string): Promise<any[]> {
    const rows = this.deliveries.filter((d) => d.destination.type === type);
    return rows;
  }
  async ackDelivery(id: string): Promise<void> {
    this.acked.push(id);
  }
  onDeliveryEnqueued(listener: () => void): () => void {
    this.enqueueListeners.push(listener);
    return () => {};
  }
  async pendingContextRequests(): Promise<[]> {
    return [];
  }
  onContextRequest(): () => void {
    return () => {};
  }
  async fulfillContextRequest(): Promise<void> {}
  async pickAckEmoji(): Promise<undefined> {
    return undefined;
  }
  async recordAckPick(): Promise<void> {}
}

import { startTelegramPlugin } from "../src/telegram/index.ts";

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("telegram plugin submits a turn and posts the reply", async () => {
  const server = new FakeTelegramServer();
  const core = new FakeCore();
  const plugin = await startTelegramPlugin(
    { botToken: "test-token", apiUrl: "http://fake", fetchImpl: server.handle.bind(server) as any },
    core,
  );
  try {
    server.emitMessage({});
    await waitFor(() => core.turns.length > 0);
    assert.equal(core.turns[0]!.surface, "telegram");
    assert.equal(core.turns[0]!.text, "hello");
    assert.equal(core.turns[0]!.conversation.kind, "dm");
    assert.equal(core.turns[0]!.conversation.threadRef, "dm:42");
    assert.equal(core.turns[0]!.actor.externalId, "7");
    assert.equal(core.turns[0]!.deliveryTarget, "42");
    await waitFor(() => server.sent.some((s) => s.method === "sendMessage"));
    const send = server.sent.find((s) => s.method === "sendMessage")!;
    assert.equal(send.body.chat_id, "42");
    assert.equal(send.body.text, "agent reply");
  } finally {
    await plugin.stop();
  }
});

test("telegram plugin splits long replies into multiple messages", async () => {
  const server = new FakeTelegramServer();
  const core = new FakeCore();
  core.result = { status: "ok", reply: "x".repeat(9000) };
  const plugin = await startTelegramPlugin(
    { botToken: "test-token", apiUrl: "http://fake", fetchImpl: server.handle.bind(server) as any },
    core,
  );
  try {
    server.emitMessage({});
    await waitFor(() => server.sent.filter((s) => s.method === "sendMessage").length >= 3);
    const sends = server.sent.filter((s) => s.method === "sendMessage");
    assert.equal(sends.length, 3);
    assert.ok(sends.every((s) => s.body.text.length <= 4096));
  } finally {
    await plugin.stop();
  }
});

test("telegram plugin replies in a thread when replying to the bot", async () => {
  const server = new FakeTelegramServer();
  const core = new FakeCore();
  const plugin = await startTelegramPlugin(
    { botToken: "test-token", apiUrl: "http://fake", fetchImpl: server.handle.bind(server) as any },
    core,
  );
  try {
    server.emitMessage({ reply_to_message: { message_id: 55 } });
    await waitFor(() => core.turns.length > 0);
    assert.equal(core.turns[0]!.conversation.threadRef, "dm:42:55");
    await waitFor(() => server.sent.some((s) => s.method === "sendMessage"));
    const send = server.sent.find((s) => s.method === "sendMessage")!;
    assert.equal(send.body.reply_to_message_id, 55);
  } finally {
    await plugin.stop();
  }
});

test("telegram plugin ignores bot messages and unlisted chats", async () => {
  const server = new FakeTelegramServer();
  const core = new FakeCore();
  const plugin = await startTelegramPlugin(
    {
      botToken: "test-token",
      apiUrl: "http://fake",
      allowedChatIds: ["99"],
      fetchImpl: server.handle.bind(server) as any,
    },
    core,
  );
  try {
    server.emitMessage({});
    server.emitMessage({ chat: { id: 42, type: "private" }, from: { id: 7, is_bot: true } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(core.turns.length, 0);
  } finally {
    await plugin.stop();
  }
});

test("telegram plugin claims and delivers type=telegram deliveries", async () => {
  const server = new FakeTelegramServer();
  const core = new FakeCore();
  const plugin = await startTelegramPlugin(
    { botToken: "test-token", apiUrl: "http://fake", fetchImpl: server.handle.bind(server) as any },
    core,
  );
  try {
    core.enqueue({
      id: "del-1",
      destination: { type: "telegram", target: "42" },
      text: "cron report",
      idempotencyKey: "cron:1",
      createdAt: Date.now(),
      deliveredAt: null,
    });
    await waitFor(() => server.sent.some((s) => s.method === "sendMessage" && s.body.text === "cron report"));
    await waitFor(() => core.acked.includes("del-1"));
  } finally {
    await plugin.stop();
  }
});

test("createCoreClient(deps, 'telegram') injects the telegram surface into turns", async () => {
  const bodies: any[] = [];
  const app = {
    turn: async (body: any) => {
      bodies.push(body);
      return { status: "ok", reply: "hi" };
    },
  };
  const deps: any = {
    app,
    config: {
      onRuntimeSelectionChanged: () => {},
      getExternalSlackParticipantsDurable: async () => false,
      getBrandingDurable: async () => ({}),
    },
    runtimeFallback: { harnessId: "pi", modelId: "pi" },
    blobTransfer: { put: async () => ({ blobId: "b", sizeBytes: 1 }), open: async () => null },
    deliveries: { onEnqueue: () => () => {} },
    metrics: { updateByRunId: async () => {} },
    runs: { onTerminal: () => {}, get: async () => null, activeForThread: async () => null },
    turnStream: { subscribe: () => () => {}, surfacePosted: () => false, firstBlock: () => undefined },
    tasks: { list: async () => [] },
  };
  const { createCoreClient } = await import("../src/api/core-client.ts");
  const turnBody = {
    actor: { externalId: "7" },
    conversation: { kind: "dm" as const, threadRef: "dm:42", audience: [{ externalId: "7" }] },
    text: "hello",
  };
  const telegramCore = createCoreClient(deps, "telegram");
  await telegramCore.submitTurn(turnBody);
  assert.equal(bodies[0]!.surface, "telegram");
  const slackCore = createCoreClient(deps);
  await slackCore.submitTurn(turnBody);
  assert.equal(bodies[1]!.surface, "slack");
});
