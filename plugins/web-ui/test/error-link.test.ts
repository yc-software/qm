import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

test("web quarantine copy canonicalizes a safe review link and rejects delimiter-bearing URLs", async () => {
  const dom = new JSDOM('<!doctype html><main id="host"></main>');
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const [{ render }, { linkifiedText }, { userFacingFailureText }] = await Promise.all([
    import("lit"),
    import("../src/linkified-text.ts"),
    import("../../chassis/src/failure-copy.ts"),
  ]);
  const host = dom.window.document.querySelector<HTMLElement>("#host")!;
  const canonicalUrl = "https://portal.example.com/admin/history/s/session-574";
  const quarantine = {
    status: "refused",
    refusalKind: "security_quarantine",
    reason: "internal screening details",
  };
  const linkedCopy = userFacingFailureText({
    ...quarantine,
    adminUrl: "HTTPS://PORTAL.EXAMPLE.COM/admin/history/s/session-574",
  });
  render(linkifiedText(linkedCopy), host);

  const anchors = host.querySelectorAll<HTMLAnchorElement>("a");
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0]!.href, canonicalUrl);
  assert.equal(anchors[0]!.textContent, canonicalUrl);
  assert.equal(anchors[0]!.target, "_blank");
  assert.equal(anchors[0]!.rel, "noreferrer noopener");
  assert.doesNotMatch(host.textContent ?? "", /internal screening details/);

  for (const adminUrl of [
    "https://portal.example.com/admin/history/s/<session-574>",
    'https://portal.example.com/admin/history/s/"session-574"',
    "https://portal.example.com/admin/history/s/'session-574'",
  ]) {
    const fallbackCopy = userFacingFailureText({ ...quarantine, adminUrl });
    render(linkifiedText(fallbackCopy), host);
    assert.equal(host.querySelectorAll("a").length, 0);
    assert.doesNotMatch(host.textContent ?? "", /admin|review|internal screening details/i);
  }
  dom.window.close();
});

test("both live and settled web error renderers use the safe linkified renderer", () => {
  const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
  assert.equal(chat.match(/composer-error inline">\$\{linkifiedText\(/g)?.length, 2);
});
