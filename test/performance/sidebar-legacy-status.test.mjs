import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { setup, tick } from "./sidebar-test-support.mjs";
import { renderClient } from "./sidebar-test-browser.mjs";

function fixture(kind) {
  const s = setup("legacy-get");
  if (kind !== "populated") {
    s.m.rows = kind === "empty" ? [] : s.m.rows.filter((row) => row.id === "slack");
    const ids = new Set(s.m.rows.map((row) => row.id));
    for (const [actor, key] of [
      [s.m.facts.commonActor, "preparedWeb"],
      [s.m.facts.commonActor, "preparedOffPageWeb"],
      [s.m.facts.dynamicActor, "preparedNonWeb"],
      [s.m.facts.dynamicActor, "allowedOffPageRows"],
    ])
      actor[key] = actor[key].filter((row) => ids.has(row.id));
    s.m.facts.commonActor.startup = {
      hasSessions: s.m.rows.length > 0,
      hasNonCronSessions: s.m.rows.length > 0,
      oldestPersonalThreadRef: s.m.rows[0]?.threadRef ?? null,
    };
  }
  s.send("/me", { user: "actor" });
  s.send("/api/contexts", { contexts: s.m.contexts });
  s.send("/api/sessions", { sessions: s.m.rows });
  return s;
}

test("exact legacy notices refuse stale readiness while both real empty states remain valid", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qm-sidebar-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let browser;
  const receipt = {
    qualified: false,
    kind: "modeled-legacy-status-correction",
    arms: [],
  };
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    receipt.chromium = browser.version();
    receipt.node = process.version;
    for (const kind of ["populated", "empty", "hidden"]) {
      const next = fixture(kind);
      await tick();
      await page.setContent('<div id="sidebar-body"></div>');
      await page.evaluate(
        ({ fn, data, contexts }) => {
          (0, eval)(`(${fn})`)(data, "legacy-get", contexts, "web");
        },
        { fn: renderClient.toString(), data: { sessions: next.m.rows }, contexts: next.m.contexts },
      );
      await page.locator("#sidebar-body").evaluate((element) => {
        for (const name of element.getAttributeNames()) if (name !== "id") element.removeAttribute(name);
      });
      assert.deepEqual(
        await page
          .locator("#sidebar-body")
          .evaluate((element) => [...element.attributes].map((attribute) => attribute.name)),
        ["id"],
      );
      const initial = await page.locator("#sidebar-body").innerHTML();
      let expected = null;
      if (kind !== "populated") expected = kind === "empty" ? "No conversations yet." : "Slack conversations hidden.";
      const cases =
        kind === "populated"
          ? [
              { messages: [], pass: true },
              ...[
                "Loading conversations...",
                "Failed to load conversations.",
                "A different API failure",
                "No conversations yet.",
                "Slack conversations hidden.",
              ].map((text) => ({ messages: [text], pass: false })),
            ]
          : [
              { messages: [expected], pass: true },
              { messages: [], pass: false },
              { messages: [expected, expected], pass: false },
              { messages: [expected, "Loading conversations..."], pass: false },
              { messages: [expected, "Failed to load conversations."], pass: false },
              { messages: [kind === "empty" ? "Slack conversations hidden." : "No conversations yet."], pass: false },
            ];
      for (const item of cases) {
        await page.locator("#sidebar-body").evaluate((element, html) => {
          element.innerHTML = html;
        }, initial);
        await page.evaluate((messages) => {
          for (const text of messages) {
            const element = globalThis.document.createElement("div");
            element.className = "empty";
            element.style.padding = "16px";
            element.textContent = text;
            globalThis.document.querySelector("#sidebar-body").append(element);
          }
        }, item.messages);
        if (item.pass) {
          const proof = await next.observer.waitSidebar(page, { timeoutMs: 300 });
          assert.equal(proof.qualified, false);
          if (kind !== "populated") {
            assert.equal(proof.dom.recent.count, 0);
            assert.ok(proof.dom.groups.count > 0);
          }
        } else await assert.rejects(next.observer.waitSidebar(page, { timeoutMs: 120 }), /did not settle/);
        receipt.arms.push({ kind, messages: item.messages, accepted: item.pass });
      }
      await page.locator("#sidebar-body").evaluate((element, html) => {
        element.innerHTML = html;
      }, initial);
      await page.evaluate((message) => {
        const root = globalThis.document.querySelector("#sidebar-body");
        if (message) {
          const valid = globalThis.document.createElement("div");
          valid.className = "empty";
          valid.textContent = message;
          root.append(valid);
        }
        const hidden = globalThis.document.createElement("div");
        hidden.className = "empty";
        hidden.hidden = true;
        hidden.textContent = "Failed to load conversations.";
        root.append(hidden);
      }, expected);
      await next.observer.waitSidebar(page, { timeoutMs: 300 });
      receipt.arms.push({ kind, hiddenNoticeIgnored: true });
      await next.observer.finish();
    }
  } finally {
    if (browser) await browser.close();
    receipt.cleanup = { browserDisconnected: !browser?.isConnected() };
    assert.equal(receipt.cleanup.browserDisconnected, true);
    await writeFile(join(directory, "legacy-status.json"), JSON.stringify(receipt, null, 2) + "\n");
  }
});
