import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { brandName, copyText } from "../src/ui.ts";

test("brand name defaults to QM", () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: new JSDOM("").window.document,
  });
  try {
    assert.equal(brandName(), "QM");
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete (globalThis as { document?: Document }).document;
  }
});

test("brand name follows the server-injected deployment label", () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: new JSDOM('<meta name="brand-self-label" content="qm">').window.document,
  });
  try {
    assert.equal(brandName(), "qm");
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete (globalThis as { document?: Document }).document;
  }
});

test("rapid copy feedback toggles a class and never rewrites the button markup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => {} } },
  });
  try {
    const button = new JSDOM(
      '<button><svg data-icon="copy"></svg><span>Copy URL</span></button>',
    ).window.document.querySelector("button") as HTMLButtonElement;
    const original = button.innerHTML;
    await copyText("first", button);
    await copyText("second", button);
    assert.ok(button.classList.contains("copied"));
    assert.equal(button.innerHTML, original);
    t.mock.timers.tick(1199);
    assert.ok(button.classList.contains("copied"), "the second copy restarts the feedback window");
    t.mock.timers.tick(1);
    assert.ok(!button.classList.contains("copied"));
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete (globalThis as { navigator?: Navigator }).navigator;
  }
});
