import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROTOCOLS = join(import.meta.dirname, "..", "src", "resolution", "protocols");
const FRAME_FILES = ["shared-core.md", "mode-conversation.md", "mode-autonomous.md", "mode-fallback.md"];

const toolSource = readFileSync(join(import.meta.dirname, "..", "src", "harness", "pi-tools.ts"), "utf8");

const KNOWN_ACTIONS = new Set(["post", "react", "edit", "delete", "read_thread", "search", "whats_new"]);

function registeredToolNames(): Set<string> {
  const names = new Set<string>(KNOWN_ACTIONS);
  for (const m of toolSource.matchAll(/name:\s*"([a-z_]+)"/g)) names.add(m[1]!);
  names.add("slack");
  return names;
}

test("every tool/action the mode frames name in prose is a real registered tool or surface action", () => {
  const registered = registeredToolNames();
  const offenders: string[] = [];
  for (const file of FRAME_FILES) {
    const text = readFileSync(join(PROTOCOLS, file), "utf8");
    for (const m of text.matchAll(/`([a-z_]+)`\s+(?:tool|action)/g)) {
      const name = m[1]!;
      if (!registered.has(name)) offenders.push(`${file}: names \`${name}\` as a tool/action, which is not registered`);
    }
  }
  assert.deepEqual(offenders, [], `prompt frames name tools/actions that don't exist:\n${offenders.join("\n")}`);
});
