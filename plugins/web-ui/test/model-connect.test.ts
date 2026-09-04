import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for model connection UI");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Grok device sign-in renders, caches its prompt, and handles polling status changes", async () => {
  const dom = new JSDOM('<!doctype html><meta name="brand-self-label" content="qm"><div id="app"></div>', {
    url: "http://localhost/",
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    customElements: dom.window.customElements,
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const starts: string[] = [];
  const polls: Array<Record<string, unknown>> = [];
  let firstPoll = true;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith("/api/user-model-auth/status"))
      return Response.json({ individualModelAuth: true, connections: [] });
    if (path.endsWith("/api/user-model-auth/grok/start")) {
      const id = starts.length === 0 ? "device-cached" : "device-expired";
      starts.push(id);
      return Response.json({
        deviceAuthId: id,
        userCode: id === "device-cached" ? "GROK-1234" : "GROK-5678",
        verificationUrl: "https://accounts.x.ai/oauth2/device",
        intervalMs: id === "device-cached" ? 100 : 1,
        expiresAt: Date.now() + 60_000,
      });
    }
    if (path.endsWith("/api/user-model-auth/grok/poll")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      polls.push(body);
      if (body.deviceAuthId === "device-expired") return Response.json({ status: "expired" });
      if (firstPoll) {
        firstPoll = false;
        return Response.json({ status: "slow_down", intervalMs: 1 });
      }
      return Response.json({ status: "denied" });
    }
    throw new Error(`unexpected request: ${path}`);
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { renderModelConnectGate } = await vite.ssrLoadModule("/src/model-connect.ts");
    renderModelConnectGate();
    await waitFor(() => document.querySelectorAll(".mc-provider").length === 3);
    const provider = (name: string) =>
      [...document.querySelectorAll<HTMLElement>(".mc-provider")].find(
        (row) => row.querySelector("strong")?.textContent === name,
      )!;
    const click = (target: Element) => target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const button = (row: HTMLElement, label: string) =>
      [...row.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().startsWith(label))!;

    click(button(provider("Grok"), "Connect"));
    assert.match(document.body.textContent ?? "", /Grok account with Build access/);
    click(button(provider("Grok"), "Sign in with Grok"));
    await waitFor(() => (document.body.textContent ?? "").includes("GROK-1234"));
    click(button(provider("ChatGPT"), "Connect"));
    click(button(provider("Grok"), "Connect"));
    click(button(provider("Grok"), "Sign in with Grok"));
    assert.deepEqual(starts, ["device-cached"]);
    await waitFor(() => (document.querySelector(".mc-error")?.textContent ?? "").includes("denied"));
    assert.deepEqual(polls.slice(0, 2), [{ deviceAuthId: "device-cached" }, { deviceAuthId: "device-cached" }]);

    click(button(provider("Grok"), "Sign in with Grok"));
    await waitFor(() => (document.querySelector(".mc-error")?.textContent ?? "").includes("expired"));
    assert.deepEqual(starts, ["device-cached", "device-expired"]);
    assert.deepEqual(polls.at(-1), { deviceAuthId: "device-expired" });
  } finally {
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
