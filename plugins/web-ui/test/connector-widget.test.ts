import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("the connector card's state pill and action follow the connection state", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/" });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    EventSource: undefined,
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { connectorCard } = await vite.ssrLoadModule("/src/chat.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const link = { provider: "google", url: "https://agent.example.com/connect/redeem/abc?p=google" };
    const href = `${link.url}&returnTo=%2Fchats%2Fs1`;
    const host = document.querySelector<HTMLElement>("#app")!;

    render(connectorCard(link, false, href), host);
    assert.equal(host.querySelector(".connector-widget-state")?.textContent?.trim(), "Needs setup");
    assert.equal(host.querySelector(".connector-widget-chip")?.textContent?.trim(), "Google Workspace");
    assert.ok(host.querySelector(".connector-widget-chip svg"), "the chip carries the connector's logo");
    const connect = host.querySelector<HTMLAnchorElement>("a.connector-widget-btn.primary")!;
    assert.equal(connect.textContent?.trim(), "Connect");
    assert.equal(connect.getAttribute("href"), href);
    assert.equal(connect.target, "_blank");
    assert.equal(connect.rel, "noreferrer");

    render(connectorCard(link, true, href), host);
    assert.equal(host.querySelector(".connector-widget-state")?.textContent?.trim(), "Connected");
    assert.ok(host.querySelector('.connector-widget.connected[role="status"]'));
    assert.equal(host.querySelector(".connector-widget-btn"), null, "a connected service offers nothing to do");
  } finally {
    await vite.close();
  }
});
