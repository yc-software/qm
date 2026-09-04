import { test } from "node:test";
import assert from "node:assert/strict";
import { applySystemPromptCacheSplit } from "../src/harness/pi-harness.ts";

function makePayload(systemText: string): {
  system: Array<{ type: string; text: string; cache_control?: unknown }>;
  tools: Array<{ name: string; cache_control?: unknown }>;
  messages: Array<{ role: string; content: Array<{ type: string; text: string; cache_control?: unknown }> }>;
} {
  return {
    system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
    tools: [{ name: "execute" }, { name: "read" }, { name: "write", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
  };
}

const SOUL = "You are Agent.\n\n## Your computer\nstuff\n\n## Scheduling\nmore";
const TAIL = "\n\n## Your logins\n- AWS ✓\n\n## What you remember\nLikes terse replies";

function countBreakpoints(p: ReturnType<typeof makePayload>): number {
  let n = 0;
  for (const b of p.system) if (b.cache_control) n++;
  for (const t of p.tools) if (t.cache_control) n++;
  for (const m of p.messages) for (const b of m.content) if (b.cache_control) n++;
  return n;
}

test("splits at the boundary, relocates the breakpoint to the stable block (1h), tail uncached", () => {
  const p = makePayload(SOUL + TAIL);
  applySystemPromptCacheSplit(p, SOUL.length);

  assert.equal(p.system.length, 2, "system is now two blocks");
  assert.equal(p.system[0]!.text, SOUL, "block 0 = the stable SOUL prefix");
  assert.equal(p.system[1]!.text, TAIL, "block 1 = the volatile tail");
  assert.deepEqual(
    p.system[0]!.cache_control,
    { type: "ephemeral", ttl: "1h" },
    "stable block carries the 1h breakpoint",
  );
  assert.equal(
    p.system[1]!.cache_control,
    undefined,
    "tail block carries NO breakpoint (rides the message breakpoint)",
  );
});

test("byte-exact: the concatenated system text is unchanged (only split into two blocks)", () => {
  const full = SOUL + TAIL;
  const p = makePayload(full);
  applySystemPromptCacheSplit(p, SOUL.length);
  assert.equal(p.system.map((b) => b.text).join(""), full, "no bytes added or dropped");
});

test("bumps the tool breakpoint to 1h (ordering: 1h entries must precede the 5m message breakpoint)", () => {
  const p = makePayload(SOUL + TAIL);
  applySystemPromptCacheSplit(p, SOUL.length);
  const cachedTool = p.tools.find((t) => t.cache_control);
  assert.deepEqual(cachedTool!.cache_control, { type: "ephemeral", ttl: "1h" }, "the cached tool is upgraded to 1h");
  assert.deepEqual(
    p.messages[0]!.content[0]!.cache_control,
    { type: "ephemeral" },
    "the last-message breakpoint stays 5m (per-turn churn gains nothing from 1h)",
  );
});

test("stays at 3 cache breakpoints — never exceeds Anthropic's max of 4", () => {
  const p = makePayload(SOUL + TAIL);
  assert.equal(countBreakpoints(p), 3, "baseline: system + last-tool + last-message");
  applySystemPromptCacheSplit(p, SOUL.length);
  assert.equal(countBreakpoints(p), 3, "after split: stable-system + last-tool + last-message");
});

test("no-op when boundary is missing / zero / negative / non-finite", () => {
  for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const p = makePayload(SOUL + TAIL);
    applySystemPromptCacheSplit(p, bad as number | undefined);
    assert.equal(p.system.length, 1, `boundary=${String(bad)} leaves the single block untouched`);
    assert.deepEqual(p.system[0]!.cache_control, { type: "ephemeral" }, "original 5m breakpoint preserved");
  }
});

test("no-op when boundary is at or past the end of the system text", () => {
  const full = SOUL + TAIL;
  for (const b of [full.length, full.length + 100]) {
    const p = makePayload(full);
    applySystemPromptCacheSplit(p, b);
    assert.equal(p.system.length, 1, "nothing volatile to peel off → untouched");
  }
});

test("no-op when a split would produce an empty stable or empty tail segment", () => {
  const p1 = makePayload("   " + TAIL.trimStart());
  applySystemPromptCacheSplit(p1, 2);
  assert.equal(p1.system.length, 1, "blank stable → no split");
});

test("no-op on the OAuth 2-block system shape (leaves both blocks + their breakpoints)", () => {
  const p = {
    system: [
      { type: "text", text: "You are Claude Code...", cache_control: { type: "ephemeral" } },
      { type: "text", text: SOUL + TAIL, cache_control: { type: "ephemeral" } },
    ],
    tools: [{ name: "execute", cache_control: { type: "ephemeral" } }],
  };
  applySystemPromptCacheSplit(p, SOUL.length);
  assert.equal(p.system.length, 2, "2-block shape untouched");
  assert.deepEqual(p.tools[0]!.cache_control, { type: "ephemeral" }, "tool TTL not bumped when system wasn't split");
});

test("no-op when system is a string, missing, or not a text block", () => {
  const asString = { system: SOUL + TAIL } as { system: unknown };
  applySystemPromptCacheSplit(asString, SOUL.length);
  assert.equal(typeof asString.system, "string", "string system left as-is");

  const notText = { system: [{ type: "image", text: 123 }] } as { system: unknown };
  applySystemPromptCacheSplit(notText, 5);
  assert.deepEqual(notText.system, [{ type: "image", text: 123 }], "non-text block left as-is");

  applySystemPromptCacheSplit({}, 5);
  applySystemPromptCacheSplit(null, 5);
});
