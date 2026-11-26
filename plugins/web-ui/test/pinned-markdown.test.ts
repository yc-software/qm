import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION, settle } from "./deep-link-boot-fixture.ts";

test("session pins render markdown in peek, text, and preview", async () => {
  const pins = [
    {
      id: "pin-1",
      text: "[PR #42](https://example.com/pr/42) — **Ready** `code`",
      preview: "See [spec](https://example.com/spec) https://example.com/raw",
      addedBy: "tester",
      createdAt: 1,
    },
  ];
  const h = await harness({
    path: `/s/${SESSION.id}`,
    listSessions: [SESSION],
    api: (p) =>
      p.startsWith(`/api/sessions/${SESSION.id}?`) ? Response.json({ session: SESSION, items: [], pins }) : undefined,
  });
  try {
    h.releaseSessions();
    await h.boot();
    await settle(() => !!document.querySelector(".pinned-strip-peek a"));
    assert.equal(document.querySelector(".pinned-strip-peek a")?.getAttribute("href"), "https://example.com/pr/42");
    assert.equal(document.querySelector(".pinned-strip-peek strong")?.textContent, "Ready");
    assert.equal(document.querySelector(".pinned-strip-peek code")?.textContent, "code");
    document.querySelector<HTMLElement>(".pinned-strip-head")!.click();
    await settle(() => !!document.querySelector(".pinned-item-preview a"));
    assert.equal(document.querySelector(".pinned-item-text a")?.textContent, "PR #42");
    assert.deepEqual(
      [...document.querySelectorAll(".pinned-item-preview a")].map((a) => [a.textContent, a.getAttribute("href")]),
      [
        ["spec", "https://example.com/spec"],
        ["https://example.com/raw", "https://example.com/raw"],
      ],
    );
  } finally {
    await h.close();
  }
});
