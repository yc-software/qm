import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("AI account modal interactions", async (t) => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><button id="opener">Manage AI accounts</button>', {
    url: "http://localhost/settings",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    customElements: dom.window.customElements,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    plugins: [
      {
        name: "settings-shell-boundary",
        enforce: "pre",
        resolveId(source, importer) {
          if (!importer?.endsWith("/src/settings.ts")) return;
          if (source === "./shell" || source === "./sessions") return `\0settings-test:${source}`;
        },
        load(id) {
          if (id === "\0settings-test:./shell")
            return 'export { appState, can } from "/src/shell-state.ts"; export const ADMIN_HOME_URL = "/admin"; export function signOut() {}';
          if (id === "\0settings-test:./sessions")
            return "export const sessionsState = { webOnly: false }; export function setWebOnly(value) { sessionsState.webOnly = value; }";
        },
      },
    ],
  });
  const { openModelConnectManager, renderModelConnectGate } = await vite.ssrLoadModule("/src/model-connect.ts");
  const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
  appState.me = { user: "alice", org: "acme" };
  const doc = dom.window.document;
  const status = (account = "company", connections: { provider: string; kind: string }[] = []) => ({
    account,
    individualModelAuth: account !== "company",
    required: false,
    connections,
  });
  const pendingDevice = {
    deviceAuthId: "test-login",
    userCode: "TEST-CODE",
    verificationUrl: "https://example.test/device",
    expiresAt: Date.now() + 600_000,
    intervalMs: 60_000,
  };
  let fetcher: (path: string, init?: RequestInit) => Promise<Response>;
  globalThis.fetch = async (input, init) => fetcher(String(input), init);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  const button = (label: string) => {
    const found = [...doc.querySelectorAll<HTMLButtonElement>(".mc-overlay button")].find(
      (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
    );
    assert.ok(found, `button ${label} exists`);
    return found;
  };
  const provider = (name: string) => {
    const found = [...doc.querySelectorAll<HTMLElement>(".mc-provider")].find(
      (el) => el.querySelector("strong")?.textContent === name,
    );
    assert.ok(found, `provider ${name} exists`);
    return found;
  };
  const providerButton = (name: string, label: string) => {
    const found = [...provider(name).querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === label || b.querySelector(".mc-method-title")?.textContent === label,
    );
    assert.ok(found, `${name}: ${label} exists`);
    found.click();
  };
  const open = async () => {
    doc.querySelector<HTMLButtonElement>("#opener")!.focus();
    openModelConnectManager();
    await tick();
  };
  const close = () => doc.querySelector<HTMLButtonElement>(".mc-close")?.click();
  const base = async (path: string) => {
    if (path.endsWith("/status")) return Response.json(status());
    if (path.endsWith("/chatgpt/start")) return Response.json(pendingDevice);
    if (path.endsWith("/chatgpt/poll")) return Response.json({ status: "pending" });
    if (path.endsWith("/claude/start"))
      return Response.json({ authorizeUrl: "https://example.test/claude", verifier: "test-verifier" });
    throw new Error(`Unexpected request ${path}`);
  };
  t.after(async () => {
    close();
    await vite.close();
    dom.window.close();
  });

  await t.test("Escape, focus trap, backdrop close, and focus restoration work", async () => {
    fetcher = base;
    await open();
    assert.equal(doc.activeElement, button("Close"));
    const last = button("Done");
    last.focus();
    last.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    assert.equal(doc.activeElement, button("Close"));
    button("Close").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(doc.querySelector(".mc-overlay"), null);
    assert.equal(doc.activeElement?.id, "opener");
    await open();
    doc.querySelector<HTMLElement>(".mc-overlay .signin")!.click();
    assert.equal(doc.querySelector(".mc-overlay"), null);
  });

  await t.test("an initial status failure is retryable and never shows a guessed account", async () => {
    let fail = true;
    fetcher = async (path) => (fail ? Response.json({ error: "offline" }, { status: 503 }) : base(path));
    await open();
    assert.match(doc.querySelector("[role=alert]")!.textContent!, /offline/);
    assert.equal(doc.querySelector(".mc-providers"), null);
    fail = false;
    button("Retry").click();
    await tick();
    assert.ok(doc.querySelector(".mc-providers"));
    close();
  });

  await t.test("switching providers clears key drafts; selecting the same method preserves them", async () => {
    fetcher = base;
    await open();
    providerButton("ChatGPT / Codex", "Connect");
    providerButton("ChatGPT / Codex", "Use an API key");
    const input = doc.querySelector<HTMLInputElement>("input")!;
    input.value = "test-only-openai-key";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    providerButton("ChatGPT / Codex", "Use an API key");
    assert.equal(doc.querySelector<HTMLInputElement>("input")!.value, "test-only-openai-key");
    providerButton("Claude", "Connect");
    assert.equal(doc.querySelector("input"), null);
    providerButton("Claude", "Use an API key");
    assert.equal(doc.querySelector<HTMLInputElement>("input")!.value, "");
    providerButton("Claude", "Cancel");
    assert.equal(doc.querySelector("input"), null);
    close();
  });

  await t.test("a delayed sign-in response cannot overwrite a reopened modal", async () => {
    let resolveStart!: (r: Response) => void;
    fetcher = (path) =>
      path.endsWith("/chatgpt/start")
        ? new Promise((resolve) => {
            resolveStart = resolve;
          })
        : base(path);
    await open();
    providerButton("ChatGPT / Codex", "Connect");
    providerButton("ChatGPT / Codex", "Sign in with ChatGPT / Codex");
    close();
    await open();
    providerButton("Claude", "Connect");
    providerButton("Claude", "Use an API key");
    resolveStart(Response.json(pendingDevice));
    await tick();
    assert.ok(provider("Claude").querySelector("input"));
    assert.equal(doc.querySelector(".mc-code"), null);
    close();
  });

  await t.test("poll errors stay visible and allow a fresh sign-in", async () => {
    let starts = 0;
    fetcher = (path) => {
      if (path.endsWith("/chatgpt/start")) starts++;
      return path.endsWith("/chatgpt/poll")
        ? Promise.resolve(Response.json({ message: "login expired or unknown" }, { status: 502 }))
        : base(path);
    };
    await open();
    providerButton("ChatGPT / Codex", "Connect");
    providerButton("ChatGPT / Codex", "Sign in with ChatGPT / Codex");
    await tick();
    assert.match(doc.querySelector("[role=alert]")!.textContent!, /expired/);
    providerButton("ChatGPT / Codex", "Sign in with ChatGPT / Codex");
    await tick();
    assert.equal(starts, 2);
    close();
  });

  await t.test("an in-flight successful poll cannot overlap a key save or reopened modal", async () => {
    let resolvePoll!: (response: Response) => void;
    let connected = false;
    fetcher = (path) => {
      if (path.endsWith("/chatgpt/poll"))
        return new Promise((resolve) => {
          resolvePoll = resolve;
        });
      if (path.endsWith("/status"))
        return Promise.resolve(
          Response.json(status("company", connected ? [{ provider: "openai", kind: "oauth" }] : [])),
        );
      return base(path);
    };
    await open();
    providerButton("ChatGPT / Codex", "Connect");
    providerButton("ChatGPT / Codex", "Sign in with ChatGPT / Codex");
    await tick();
    providerButton("ChatGPT / Codex", "Use an API key");
    assert.equal(doc.querySelector("input"), null);
    assert.equal(button("Cancel").disabled, true);
    close();
    assert.ok(doc.querySelector(".mc-overlay"));
    connected = true;
    resolvePoll(Response.json({ status: "connected" }));
    await tick();
    assert.ok(provider("ChatGPT / Codex").classList.contains("connected"));
    assert.equal(button("Done").disabled, false);
    close();
  });

  await t.test(
    "key errors preserve the draft, success refreshes connections, and disconnect keeps the chosen billing source",
    async () => {
      let connected = false;
      let fail = true;
      let account = "company";
      fetcher = async (path, init) => {
        if (path.endsWith("/api-key")) {
          if (fail) return Response.json({ error: "invalid_api_key" }, { status: 400 });
          connected = true;
          return Response.json({ ok: true });
        }
        if (path.endsWith("/account")) account = JSON.parse(String(init?.body)).provider;
        if (path.endsWith("/disconnect")) {
          connected = false;
          return Response.json({ ok: true });
        }
        return Response.json(status(account, connected ? [{ provider: "anthropic", kind: "apikey" }] : []));
      };
      await open();
      providerButton("Claude", "Connect");
      providerButton("Claude", "Use an API key");
      const input = doc.querySelector<HTMLInputElement>("input")!;
      input.value = "test-only-key";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      providerButton("Claude", "Connect");
      await tick();
      assert.match(doc.querySelector("[role=alert]")!.textContent!, /rejected/);
      assert.equal(doc.querySelector<HTMLInputElement>("input")!.value, "test-only-key");
      fail = false;
      providerButton("Claude", "Connect");
      await tick();
      assert.ok(provider("Claude").classList.contains("connected"));
      assert.equal(appState.me.individualModelAuth, false);
      providerButton("Claude", "Use account");
      await tick();
      providerButton("Claude", "Disconnect");
      await tick();
      assert.equal(appState.me.individualModelAuth, true);
      assert.equal(appState.me.modelAuthConnected, false);
      assert.match(doc.querySelector("[role=status]")!.textContent!, /Reconnect/);
      close();
    },
  );

  await t.test("account saves finish before the modal can close", async () => {
    let resolveSave!: (response: Response) => void;
    const connections = [{ provider: "openai", kind: "oauth" }];
    fetcher = (path) =>
      path.endsWith("/account")
        ? new Promise((resolve) => {
            resolveSave = resolve;
          })
        : Promise.resolve(Response.json(status("company", connections)));
    await open();
    providerButton("ChatGPT / Codex", "Use account");
    assert.equal(button("Done").disabled, true);
    close();
    doc
      .querySelector(".mc-overlay")!
      .dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    doc.querySelector<HTMLElement>(".mc-overlay .signin")!.click();
    assert.ok(doc.querySelector(".mc-overlay"));
    resolveSave(Response.json(status("openai", connections)));
    await tick();
    assert.equal(appState.me.individualModelAuth, true);
    assert.equal(button("Done").disabled, false);
    close();
    assert.equal(doc.querySelector(".mc-overlay"), null);
  });

  await t.test("a pending key save prevents cancellation and overlapping writes", async () => {
    let resolveSave!: (response: Response) => void;
    let writes = 0;
    fetcher = (path) => {
      if (path.endsWith("/api-key")) {
        writes++;
        return new Promise((resolve) => {
          resolveSave = resolve;
        });
      }
      return base(path);
    };
    await open();
    providerButton("Claude", "Connect");
    providerButton("Claude", "Use an API key");
    const input = doc.querySelector<HTMLInputElement>("input")!;
    input.value = "test-only-key";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    providerButton("Claude", "Connect");
    assert.equal(button("Cancel").disabled, true);
    providerButton("Claude", "Cancel");
    const submit = provider("Claude").querySelector<HTMLButtonElement>(".btn.primary")!;
    assert.equal(submit.disabled, true);
    submit.click();
    providerButton("ChatGPT / Codex", "Connect");
    assert.equal(writes, 1);
    assert.ok(provider("Claude").querySelector("input"));
    resolveSave(Response.json({ error: "invalid_api_key" }, { status: 400 }));
    await tick();
    assert.equal(button("Cancel").disabled, false);
    assert.equal(button("Done").disabled, false);
    assert.equal(doc.querySelector<HTMLInputElement>("input")!.value, "test-only-key");
    close();
  });

  await t.test("choosing a provider opens only its sign-in and activates it after connecting", async () => {
    let connected = false;
    let account = "company";
    fetcher = async (path, init) => {
      if (path.endsWith("/status"))
        return Response.json(status(account, connected ? [{ provider: "anthropic", kind: "apikey" }] : []));
      if (path.endsWith("/api-key")) {
        connected = true;
        return Response.json({ ok: true });
      }
      if (path.endsWith("/account")) {
        account = JSON.parse(String(init?.body)).provider;
        return Response.json(status(account, [{ provider: "anthropic", kind: "apikey" }]));
      }
      return base(path);
    };
    openModelConnectManager("anthropic");
    await tick();
    assert.equal(doc.querySelector("#mc-title")!.textContent?.trim(), "Connect Claude");
    assert.equal(doc.querySelector(".mc-providers"), null);
    assert.equal(doc.querySelector(".mc-method"), null);
    button("Use an API key instead").click();
    const input = doc.querySelector<HTMLInputElement>("input")!;
    input.value = "test-only-key";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    button("Connect").click();
    await tick();
    assert.equal(account, "anthropic");
    assert.equal(appState.me.individualModelAuth, true);
    assert.equal(doc.querySelector(".mc-overlay"), null);
  });

  await t.test("expired device codes offer a new sign-in rather than polling forever", async () => {
    let polls = 0;
    fetcher = (path) => {
      if (path.endsWith("/chatgpt/start")) return Promise.resolve(Response.json({ ...pendingDevice, expiresAt: 1 }));
      if (path.endsWith("/chatgpt/poll")) polls++;
      return base(path);
    };
    await open();
    providerButton("ChatGPT / Codex", "Connect");
    providerButton("ChatGPT / Codex", "Sign in with ChatGPT / Codex");
    await tick();
    assert.match(doc.querySelector("[role=alert]")!.textContent!, /expired/);
    assert.equal(polls, 0);
    assert.equal(doc.querySelector(".mc-code"), null);
    close();
  });

  await t.test("switching accounts updates the modal and app without reloading or disconnecting", async () => {
    const connections = [
      { provider: "openai", kind: "oauth" },
      { provider: "anthropic", kind: "apikey" },
    ];
    let account = "company";
    const writes: unknown[] = [];
    fetcher = async (path, init) => {
      if (path.endsWith("/account")) {
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        account = body.account === "company" ? "company" : body.provider;
      }
      return Response.json(status(account, connections));
    };
    await open();
    providerButton("ChatGPT / Codex", "Use account");
    await tick();
    assert.equal(appState.me.individualModelAuth, true);
    assert.ok(provider("ChatGPT / Codex").textContent?.includes("In use"));
    assert.equal(doc.querySelector("[role=status]")?.textContent, "New chats will use your ChatGPT / Codex account.");
    const company = [...doc.querySelectorAll<HTMLButtonElement>(".mc-method")].find((b) =>
      b.textContent?.includes("Company access"),
    )!;
    company.click();
    await tick();
    assert.equal(appState.me.individualModelAuth, false);
    assert.equal(writes.length, 2);
    assert.equal(doc.querySelectorAll(".mc-provider.connected").length, 2);
    company.click();
    await tick();
    assert.equal(writes.length, 2);
    close();
  });

  await t.test("the startup gate activates the newly connected provider before allowing chats", async () => {
    let account = "anthropic";
    let connected = false;
    let resolveSave!: (response: Response) => void;
    const connections = () => (connected ? [{ provider: "openai", kind: "apikey" }] : []);
    fetcher = async (path, init) => {
      if (path.endsWith("/status")) return Response.json(status(account, connections()));
      if (path.endsWith("/api-key")) {
        connected = true;
        return Response.json({ ok: true });
      }
      if (path.endsWith("/account")) {
        assert.deepEqual(JSON.parse(String(init?.body)), { account: "personal", provider: "openai" });
        return new Promise((resolve) => {
          resolveSave = resolve;
        });
      }
      return base(path);
    };
    renderModelConnectGate();
    await tick();
    providerButton("ChatGPT / Codex", "Connect");
    providerButton("ChatGPT / Codex", "Use an API key");
    const input = doc.querySelector<HTMLInputElement>("#app input")!;
    input.value = "test-only-key";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    providerButton("ChatGPT / Codex", "Connect");
    await tick();
    const startButton = () =>
      [...doc.querySelectorAll<HTMLButtonElement>("#app button")].find(
        (el) => el.textContent?.trim() === "Start chatting",
      );
    assert.ok(!startButton() || startButton()!.disabled);
    assert.equal(typeof resolveSave, "function");
    account = "openai";
    resolveSave(Response.json(status(account, connections())));
    await tick();
    assert.equal(appState.me.modelAuthConnected, true);
    assert.equal(startButton()?.disabled, false);
    assert.match(provider("ChatGPT / Codex").textContent!, /In use/);
    doc.querySelector("#app")!.replaceChildren();
  });

  await t.test("settings keeps switches and connection settings locked until its account write finishes", async () => {
    const { renderSettings } = await vite.ssrLoadModule("/src/settings.ts");
    const connections = [
      { provider: "anthropic", kind: "oauth" },
      { provider: "openai", kind: "oauth" },
    ];
    let resolveSave!: (response: Response) => void;
    let writes = 0;
    fetcher = async (path) => {
      if (path.endsWith("/account")) {
        writes++;
        return new Promise((resolve) => {
          resolveSave = resolve;
        });
      }
      return Response.json(status("anthropic", connections));
    };
    appState.currentView = "settings";
    appState.mainEl = doc.querySelector("#app");
    renderSettings();
    await tick();
    const choice = (label: string) =>
      [...doc.querySelectorAll<HTMLButtonElement>('[aria-label="AI access"] button')].find(
        (el) => el.textContent?.trim() === label,
      )!;
    const manage = () =>
      [...doc.querySelectorAll<HTMLButtonElement>(".settings-ai-controls button")].find(
        (el) => el.textContent?.trim() === "Connection settings",
      )!;
    choice("ChatGPT / Codex").click();
    assert.equal(writes, 1);
    assert.equal(manage().disabled, true);
    manage().click();
    assert.equal(doc.querySelector(".mc-overlay"), null);
    window.dispatchEvent(new CustomEvent("model-account-changed", { detail: status("anthropic", connections) }));
    assert.equal(choice("Company").disabled, true);
    assert.equal(manage().disabled, true);
    choice("Company").click();
    assert.equal(writes, 1);
    resolveSave(Response.json(status("openai", connections)));
    await tick();
    assert.equal(choice("Company").disabled, false);
    assert.equal(choice("ChatGPT / Codex").getAttribute("aria-pressed"), "true");
    assert.equal(manage().disabled, false);
    appState.currentView = "chats";
    appState.mainEl = null;
  });
});
