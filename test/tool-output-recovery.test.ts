import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import { createToolContext } from "../src/tools/primitives.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { collectBytes } from "../src/util/bytes.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

const owner = scopeId("personal", "tester");

function fixture(stdout: string, screenToolResult?: ToolContextRef["screenToolResult"]) {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const emitted: Record<string, unknown>[] = [];
  const context = createToolContext({
    sandbox: { run: async () => ({ stdout, stderr: "", code: 0, timedOut: false }) } as unknown as Sandbox,
    provision: async () => ({ id: "sandbox", rootDir: "/workspace" }),
    layers: [{ scopeId: owner, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => true,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    files,
    createdBy: "tester",
    runId: "output-recovery",
    commandCredentials: [{ handle: "sample", env: [{ key: "SECRET_TOKEN", value: "example-secret", secret: true }] }],
  });
  const execute = createAgentTools({
    current: context,
    scopeLabel: owner,
    screenToolResult,
    emit: (entry) => {
      if (entry.type === "tool_result") emitted.push(entry.payload as Record<string, unknown>);
    },
  }).find((tool) => tool.name === "execute")!;
  return {
    files,
    context,
    emitted,
    run: async () => {
      const invoke = execute.execute as unknown as (
        id: string,
        params: unknown,
      ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
      const result = await invoke("output-call", {
        command: "generate-output",
        purpose: "Check captured output",
        credentials: ["sample"],
      });
      return result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    },
  };
}

test("a result exactly at the preview cap is complete without a stored copy", async () => {
  const f = fixture("a".repeat(99_991));
  const seen = await f.run();
  assert.equal(seen.length, 100_000);
  assert.doesNotMatch(seen, /truncated/);
  assert.equal((await f.files.listOwnedByScopes([owner])).files.length, 0);
});

test("an oversized result has a bounded Unicode-safe preview and a byte-exact retrievable masked copy", async () => {
  const stdout = "😀".repeat(50_013) + "example-secret終";
  const f = fixture(stdout);
  const seen = await f.run();
  assert.ok(seen.length <= 100_000);
  assert.match(seen, /truncated/);
  assert.doesNotMatch(seen, /\uFFFD|example-secret/);
  assert.equal(Buffer.from(seen, "utf8").toString("utf8"), seen, "preview has no orphaned UTF-16 surrogates");
  assert.ok(seen.endsWith("終\n[exit 0]"));
  const saved = f.emitted[0]!.fullResult as { fileId: string; sizeBytes: number };
  assert.ok(saved?.fileId, "the replay and caller must retain a recovery reference");
  assert.match(seen, new RegExp(`/v1/files/${saved.fileId}/content`));
  const opened = await f.files.open(saved.fileId);
  assert.equal(opened?.artifact.ownerScopeId, owner);
  const data = await collectBytes(opened!.stream);
  const expected = stdout.replace("example-secret", "<redacted:credential>") + "\n[exit 0]";
  assert.equal(data.data.toString("utf8"), expected);
  assert.equal(saved.sizeBytes, Buffer.byteLength(expected));
  assert.match(seen, new RegExp(`${saved.sizeBytes} UTF-8 bytes`));
  assert.equal(f.emitted[0]!.result, seen);
  assert.equal(f.emitted[0]!.isError, false);
});

test("quarantining an oversized result does not publish its full output", async () => {
  const f = fixture("untrusted".repeat(15_000), async () => ({ outcome: "quarantine" }));
  assert.match(await f.run(), /quarantined/);
  assert.equal((await f.files.listOwnedByScopes([owner])).files.length, 0);
  assert.equal(f.emitted[0]!.fullResult, undefined);
});

test("storage failure reports missing recovery without changing the command result", async (t) => {
  const f = fixture("x".repeat(100_050));
  t.mock.method(f.files, "put", async () => {
    throw new Error("storage unavailable");
  });
  const seen = await f.run();
  assert.match(seen, /storage failed; no retrieval reference/);
  assert.match(seen, /100059 UTF-8 bytes/);
  assert.ok(seen.endsWith("[exit 0]"));
  assert.equal(f.emitted[0]!.outputStorageError, "storage unavailable");
  assert.equal(f.emitted[0]!.isError, false);
  assert.equal(f.emitted[0]!.fullResult, undefined);
});

test("unscreened output retains its warning in the saved copy and bounded preview", async () => {
  const f = fixture("x".repeat(100_050), async () => ({ outcome: "unscreened" }));
  const seen = await f.run();
  assert.ok(seen.length <= 100_000);
  assert.match(seen, /^\[NOT security-screened/);
  const saved = f.emitted[0]!.fullResult as { fileId: string; sizeBytes: number };
  const opened = await f.files.open(saved.fileId);
  const { data } = await collectBytes(opened!.stream);
  const warning = seen.slice(0, seen.indexOf("\n") + 1);
  assert.equal(data.toString("utf8"), warning + "x".repeat(100_050) + "\n[exit 0]");
  assert.equal(saved.sizeBytes, data.length);
});

test("file reads preserve same-scope output without re-owning a foreign result", async () => {
  const f = fixture("");
  const foreign = scopeId("personal", "other");
  const text = "shared source".repeat(10_000);
  f.context.read = async () => ({ content: text, sourceScopeId: foreign });
  const read = createAgentTools({ current: f.context, scopeLabel: owner }).find((tool) => tool.name === "files")!;
  const invoke = read.execute as unknown as (
    id: string,
    params: unknown,
  ) => Promise<{ content: Array<{ text?: string }> }>;
  const result = await invoke("foreign-read", { action: "read", path: "shared/note.txt" });
  assert.match(result.content[0]!.text!, /shared source/);
  assert.match(result.content[0]!.text!, /full captured result was not stored/);
  assert.match(result.content[0]!.text!, new RegExp(`${Buffer.byteLength(text)} UTF-8 bytes`));
  assert.equal((await f.files.listOwnedByScopes([owner])).files.length, 0);
  f.context.read = async () => ({ content: text, sourceScopeId: owner });
  const local = await invoke("local-read", { action: "read", path: "note.txt" });
  const saved = (await f.files.listOwnedByScopes([owner])).files;
  assert.equal(saved.length, 1);
  assert.match(local.content[0]!.text!, new RegExp(saved[0]!.id));
});

test("reused call ids cannot return a saved file containing different output", async () => {
  const f = fixture("");
  const first = await f.context.storeToolResult!("reused", "first");
  const second = await f.context.storeToolResult!("reused", "second");
  assert.notEqual(first!.fileId, second!.fileId);
  const opened = await f.files.open(second!.fileId);
  assert.equal((await collectBytes(opened!.stream)).data.toString(), "second");
  assert.equal((await f.context.storeToolResult!("reused", "second"))!.fileId, second!.fileId);
});
