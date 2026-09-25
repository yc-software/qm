import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://agent.example.com", pretendToBeVisual: true });
for (const key of [
  "window",
  "document",
  "customElements",
  "HTMLElement",
  "Element",
  "Document",
  "CSSStyleSheet",
  "ShadowRoot",
  "location",
] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
await import("../src/slack-setup.ts");
const links = {
  tokenUrl: "https://api.slack.com/apps",
  submitUrl: "https://agent.example.com/admin?slack=setup",
  installUrl: "https://agent.example.com/admin?slack=install",
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test("one checklist updates from token to consent to connected and clears stale success", async (t) => {
  let response = { configured: false, setup: { ...links, appReady: false, connected: false } };
  let fail = false;
  const fetch = t.mock.method(globalThis, "fetch", async (url: unknown) => {
    assert.equal(url, "/admin/api/slack-installation");
    return fail ? new Response("", { status: 503 }) : Response.json(response);
  });
  const card = document.createElement("qm-slack-setup");
  document.body.append(card);
  t.after(() => card.remove());
  await settle();
  assert.equal(card.querySelectorAll("ol li").length, 3);
  assert.equal(card.querySelectorAll("input").length, 0);
  assert.equal(card.querySelectorAll("img").length, 1);
  assert.match(card.textContent!, /Waiting for token submission/);
  response.setup.appReady = true;
  window.dispatchEvent(new dom.window.Event("focus"));
  await settle();
  assert.match(card.textContent!, /Waiting for Slack approval/);
  assert.equal(card.querySelectorAll("ol").length, 1);
  response = { configured: true, setup: { ...links, appReady: true, connected: true } };
  window.dispatchEvent(new dom.window.Event("focus"));
  await settle();
  assert.match(card.textContent!, /Connected to Slack/);
  assert.equal(card.querySelectorAll("ol").length, 0);
  fail = true;
  window.dispatchEvent(new dom.window.Event("focus"));
  await settle();
  assert.doesNotMatch(card.textContent!, /Connected to Slack/);
  assert.match(card.textContent!, /Could not check progress/);
  card.remove();
  const count = fetch.mock.callCount();
  window.dispatchEvent(new dom.window.Event("focus"));
  await settle();
  assert.equal(fetch.mock.callCount(), count);
});

test("non-admins receive no setup controls and unverified configuration is not Connected", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 403 }));
  const card = document.createElement("qm-slack-setup");
  document.body.append(card);
  t.after(() => card.remove());
  await settle();
  assert.match(card.textContent!, /Only a QM administrator/);
  assert.equal(card.querySelectorAll("a").length, 0);
});

test("re-evaluating the setup module preserves its existing custom element registration", async () => {
  const registered = customElements.get("qm-slack-setup");
  assert.ok(registered);
  await import(new URL("../src/slack-setup.ts?registration-reload", import.meta.url).href);
  assert.equal(customElements.get("qm-slack-setup"), registered);
});
