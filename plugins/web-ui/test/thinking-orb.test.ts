import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

const functionBody = (name: string): string =>
  chat.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n {2}\\}`))?.[0] ?? "";

test("the live dock, work heads, and the typing row render the 3D orb ahead of the sheen label", () => {
  for (const name of ["liveWorkDock", "workBlock", "typingRow"]) {
    const body = functionBody(name);
    const orb = body.indexOf("thinkingOrb(");
    const sheen = body.indexOf("sheenLabel(");
    assert.ok(orb >= 0, `${name} renders thinkingOrb`);
    assert.ok(sheen >= 0, `${name} keeps the sheen label text`);
    assert.ok(orb < sheen, `${name} renders the orb before the sheen label`);
  }
});

test("the orb variant is picked from a hash of the mounted thread", () => {
  assert.match(chat, /const orbVariants = \["gyro", "tesseract", "orbit"\] as const;/);
  assert.match(chat, /variant = orbVariantFor\(chatState\.threadRef \?\? ""\)/);
  assert.match(chat, /data-variant=\$\{variant\}/);
});

test("the orb CSS builds three preserve-3d scenes switched by data-variant", () => {
  assert.match(css, /\.think-orb \{[^}]*perspective:[^}]*transform-style: preserve-3d;/);
  assert.match(css, /\.think-orb \.orb-ring \{[^}]*transform-style: preserve-3d;[^}]*will-change: transform;/);
  for (const variant of ["gyro", "tesseract", "orbit"]) {
    assert.match(css, new RegExp(`\\.think-orb\\[data-variant="${variant}"\\]`), `${variant} scene exists`);
  }
});

test("a reduced-motion block stops the orb rings and leaves the core breathing", () => {
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)].map((m) => m[0]);
  const orbBlock = blocks.find((block) => block.includes(".think-orb"));
  assert.ok(orbBlock, "a reduced-motion block covers .think-orb");
  assert.match(orbBlock, /\.think-orb \.orb-ring[^{]*\{\s*animation: none;/);
  assert.ok(!orbBlock.includes(".orb-core"), "the core keeps its 2.4s opacity breathe under reduced motion");
});
