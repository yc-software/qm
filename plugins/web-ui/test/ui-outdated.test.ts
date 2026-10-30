import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { webFetch } from "../src/core-bridge.ts";
import { UI_OUTDATED_EVENT, UI_PROTOCOL } from "../../chassis/src/ui-release.ts";

const realFetch = globalThis.fetch;
const realWindow = globalThis.window;
const realEvent = globalThis.Event;

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: realWindow });
  Object.defineProperty(globalThis, "Event", { configurable: true, writable: true, value: realEvent });
});

function installWindow(): EventTarget {
  const dom = new JSDOM("", { url: "https://qm.example.com/" });
  const target = new dom.window.EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: target });
  Object.defineProperty(globalThis, "Event", { configurable: true, writable: true, value: dom.window.Event });
  return target;
}

test("every web request names the UI protocol, and a ui_outdated refusal raises the reload prompt", async () => {
  const target = installWindow();
  let outdated = 0;
  target.addEventListener(UI_OUTDATED_EVENT, () => outdated++);
  const sent: (string | null)[] = [];
  globalThis.fetch = async (_input, init) => {
    sent.push(new Headers(init?.headers).get("x-qm-ui-version"));
    return sent.length === 1
      ? Response.json({ ok: true })
      : Response.json(
          { error: "ui_outdated", message: "This page is out of date. Reload to continue." },
          { status: 409 },
        );
  };
  assert.equal((await webFetch("/api/runtime-config", { headers: { accept: "application/json" } })).status, 200);
  assert.equal(outdated, 0);
  assert.equal((await webFetch("/api/turn", { method: "POST" })).status, 409);
  assert.equal(outdated, 1);
  assert.deepEqual(sent, [String(UI_PROTOCOL), String(UI_PROTOCOL)]);
});

test("a 409 for any other reason does not raise the reload prompt", async () => {
  const target = installWindow();
  let outdated = 0;
  target.addEventListener(UI_OUTDATED_EVENT, () => outdated++);
  globalThis.fetch = async () => Response.json({ error: "conflict" }, { status: 409 });
  await webFetch("/api/crons/1");
  assert.equal(outdated, 0);
});
