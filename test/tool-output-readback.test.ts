import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolContext } from "../src/tools/primitives.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { createMemoryToolOutputStore, parkIfOverCap, type ToolOutputStore } from "../src/sessions/tool-output.ts";
import { storedItem, type Item } from "../src/sessions/items.ts";
import { scopeId } from "../src/types.ts";

function readBack(parked: Awaited<ReturnType<ToolOutputStore["read"]>> | ToolOutputStore) {
  const written: Array<[string, string]> = [];
  const tc = createToolContext({
    sandbox: {
      readFile: async () => null,
      writeFile: async (_h: unknown, path: string, data: string) => void written.push([path, data]),
    } as unknown as Sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }),
    layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    sessionId: "s1",
    toolOutput: (parked && "read" in parked ? parked : { read: async () => parked }) as ToolOutputStore,
  });
  return { tc, written };
}

test("reading a parked tool output copies the full text onto the computer for execute to slice", async () => {
  const full = Array.from({ length: 30_000 }, (_, i) => `row ${i + 1}`).join("\n");
  const { tc, written } = readBack({ text: full });
  const read = await tc.read("tool-output/toolu_1");
  assert.deepEqual(written, [["tool-output/toolu_1", full]]);
  assert.match(String(read.content), /copied the full output \(\d+ chars\) to tool-output\/toolu_1 on the computer/);
  assert.ok(String(read.content).length < 300);
});

test("an expired parked output says so and writes nothing", async () => {
  const { tc, written } = readBack({ expired: true });
  const read = await tc.read("tool-output/toolu_1");
  assert.deepEqual(written, []);
  assert.match(String(read.content), /expired after 30 days/);
});

test("a cut result from a gateway call id with a thought signature reads back from its marker", async () => {
  const callId = `call_1__thought__${"Q+/z".repeat(1_500)}`;
  const items: Item[] = [];
  const store = createMemoryToolOutputStore({ inlineTokens: 10, sessions: { getItems: async () => items } });
  const full = "x".repeat(1_000);
  const parked = (await parkIfOverCap(store, full, callId))!;
  items.push(
    storedItem(
      {
        kind: "ToolResult",
        tool: "execute",
        callId,
        text: parked.text,
        blobSha: parked.output.blob,
        body: { output: { chars: parked.output.chars, shownChars: parked.output.shownChars } },
      },
      { sessionId: "s1", seq: 0, createdAt: 1 },
    ),
  );
  const path = /tool-output\/\S+(?=;)/.exec(parked.text)![0];
  assert.ok(path.length < 64);
  const { tc, written } = readBack(store);
  await tc.read(path);
  assert.deepEqual(written, [[path, full]]);
});
