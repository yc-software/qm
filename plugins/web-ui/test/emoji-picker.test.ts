import assert from "node:assert/strict";
import { test } from "node:test";
import { charForName, EMOJI_ROWS, filterEmoji } from "../src/emoji-picker.ts";
import { createServer } from "vite";

test("Slack shortcodes resolve to the emoji users see in Slack", () => {
  const expected: Record<string, string> = {
    "+1": "👍",
    thumbsup: "👍",
    "-1": "👎",
    eyes: "👀",
    white_check_mark: "✅",
    heavy_check_mark: "✔️",
    x: "❌",
    warning: "⚠️",
    heart: "❤️",
    tada: "🎉",
    fire: "🔥",
    rocket: "🚀",
    joy: "😂",
    sweat_smile: "😅",
    "sweat-smile": "😅",
    pray: "🙏",
    raised_hands: "🙌",
    clap: "👏",
    hourglass_flowing_sand: "⏳",
    thinking_face: "🤔",
    "100": "💯",
    us: "🇺🇸",
    "flag-us": "🇺🇸",
    "flag-england": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
    calendar: "📆",
    email: "✉️",
  };
  for (const [name, char] of Object.entries(expected)) assert.equal(charForName(name), char, `:${name}:`);
  assert.equal(charForName("not_an_emoji"), null);
  assert.equal(charForName("skin-tone-2"), null);
});

test("search matches names and aliases in Slack's order, ignoring colons", () => {
  const smile = filterEmoji(EMOJI_ROWS, "smile").map((r) => r.n);
  assert.deepEqual(smile.slice(0, 3), ["smiley", "smile", "sweat_smile"]);
  assert.deepEqual(
    filterEmoji(EMOJI_ROWS, ":smile:").map((r) => r.n),
    smile,
  );
  assert.ok(filterEmoji(EMOJI_ROWS, "thumbsup").some((r) => r.c === "👍"));
  assert.equal(filterEmoji(EMOJI_ROWS, "zzzznotanemoji").length, 0);
});

test("the web bundle's prebuilt emoji table resolves every shortcode exactly as the full dataset does", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const bundled = await server.ssrLoadModule("/src/emoji-picker.ts");
    const table = await server.transformRequest("/src/emoji-table.ts", { ssr: true });
    assert.ok(!table!.code.includes("emoji-datasource"));
    assert.deepEqual(bundled.EMOJI_ROWS, EMOJI_ROWS);
    for (const row of EMOJI_ROWS) for (const name of [row.n, ...row.a]) assert.equal(bundled.charForName(name), row.c);
  } finally {
    await server.close();
  }
});
