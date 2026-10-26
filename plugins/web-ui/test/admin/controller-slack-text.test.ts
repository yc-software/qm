import assert from "node:assert/strict";
import test from "node:test";
import { mountAdmin } from "./fixture.ts";

async function render(text: string) {
  const admin = await mountAdmin("/settings/slack?container=C1", {
    "/scopes": { scopes: [], environments: [] },
    "/slack-mirror": { containers: [{ container: "C1", name: "eng", kind: "channel", members: [] }] },
    "/slack-mirror/messages": {
      messages: [
        {
          container: "C1",
          ts: "1.0",
          authorName: "Sam",
          createdAt: "2026-10-01T12:00:00Z",
          text,
          mentions: { UEXAMPLE: "Alex" },
        },
      ],
    },
  });
  await admin.settle(10);
  const body = admin.document.querySelector<HTMLElement>(".sm-text");
  assert.ok(body, "the message renders");
  const result = body!.cloneNode(true) as HTMLElement;
  admin.close();
  return result;
}

const all = (root: HTMLElement, selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
const content = (root: HTMLElement) => root.textContent!.trim();

test("Slack messages format quotes, safe links and mentions without dropping prose", async () => {
  const result = await render(
    "Before\n> First quoted line\n&gt; Second quoted line\nAfter <@UEXAMPLE> :wave:\nhttps://example.com/report.",
  );
  const quotes = all(result, "blockquote");
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0]!.textContent, "First quoted line\nSecond quoted line");
  assert.match(content(result), /^Before/);
  assert.match(content(result), /After @Alex 👋\nhttps:\/\/example.com\/report\.$/);
  const [link] = all(result, "a") as HTMLAnchorElement[];
  assert.equal(link!.href, "https://example.com/report");
  assert.equal(link!.target, "_blank");
  assert.equal(link!.rel, "noopener");
});

test("Slack shortcodes in mirrored messages render as the emoji Slack shows", async () => {
  assert.equal(
    content(
      await render(":white_check_mark: :large_green_circle: :flag-us: :sweat-smile: :+1: :calendar: :not_an_emoji:"),
    ),
    "✅ 🟢 🇺🇸 😅 👍 📆 :not_an_emoji:",
  );
});

test("Slack message content cannot create executable elements or unsafe links", async () => {
  const result = await render(
    "<javascript:alert(1)|unsafe> <img src=x onerror=alert(1)> &lt;script&gt;\n```\n> quoted code https://example.com\n```\n`https://example.com/inline`",
  );
  assert.equal(all(result, "a").length, 0);
  assert.equal(all(result, "script").length, 0);
  assert.equal(all(result, "img").length, 0);
  assert.equal(all(result, "blockquote").length, 0);
  assert.equal(all(result, "pre")[0]!.textContent, "> quoted code https://example.com");
  assert.equal(all(result, "code").at(-1)!.textContent, "https://example.com/inline");
  assert.match(content(result), /unsafe/);
});

test("Slack links exclude surrounding punctuation and keep parentheses inside a URL", async () => {
  const result = await render("See (https://example.com/report). Also https://example.com/wiki/Example_(topic).");
  assert.deepEqual(
    (all(result, "a") as HTMLAnchorElement[]).map((a) => a.href),
    ["https://example.com/report", "https://example.com/wiki/Example_(topic)"],
  );
  assert.equal(content(result), "See (https://example.com/report). Also https://example.com/wiki/Example_(topic).");
});

test("Slack inline markup keeps emphasis, named links and prose", async () => {
  const result = await render("Before *bold* _italic_ ~removed~ <https://example.com|Named link> after");
  assert.equal(all(result, "strong")[0]!.textContent, "bold");
  assert.equal(all(result, "em")[0]!.textContent, "italic");
  assert.equal(all(result, "s")[0]!.textContent, "removed");
  assert.equal(all(result, "a")[0]!.textContent, "Named link");
  assert.equal(content(result), "Before bold italic removed Named link after");
});
