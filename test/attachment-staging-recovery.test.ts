import { readOutgoingFiles } from "../src/surfaces/attachments.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttachStaging, restoreAttachmentState } from "../src/core/orchestrator/attach-tool.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

for (const missing of [false, true])
  test(`staging recovery follows the highest revision and refuses missing selections=${missing}`, async () => {
    const databaseUrl = testDatabaseUrl();
    const files = createPostgresFileArtifactStore(databaseUrl, createMemoryDurableByteStore());
    const sessions = createPostgresSessionStore(databaseUrl);
    const transfer = createMemoryBlobTransferStore();
    const session = await sessions.getOrCreateByThread("web:owner:attachments", "dm", "personal:owner");
    const writer = { sessionId: session.id, turnId: "11111111-1111-4111-8111-111111111111" };
    for (const id of ["first", "second"])
      await files.put({
        id,
        ownerScopeId: "personal:owner",
        createdBy: "owner",
        name: id + ".txt",
        path: id + ".txt",
        mimetype: "text/plain",
        data: Buffer.from(id),
        direction: "out",
      });
    const openStored = async (id: string) => {
      const file = await files.open(id);
      return file ? { ...file.artifact, stream: file.stream } : null;
    };
    const context = {
      sandbox: undefined as never,
      provision: async (): Promise<never> => {
        throw new Error("no computer needed");
      },
      blobTransfer: transfer,
      fileRegistration: { store: files, ownerScopeId: "personal:owner", createdBy: "owner", seed: "attachments" },
      openStored,
    };
    const staging = createAttachStaging(context);
    const first = await staging.attach([{ file_id: "first" }]);
    const second = await staging.attach([{ file_id: "second" }]);
    assert.ok(first.ok && second.ok);
    for (const callId of ["one", "two"]) await sessions.append(writer, { kind: "ToolCall", tool: "attach", callId });
    for (const [callId, result] of [
      ["two", second],
      ["one", first],
    ] as const)
      await sessions.append(writer, {
        kind: "ToolResult",
        tool: "attach",
        callId,
        body: { ok: true, files: result.files, stagedFiles: result.stagedFiles, stagedRevision: result.stagedRevision },
      });
    await sessions.append(writer, { kind: "AgentMessage", variant: "files_delivered", body: { files: first.files } });
    if (missing) await files.delete("second");
    const recover = () => restoreAttachmentState(awaitedHistory, writer.turnId, transfer, openStored, "owner");
    const awaitedHistory = await sessions.getItems(session.id);
    if (missing) {
      await assert.rejects(recover, /no longer available/);
      return;
    }
    const initial = await recover();
    assert.deepEqual(
      initial.entries.map((entry) => entry.attachment.artifactId),
      ["first", "second"],
    );
    const delivered = await readOutgoingFiles(
      initial.entries.map((entry) => entry.attachment),
      {
        readBlob: async () => {
          throw new Error("temporary download expired");
        },
        readFileArtifact: async (id, viewer) => {
          const file = await files.open(id);
          if (!file || file.artifact.ownerScopeId !== `personal:${viewer}`) throw new Error("not authorized");
          const chunks: Buffer[] = [];
          for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
          return Buffer.concat(chunks);
        },
      },
    );
    assert.deepEqual(
      delivered.map((file) => file.file.toString()),
      ["first", "second"],
    );
    const resumed = createAttachStaging({ ...context, initial });
    const next = await resumed.attach([{ file_id: "first" }]);
    assert.ok(next.ok);
    assert.ok(next.stagedRevision > second.stagedRevision);
    assert.deepEqual(
      resumed.staged().map((file) => file.artifactId),
      ["first", "second"],
    );
    assert.ok(await files.get("first"));
  });

test("a failed replacement result cannot delete the previous durable selection", async (t) => {
  const databaseUrl = testDatabaseUrl();
  const files = createPostgresFileArtifactStore(databaseUrl, createMemoryDurableByteStore());
  const sessions = createPostgresSessionStore(databaseUrl);
  const transfer = createMemoryBlobTransferStore();
  const session = await sessions.getOrCreateByThread("web:owner:replacement", "dm", "personal:owner");
  const writer = { sessionId: session.id, turnId: "22222222-2222-4222-8222-222222222222" };
  let version = 0;
  const openStored = async (id: string) => {
    const file = await files.open(id);
    return file ? { ...file.artifact, stream: file.stream } : null;
  };
  const staging = createAttachStaging({
    sandbox: { readFileBytes: async () => Buffer.from(`version-${++version}`) } as never,
    provision: async () => ({ id: "computer", rootDir: "/workspace" }),
    blobTransfer: transfer,
    fileRegistration: { store: files, ownerScopeId: "personal:owner", createdBy: "owner", seed: "replacement" },
    openStored,
  });
  await sessions.append(writer, { kind: "ToolCall", tool: "attach", callId: "first", body: { files: ["report.txt"] } });
  const first = await staging.attach(["report.txt"]);
  assert.ok(first.ok);
  await sessions.append(writer, {
    kind: "ToolResult",
    tool: "attach",
    callId: "first",
    body: { ok: true, files: first.files, stagedFiles: first.stagedFiles, stagedRevision: first.stagedRevision },
  });
  await sessions.append(writer, {
    kind: "ToolCall",
    tool: "attach",
    callId: "second",
    body: { files: ["report.txt"] },
  });
  const second = await staging.attach(["report.txt"]);
  assert.ok(second.ok);
  const append = sessions.append.bind(sessions);
  t.mock.method(
    sessions,
    "append",
    async (targetWriter: Parameters<typeof sessions.append>[0], item: Parameters<typeof sessions.append>[1]) => {
      if (item.callId === "second" && item.kind === "ToolResult") throw new Error("result persistence unavailable");
      return append(targetWriter, item);
    },
  );
  await assert.rejects(
    sessions.append(writer, {
      kind: "ToolResult",
      tool: "attach",
      callId: "second",
      body: { ok: true, files: second.files, stagedFiles: second.stagedFiles, stagedRevision: second.stagedRevision },
    }),
    /result persistence unavailable/,
  );
  const restored = await restoreAttachmentState(
    await sessions.getItems(session.id),
    writer.turnId,
    transfer,
    openStored,
    "owner",
  );
  assert.deepEqual(
    restored.entries.map((entry) => entry.attachment.artifactId),
    [first.files[0]!.artifactId],
  );
  assert.equal(restored.entries[0]!.attachment.artifactViewerId, "owner");
});
