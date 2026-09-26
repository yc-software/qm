import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");

interface IncognitoConversation {
  state: { sessionId: string | null; threadRef: string | null; incognito: boolean };
  composer: { state: { draft: string }; submit(): Promise<void> };
  adoptIncognitoSession(threadRef: string, sessionId: string): void;
}

const TRAY_GHOST = '.split-single-tools .split-pane-incognito[aria-label="Go incognito"]';
const PANE_BADGE = `${TRAY_GHOST}.active`;

const OLD_SESSION = {
  id: "sess-old",
  type: "dm",
  scopeId: "personal:tester",
  threadRef: "web:tester:old",
  createdAt: Date.now(),
  title: "Old chat",
};

const RUNTIME = {
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
};

async function until(check: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), message);
}

test("the pane tool tray always offers to go incognito, and nothing else in the sidebar does", () => {
  const tray = split.slice(split.indexOf('class="split-single-tools"'), split.indexOf("PANE_TOOLS.map((t) => {"));
  assert.match(tray, /class="session-tool split-pane-incognito/);
  assert.match(tray, /aria-label="Go incognito"/);
  assert.match(tray, /\$\{tip\("Go incognito"\)\}/);
  assert.match(tray, /@click=\$\{\(\) => startNewIncognitoChat\(\)\}/);
  assert.match(split, /closeMenu\(\);\s*startNewIncognitoChat\(\);[\s\S]*?<span>Go incognito<\/span>/);
  assert.doesNotMatch(sessions, /startIncognitoFromMenu|<span>Go incognito<\/span>/);
  assert.doesNotMatch(shell, /new-incognito-btn|startNewIncognitoChat/);
});

test("an incognito chat shows its hint and badge, stays out of the sidebar, and flags only its first turn", async () => {
  const h = await harness({
    path: "/",
    listSessions: [OLD_SESSION],
    contexts: [{ scopeId: OLD_SESSION.scopeId, kind: "personal", name: null, sessionCount: 1, lastActivityAt: 0 }],
  });
  Object.defineProperty(window.Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  const matrixDescriptor = Object.getOwnPropertyDescriptor(globalThis, "DOMMatrix");
  Object.defineProperty(globalThis, "DOMMatrix", { configurable: true, value: class {} });
  const previousFetch = globalThis.fetch;
  const turns: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("/api/runtime-config")) return Response.json(RUNTIME);
    if (String(input) === "/api/turn") {
      turns.push(JSON.parse(String(init?.body)));
      return Response.json({ reply: "Noted." });
    }
    return previousFetch(input, init);
  };
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    await until(() => Boolean(document.querySelector(TRAY_GHOST)), "the tool tray shows the ghost");
    assert.equal(document.querySelector(PANE_BADGE), null, "an ordinary chat's ghost is not active");
    document.querySelector<HTMLButtonElement>(TRAY_GHOST)!.click();
    const conv = h.visibleConversation() as unknown as IncognitoConversation;
    const threadRef = conv.state.threadRef!;
    assert.equal(conv.state.incognito, true);
    assert.equal(conv.state.sessionId, null);

    const hint = document.querySelector(".incognito-hint");
    assert.ok(hint, "the empty chat explains incognito");
    assert.match(hint.textContent ?? "", /Incognito/);
    assert.match(hint.textContent ?? "", /Nothing from this chat is saved to your qm\./);
    assert.equal(document.querySelector(".chat-cta"), null);
    await until(() => Boolean(document.querySelector(PANE_BADGE)), "the pane header carries the ghost badge");
    await until(
      () => document.querySelector(".composer-input")?.getAttribute("placeholder") === "Message incognito",
      "the composer invites an incognito message",
    );
    assert.equal(
      h.sessionsState.list.some((s) => (s as { threadRef?: string }).threadRef === threadRef),
      false,
      "a new incognito chat is never added to the sidebar",
    );

    conv.composer.state.draft = "Something private";
    await conv.composer.submit();
    await until(() => turns.length === 1, "the first message is sent");
    assert.equal(turns[0]!.incognito, true);
    assert.equal(turns[0]!.threadRef, threadRef);
    assert.equal(
      h.sessionsState.list.some((s) => (s as { threadRef?: string }).threadRef === threadRef),
      false,
      "sending does not insert an optimistic sidebar row",
    );

    conv.adoptIncognitoSession(threadRef, "sess-incognito");
    assert.equal(conv.state.sessionId, "sess-incognito");
    assert.equal(location.pathname, "/s/sess-incognito");
    assert.ok(document.querySelector(PANE_BADGE), "the badge stays once the session exists");

    conv.composer.state.draft = "And a follow-up";
    await conv.composer.submit();
    await until(() => turns.length === 2, "the follow-up is sent");
    assert.equal(turns[1]!.incognito, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    await h.close();
    if (matrixDescriptor) Object.defineProperty(globalThis, "DOMMatrix", matrixDescriptor);
    else Reflect.deleteProperty(globalThis, "DOMMatrix");
  }
});

test("an ordinary new chat shows no incognito hint or badge", async () => {
  const h = await harness({ path: "/", listSessions: [OLD_SESSION] });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const conv = h.visibleConversation() as unknown as IncognitoConversation;
    assert.equal(conv.state.incognito, false);
    assert.equal(document.querySelector(".incognito-hint"), null);
    assert.equal(document.querySelector(`${PANE_BADGE}, .session-incognito-badge`), null);
  } finally {
    await h.close();
  }
});

test("an incognito session reopened by URL shows the badge without joining the sidebar", async () => {
  const h = await harness({ path: `/s/${SESSION.id}`, session: { ...SESSION, incognito: true } as never });
  try {
    await h.boot();
    const conv = h.visibleConversation() as unknown as IncognitoConversation;
    assert.equal(conv.state.sessionId, SESSION.id);
    assert.equal(conv.state.incognito, true);
    await until(() => Boolean(document.querySelector(PANE_BADGE)), "the reopened chat is badged");
    assert.equal(document.querySelector(".incognito-hint"), null);
    assert.equal(
      h.sessionsState.list.some((s) => s.id === SESSION.id),
      false,
      "the linked incognito session is not seeded into the sidebar",
    );
  } finally {
    await h.close();
  }
});
