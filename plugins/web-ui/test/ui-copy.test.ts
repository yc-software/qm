import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { brandName, copyText, formatBytes, relTime } from "../src/ui.ts";

function setPageLocale(selected: "en" | "ja"): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: new JSDOM(`<meta name="qm-locale" content="${selected}">`).window.document,
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else delete (globalThis as { document?: Document }).document;
  };
}

test("relative time uses the page locale and keeps the just-now boundary", () => {
  const now = 2_000_000;
  let restore = setPageLocale("en");
  try {
    assert.equal(relTime(now - 120_000, now), "2 minutes ago");
    assert.equal(relTime(now - 59_000, now), "just now");
  } finally {
    restore();
  }
  restore = setPageLocale("ja");
  try {
    assert.equal(relTime(now - 120_000, now), "2分前");
    assert.equal(relTime(now - 59_000, now), "たった今");
  } finally {
    restore();
  }
});

test("file sizes format the numeric portion with Intl while retaining binary units", () => {
  const restore = setPageLocale("en");
  try {
    assert.equal(formatBytes(1023), "1,023 B");
    assert.equal(formatBytes(1536), "2 KB");
    assert.equal(formatBytes(1.25 * 1024 * 1024), "1.3 MB");
  } finally {
    restore();
  }
});

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

test("rapid copy feedback restores the original button markup once", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const restoreLocale = setPageLocale("en");
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
    assert.equal(button.textContent, "Copied");
    await new Promise((resolve) => setTimeout(resolve, 1250));
    assert.equal(button.innerHTML, original);
  } finally {
    restoreLocale();
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete (globalThis as { navigator?: Navigator }).navigator;
  }
});
