import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";
import type { CoreSession } from "../src/core-bridge.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Side chat did not reach the expected state");
}

test("select a passage, discuss beside the source, reopen, and expand the same session", async () => {
  const source: CoreSession = {
    id: "source",
    threadRef: "web:tester:source",
    scopeId: "personal:tester",
    canContinue: true,
    type: "dm",
    createdAt: Date.now(),
    title: "Queue design",
  };
  const entries = [
    { seq: 0, type: "user", createdAt: Date.now(), payload: { text: "Use durable, then durable shared queue" } },
  ];
  let fork: CoreSession | undefined;
  let forkBody: unknown;
  let failFork = true;
  let failOpen = true;
  let releaseFork!: () => void;
  let forkReady = new Promise<void>((resolve) => {
    releaseFork = resolve;
  });
  const h = await harness({
    path: "/s/source",
    session: source,
    listSessions: [source],
    entries,
    api(path, init) {
      if (path.startsWith("/api/runtime-config"))
        return Response.json({
          scopeId: "personal:tester",
          models: ["m"],
          modelCatalog: {
            m: {
              id: "m",
              name: "Test model",
              provider: "openai",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              contextWindow: 100000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          },
          orgDefault: { modelId: "m", revision: 1 },
          scopeOverride: null,
          effective: { modelId: "m" },
          upgradeAvailable: false,
        });
      if (path === "/api/sessions/source/side-chats") return Response.json({ sessions: fork ? [fork] : [] });
      if (path === "/api/sessions/side/side-chats") return Response.json({ sessions: [] });
      if (path === "/api/sessions/source/fork") {
        forkBody = JSON.parse(String(init?.body));
        fork = {
          ...source,
          id: "side",
          threadRef: "web:tester:side",
          forkedFrom: { sessionId: source.id },
          forkBoundarySeq: 0,
          sideChat: { entrySeq: 0, quote: "durable", occurrence: 1, expanded: false },
        };
        return forkReady.then(() => {
          if (failFork) {
            failFork = false;
            return Response.json({ error: "Fork temporarily unavailable" }, { status: 503 });
          }
          return Response.json({ session: fork, entries });
        });
      }
      if (path.startsWith("/api/sessions/side?") || path === "/api/sessions/side") {
        if (failOpen) {
          failOpen = false;
          return Response.json({ error: "Load temporarily unavailable" }, { status: 503 });
        }
        return Response.json({ session: fork, entries });
      }
      if (path === "/api/sessions/side/expand") {
        assert.equal(init?.method, "POST");
        fork = { ...fork!, sideChat: { ...fork!.sideChat!, expanded: true } };
        return Response.json({ session: fork });
      }
      return undefined;
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(() => Boolean(document.querySelector(".message-row p")));
    const paragraph = document.querySelector(".message-row p")!;
    const text = paragraph.firstChild!;
    paragraph.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    const range = document.createRange();
    const secondDurable = text.textContent!.lastIndexOf("durable");
    range.setStart(text, secondDurable);
    range.setEnd(text, secondDurable + "durable".length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    Object.defineProperty(range, "getBoundingClientRect", { value: () => ({ left: 100, top: 150 }) });
    document.dispatchEvent(new window.Event("selectionchange"));
    assert.equal(document.querySelector(".side-chat-discuss"), null);
    paragraph.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    let discuss = document.querySelector<HTMLButtonElement>(".side-chat-discuss")!;
    assert.equal(discuss.textContent?.trim(), "Ask about");
    const firstPosition = discuss.style.top;
    paragraph.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    assert.equal(document.querySelector(".side-chat-discuss"), null);
    const replacement = document.createRange();
    replacement.setStart(text, 0);
    replacement.setEnd(text, 3);
    Object.defineProperty(replacement, "getBoundingClientRect", {
      value: () => ({ left: 180, top: 210, bottom: 230 }),
    });
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(replacement);
    document.dispatchEvent(new window.Event("selectionchange"));
    assert.equal(document.querySelector(".side-chat-discuss"), null);
    paragraph.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    assert.notEqual(document.querySelector<HTMLButtonElement>(".side-chat-discuss")!.style.top, firstPosition);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new window.Event("selectionchange"));
    document.querySelector(".chat-scroll")!.dispatchEvent(new window.Event("scroll"));
    assert.equal(document.querySelector(".side-chat-discuss"), null);
    paragraph.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    discuss = document.querySelector<HTMLButtonElement>(".side-chat-discuss")!;
    discuss.click();
    assert.ok(document.querySelector(".side-chat-panel"));
    const pendingInput = document.querySelector<HTMLTextAreaElement>(".side-chat-draft textarea")!;
    pendingInput.value = "Explain this";
    pendingInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(document.querySelector<HTMLButtonElement>(".side-chat-draft .send-btn")!.disabled, true);
    assert.equal(document.querySelector(".side-chat-marker"), null);
    await until(() => Boolean(forkBody));
    assert.ok(document.querySelector(".side-chat-panel"));
    assert.equal(document.querySelector<HTMLTextAreaElement>(".side-chat-draft textarea")!.value, "Explain this");
    releaseFork();
    const retry = () =>
      [...document.querySelectorAll<HTMLButtonElement>(".side-chat-error button")].find(
        (button) => button.textContent === "Retry",
      );
    await until(() => Boolean(retry() && !retry()!.disabled));
    assert.equal(document.querySelector<HTMLTextAreaElement>(".side-chat-draft textarea")!.value, "Explain this");
    retry()!.dispatchEvent(new window.Event("pointerdown", { bubbles: true, composed: true }));
    retry()!.click();
    await until(() => Boolean(retry() && !retry()!.disabled));
    assert.equal(document.querySelector<HTMLTextAreaElement>(".side-chat-draft textarea")!.value, "Explain this");
    const forkRequests = h.requests.filter((path) => path === "/api/sessions/source/fork").length;
    retry()!.dispatchEvent(new window.Event("pointerdown", { bubbles: true, composed: true }));
    retry()!.click();
    await until(() => Boolean(document.querySelector(".side-chat-conversation textarea")));
    assert.equal(h.requests.filter((path) => path === "/api/sessions/source/fork").length, forkRequests);
    assert.equal(document.querySelector(".side-chat-panel .fork-origin-badge"), null);
    assert.equal(document.querySelector(".side-chat-panel .fork-origin-toggle"), null);
    assert.deepEqual(forkBody, { upToSeq: 0, sideChat: { entrySeq: 0, quote: "durable", occurrence: 1 } });
    assert.match(
      document.querySelector(".side-chat-layout > .custom-chat-shell")!.textContent!,
      /Use durable, then durable shared queue/,
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(".side-chat-conversation textarea")!.value,
      "Explain this",
    );
    document.querySelector<HTMLButtonElement>('.side-chat-panel [aria-label="Expand side chat"]')!.click();
    document.querySelector<HTMLButtonElement>('.side-chat-panel [aria-label="Remove excerpt"]')!.click();
    assert.equal(document.querySelector(".side-chat-excerpt"), null);
    assert.equal(fork!.sideChat!.quote, "durable");

    document
      .querySelector(".side-chat-conversation .custom-chat")!
      .dispatchEvent(new window.Event("pointerdown", { bubbles: true, composed: true }));
    assert.ok(document.querySelector(".side-chat-panel"));
    paragraph.dispatchEvent(new window.Event("pointerdown", { bubbles: true, composed: true }));
    assert.equal(document.querySelector(".side-chat-panel"), null);
    await until(() => Boolean(document.querySelector(".side-chat-marker")));
    assert.equal(document.querySelector(".side-chat-marker")!.getAttribute("aria-expanded"), "false");
    document.querySelector<HTMLButtonElement>(".side-chat-markers button")!.click();
    await until(() => Boolean(document.querySelector(".side-chat-conversation .custom-chat")));
    document
      .querySelector(".side-chat-panel")!
      .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(document.querySelector(".side-chat-panel"), null);
    assert.equal(document.activeElement, document.querySelector(".side-chat-markers button"));
    assert.equal(document.querySelector(".side-chat-marker")!.getAttribute("aria-expanded"), "false");
    const { passageRange } = await import("../src/passage-range.ts");
    const anchor = passageRange(paragraph, "durable", fork!.sideChat!.occurrence);
    assert.equal(anchor?.toString(), "durable");
    assert.equal(anchor?.startOffset, secondDurable);
    const formatted = document.createElement("div");
    formatted.innerHTML = "<p>Use a <strong>durable</strong> queue.</p><p>Retry safely.</p>";
    assert.equal(
      passageRange(formatted, "durable queue.\nRetry safely.", 0)?.toString(),
      "durable queue.Retry safely.",
    );
    assert.equal(passageRange(formatted, "not present", 0), null);
    const repeated = document.createElement("div");
    repeated.innerHTML = "<p>again, then again </p>";
    const repeatedText = repeated.querySelector("p")!.firstChild!;
    const repeatedSelection = document.createRange();
    repeatedSelection.setStart(repeatedText, 11);
    repeatedSelection.setEnd(repeatedText, 18);
    const { passageOccurrence } = await import("../src/passage-range.ts");
    assert.equal(passageOccurrence(repeated, repeatedSelection, "again"), 1);
    assert.equal(passageRange(repeated, "again", 1)?.toString(), "again");
    document.querySelector<HTMLButtonElement>(".side-chat-markers button")!.click();
    await until(() => Boolean(document.querySelector(".side-chat-conversation .custom-chat")));
    const expand = [...document.querySelectorAll<HTMLButtonElement>(".side-chat-panel header button")].find(
      (button) => button.getAttribute("aria-label") === "Open as session",
    )!;
    expand.click();
    await until(() => h.visibleConversation().state.sessionId === "side");
    assert.equal(fork!.sideChat!.expanded, true);
    assert.equal(h.requests.filter((path) => path === "/api/sessions/side/expand").length, 1);
    await until(() => Boolean(document.querySelector(".fork-origin-badge")));
    assert.match(document.querySelector(".fork-origin-badge")!.textContent!, /Forked from/);
    document.querySelector<HTMLButtonElement>(".fork-origin-toggle")!.click();
    await until(() => document.querySelector(".fork-origin-toggle")?.textContent === "hide");
    assert.match(document.querySelector(".message-stack")!.textContent!, /Use durable, then durable shared queue/);
    assert.equal(h.requests.filter((path) => path === "/api/sessions/source/fork").length, 2);
    await h.openSession(source);
    forkReady = new Promise<void>((resolve) => {
      releaseFork = resolve;
    });
    const again = document.querySelector(".message-row p")!;
    const selection = document.createRange();
    selection.setStart(again.firstChild!, 0);
    selection.setEnd(again.firstChild!, 3);
    Object.defineProperty(selection, "getBoundingClientRect", { value: () => ({ left: 100, top: 150, bottom: 170 }) });
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(selection);
    again.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    document.querySelector<HTMLButtonElement>(".side-chat-discuss")!.click();
    assert.ok(document.querySelector(".side-chat-panel"));
    document.querySelector<HTMLButtonElement>('[aria-label="Close side chat"]')!.click();
    releaseFork();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(document.querySelector(".side-chat-panel"), null);
  } finally {
    releaseFork();
    await h.close();
  }
});
