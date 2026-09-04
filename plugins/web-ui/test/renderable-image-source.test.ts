import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync(new URL("../src/ui.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("SVG attachments fall back to a visible download chip", () => {
  const renderableTypes = ui.match(/const RENDERABLE_IMAGE_TYPES = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  assert.doesNotMatch(renderableTypes, /image\/svg\+xml/);
  assert.match(chat, /if \(!browserRenderableImage\(file\.mimetype\)\) return imageChip/);
});
