import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { sharedContextLabel } from "../src/core-bridge.ts";

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

test("unnamed shared contexts use the page locale", () => {
  let restore = setPageLocale("en");
  try {
    assert.equal(sharedContextLabel("channel:C1", null), "Shared channel");
    assert.equal(sharedContextLabel("group:G1", null), "Group");
  } finally {
    restore();
  }
  restore = setPageLocale("ja");
  try {
    assert.equal(sharedContextLabel("channel:C1", null), "共有チャンネル");
    assert.equal(sharedContextLabel("group:G1", null), "グループ");
  } finally {
    restore();
  }
});

test("named shared contexts preserve their source names in every locale", () => {
  for (const selected of ["en", "ja"] as const) {
    const restore = setPageLocale(selected);
    try {
      assert.equal(sharedContextLabel("channel:C1", "sales-日本"), "#sales-日本");
      assert.equal(sharedContextLabel("group:G1", "alice, ボブ"), "alice, ボブ");
    } finally {
      restore();
    }
  }
});
