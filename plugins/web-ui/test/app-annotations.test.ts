import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

test("embedded chat takes annotations only from its own app shell and acks once", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://portal.example.com/app-edit?slug=demo&embed=1",
  });
  const g = globalThis as Record<string, unknown>;
  const prev = { window: g.window, File: g.File };
  g.window = dom.window;
  g.File = dom.window.File;
  try {
    const { watchAppAnnotations } = await import("../src/app-annotations.ts");
    const acks: unknown[] = [];
    const parent = { postMessage: (msg: unknown, origin: string) => acks.push([msg, origin]) };
    Object.defineProperty(dom.window, "parent", { value: parent });
    const added: [string, number][] = [];
    const stop = watchAppAnnotations("demo", (text, files) => (added.push([text, files.length]), true));
    const png = new dom.window.File(["x"], "a.png", { type: "image/png" });
    const send = (origin: string, source: unknown, id = "1") =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          origin,
          source: source as Window,
          data: { type: "qm:annotations", id, text: "fix the button", files: [png, "nope"] },
        }),
      );
    send("https://evil.apps.example.com", parent);
    send("https://demo.apps.example.com", dom.window);
    assert.deepEqual(added, []);
    send("https://demo.apps.example.com", parent);
    send("https://demo.apps.example.com", parent);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(added, [["fix the button", 1]]);
    assert.equal(acks.length, 2);
    assert.deepEqual(acks[0], [{ type: "qm:annotations-ack", id: "1" }, "https://demo.apps.example.com"]);
    stop();
  } finally {
    g.window = prev.window;
    g.File = prev.File;
  }
});
