import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";
import { browserEnv } from "./browser-env.ts";

test("failed first side-chat attachment submissions restore the raw draft for retry", async () => {
  const env = await browserEnv({ fetch: async () => Response.json({ sessions: [] }) });
  let composer: ComposerSurface | undefined;
  try {
    const { createComposerSurface } = await env.vite.ssrLoadModule("/src/composer.ts");
    const { seedRuntimeConfig } = await env.vite.ssrLoadModule("/src/runtime-config-store.ts");
    const { appState } = await env.vite.ssrLoadModule("/src/shell-state.ts");
    appState.me = { user: "tester", org: "test" };
    const model = {
      id: "alpha",
      name: "Alpha",
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
      input: ["text"],
      contextWindow: 100_000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    seedRuntimeConfig("personal:tester", {
      scopeId: "personal:tester",
      models: ["alpha"],
      modelCatalog: { alpha: model },
      orgDefault: { modelId: "alpha", revision: 1 },
      effective: { modelId: "alpha" },
      scopeOverride: null,
      upgradeAvailable: false,
    });
    const sent: string[] = [];
    const messages: unknown[] = [];
    const agent = {
      state: { isStreaming: false, model, messages },
      prompt: async (message: { content: string }) => {
        sent.push(message.content);
        messages.push(message, { role: "assistant", sendFailed: "attachments", droppedAttachmentIds: [] });
      },
    } as unknown as Agent;
    const ctx = {
      pane: true,
      chat: {
        state: {
          agent,
          host: null,
          threadRef: "web:tester:retry",
          sessionId: "retry",
          scopeId: "personal:tester",
          resolvingApprovals: new Set<string>(),
          forkSession: { sideChat: { quote: "durable queue", expanded: false } },
        },
        activePendingApprovals: () => [],
        hasUnresolvedApproval: () => false,
        turnRuntime: () => null,
        drawActiveChat() {},
        notePendingSessionOnSend() {},
        scrollToBottom() {},
      },
    } as unknown as ConvCtx;
    let includeExcerpt = true;
    composer = createComposerSurface(ctx, { includeSideChatExcerpt: () => includeExcerpt });
    ctx.composer = composer!;
    composer!.state.draft = "Explain this";
    composer!.state.attachments = [
      {
        id: "file",
        type: "document",
        fileName: "note.txt",
        mimeType: "text/plain",
        size: 3,
        content: "YWJj",
      },
    ];
    await composer!.submit();
    assert.deepEqual(sent, ["> durable queue\n\nExplain this"]);
    assert.equal(composer!.state.draft, "Explain this");
    assert.equal(composer!.state.attachments.length, 1);
    assert.equal(messages.length, 0);
    await composer!.submit();
    assert.deepEqual(sent, ["> durable queue\n\nExplain this", "> durable queue\n\nExplain this"]);
    includeExcerpt = false;
    await composer!.submit();
    assert.equal(sent[2], "Explain this");
    assert.equal(composer!.state.draft, "Explain this");
  } finally {
    composer?.dispose();
    await env.close();
  }
});
