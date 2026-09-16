import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("More ideas opens a fresh personal web chat and sends the examples once", async () => {
  const h = await harness({ path: "/", welcome: true, listSessions: [] });
  Object.defineProperty(window.Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  Object.defineProperty(window.Element.prototype, "animate", {
    configurable: true,
    value: () => ({ cancel() {}, currentTime: 0 }),
  });
  const matrixDescriptor = Object.getOwnPropertyDescriptor(globalThis, "DOMMatrix");
  Object.defineProperty(globalThis, "DOMMatrix", { configurable: true, value: class {} });
  const previousFetch = globalThis.fetch;
  const turns: Record<string, unknown>[] = [];
  const realNow = Date.now;
  let holdRuntime = false;
  let releaseRuntime: () => void = () => {};
  const runtimeHeld = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("/api/runtime-config")) {
      if (holdRuntime) await runtimeHeld;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return Response.json({
        scopeId: "personal:tester",
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["test-model"] },
        modelCatalog: {
          "test-model": {
            id: "test-model",
            name: "Test",
            label: "Test",
            buttonLabel: "Test",
            provider: "anthropic",
            api: "anthropic-messages",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 10000,
            maxTokens: 1000,
          },
        },
        effective: { harnessId: "pi", modelId: "test-model" },
        orgDefault: { harnessId: "pi", modelId: "test-model", revision: 1 },
        scopeOverride: null,
        upgradeAvailable: false,
      });
    }
    if (String(input) === "/api/turn") {
      turns.push(JSON.parse(String(init?.body)));
      return Response.json({ reply: "Let's explore ideas." });
    }
    return previousFetch(input, init);
  };
  try {
    h.releaseSessions();
    await h.boot();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const originalThread = h.visibleConversation().state.threadRef;
    const draft = document.querySelector<HTMLTextAreaElement>(".composer-input")!;
    draft.value = "Keep this draft";
    draft.dispatchEvent(new window.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    document.querySelector<HTMLButtonElement>(".welcome-more-ideas")!.click();
    assert.equal(h.visibleConversation().state.threadRef, originalThread);
    assert.equal(turns.length, 0);
    draft.value = "";
    draft.dispatchEvent(new window.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const more = document.querySelector<HTMLButtonElement>(".welcome-more-ideas")!;
    assert.ok(more);
    holdRuntime = true;
    Date.now = () => realNow() + 31_000;
    more.click();
    more.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(turns.length, 0);
    assert.notEqual(h.visibleConversation().state.threadRef, originalThread);
    releaseRuntime();
    for (let i = 0; i < 100 && !turns.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(turns.length, 1, h.mainText());
    assert.notEqual(turns[0]!.threadRef, originalThread);
    assert.match(String(turns[0]!.threadRef), /^web:tester:ideas:/);
    assert.equal(turns[0]!.scopeId, undefined);
    assert.equal(turns[0]!.proactiveOpener, undefined);
    assert.match(String(turns[0]!.text), /Work at a Startup/);
    assert.match(String(turns[0]!.text), /Stripe/);
    assert.match(String(turns[0]!.text), /fundraising dashboard/);
    assert.match(String(turns[0]!.text), /Skip onboarding/);
    assert.match(String(turns[0]!.text), /yc tool/);
    assert.match(String(turns[0]!.text), /When available and authorized, read company\.get/);
    assert.match(String(turns[0]!.text), /company\.goals for dated goals and progress/);
    assert.match(String(turns[0]!.text), /read get_yc_application.*when available and authorized/);
    assert.match(String(turns[0]!.text), /another company or a draft.*verify it matches my current company/);
    assert.match(
      String(turns[0]!.text),
      /Prefer my recent statements and dated current goals over old application answers/,
    );
    assert.match(
      String(turns[0]!.text),
      /do not treat historical answers as current facts or assume the company profile was recently updated/,
    );
    assert.match(String(turns[0]!.text), /if tools or records are unavailable, continue with what you know/);
  } finally {
    releaseRuntime();
    Date.now = realNow;
    await h.close();
    if (matrixDescriptor) Object.defineProperty(globalThis, "DOMMatrix", matrixDescriptor);
    else Reflect.deleteProperty(globalThis, "DOMMatrix");
  }
});
