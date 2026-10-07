import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("connection continuation waits for scoped runtime settings before submitting", async () => {
  const h = await harness({
    path: "/s/sess-deep?composioReturn=return-nonce&status=success&connectedAccountId=ca_test",
    session: { ...SESSION, type: "dm", createdAt: 1, scopeId: "context:demo" },
    entries: [{ seq: 1, type: "assistant", createdAt: 1, payload: { text: '::connect-apps{toolkit="gmail"}' } }],
    connectionReturn: true,
    returnWidget: "reply:1:0:0",
  });
  const originalFetch = globalThis.fetch;
  let releaseRuntime = (): void => {};
  const runtimeHeld = new Promise<void>((resolve) => (releaseRuntime = resolve));
  const turns: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/runtime-config" && url.search) {
      await runtimeHeld;
      return Response.json({
        scopeId: "context:demo",
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["alpha"] },
        modelCatalog: {
          alpha: {
            id: "alpha",
            name: "Alpha",
            label: "Alpha",
            buttonLabel: "Alpha",
            provider: "openai",
            api: "openai-responses",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100000,
            maxTokens: 4096,
          },
        },
        orgDefault: { harnessId: "pi", modelId: "alpha", revision: 1 },
        effective: { harnessId: "pi", modelId: "alpha" },
        scopeOverride: null,
        upgradeAvailable: false,
      });
    }
    if (url.pathname === "/api/turn") {
      turns.push(JSON.parse(String(init?.body)));
      return Response.json({ runId: "continuation-test", sessions: [] });
    }
    return originalFetch(input, init);
  };
  try {
    await h.boot();
    for (let i = 0; i < 100 && sessionStorage.getItem("qm-connection-return:test:tester"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(sessionStorage.getItem("qm-connection-return:test:tester"), null);
    assert.equal(turns.length, 0);
    assert.equal(h.visibleConversation().composer.state.draft, "");
    releaseRuntime();
    for (let i = 0; i < 100 && !turns.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(turns.length, 1);
    assert.match(JSON.stringify(turns[0]), /I connected Gmail\. Please continue\./);
  } finally {
    releaseRuntime();
    await h.close();
  }
});
