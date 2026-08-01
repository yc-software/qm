import { test } from "node:test";
import assert from "node:assert/strict";
import { collectNamedOutbound, collectOutbound, type ArtifactRegistration } from "../src/core/attachments.ts";
import { createSurfaceToolDeps, type SurfaceToolsContext } from "../src/core/orchestrator/surface-tools.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { scopeId } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { createMemoryChannelPolicyStore } from "../src/surface-cache/channel-policy-store.ts";

function fakeSandbox(files: Record<string, Uint8Array>, outboxListing: string[]): Sandbox {
  return {
    async readFileBytes(_handle: SandboxHandle, p: string) {
      return files[p] ?? null;
    },
    async listDir(_handle: SandboxHandle, _dir: string) {
      return outboxListing;
    },
  } as unknown as Sandbox;
}

const handle = { rootDir: "/root/workspace" } as SandboxHandle;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

test("collectNamedOutbound: resolves workspace-relative paths into blob-backed attachments", async () => {
  const transfer = createMemoryBlobTransferStore();
  const sandbox = fakeSandbox({ "outbox/cover.png": bytes("PNGDATA"), "report.pdf": bytes("PDF") }, []);
  const r = await collectNamedOutbound(sandbox, handle, ["outbox/cover.png", "report.pdf"], transfer);
  assert.equal(r.attachments.length, 2, "both named files became attachments");
  assert.deepEqual(r.attachments.map((a) => a.name).sort(), ["cover.png", "report.pdf"]);
  assert.ok(
    r.attachments.every((a) => a.blobId && a.sizeBytes > 0),
    "each attachment is blob-backed",
  );
});

test("collectNamedOutbound: rejects parent traversal before reading outside the workspace", async () => {
  const transfer = createMemoryBlobTransferStore();
  const reads: string[] = [];
  const invalid = ["../.ssh/id_ed25519", "work/../../.ssh/id_ed25519"];
  const paths = ["report.pdf", ...invalid];
  const sandbox = {
    async readFileBytes(_handle: SandboxHandle, p: string) {
      reads.push(p);
      return bytes("secret");
    },
  } as unknown as Sandbox;
  const r = await collectNamedOutbound(sandbox, handle, paths, transfer);
  assert.deepEqual(r.missing, invalid);
  assert.deepEqual(r.attachments, []);
  assert.deepEqual(reads, []);
  assert.equal(await transfer.sweep(0), 0);
});

test("collectNamedOutbound: preserves POSIX filenames containing backslashes", async () => {
  const path = String.raw`reports\..\final.txt`;
  const r = await collectNamedOutbound(
    fakeSandbox({ [path]: bytes("report") }, []),
    handle,
    [path],
    createMemoryBlobTransferStore(),
  );
  assert.equal(r.attachments.length, 1);
  assert.equal(r.attachments[0]?.name, "final.txt");
  assert.deepEqual(r.missing, []);
});

test("surface post rejects traversal before provisioning or staging any attachment", async () => {
  const calls = { provision: 0, read: 0, put: 0, grant: 0 };
  const tools = createSurfaceToolDeps({
    deps: {
      deliveries: {},
      sandbox: {
        async readFileBytes() {
          calls.read += 1;
          return bytes("file");
        },
      },
    },
    input: { surfaceTools: true },
    defaultDestination: {},
    strictReadOnly: false,
    provision: async () => {
      calls.provision += 1;
      return handle;
    },
    blobTransfer: {
      async put() {
        calls.put += 1;
        return { blobId: "blob" };
      },
    },
    fileRegistration: {
      async onRegistered() {
        calls.grant += 1;
      },
    },
    spine: { surfaceOutboundCount: 0, crossConversationPosts: 0 },
  } as unknown as SurfaceToolsContext);
  const r = await tools!.post("hello", undefined, ["report.pdf", "../.ssh/id_ed25519"]);
  assert.equal(r.ok, false);
  assert.deepEqual(calls, { provision: 0, read: 0, put: 0, grant: 0 });
});

test("surface standing orders preserve and reset the stored ambient reply policy", async () => {
  const channelPolicy = createMemoryChannelPolicyStore();
  const tools = createSurfaceToolDeps({
    deps: { deliveries: {}, channelPolicy, auditLog: { record() {} } },
    input: { surfaceTools: true },
    actor: { id: "U1" },
    conversation: { kind: "channel", channelRef: "C1" },
    session: { id: "S1" },
    scopeId: "channel:C1",
    defaultDestination: {},
    strictReadOnly: false,
    blobTransfer: {},
    fileRegistration: {},
    provision: async () => handle,
    postProvenance() {
      return {};
    },
    spine: { surfaceOutboundCount: 0, crossConversationPosts: 0 },
  } as unknown as SurfaceToolsContext)!;

  await tools.setStandingOrder("watch", undefined, true);
  assert.equal((await channelPolicy.get("C1"))?.ambientEnabled, true);
  const enabledOrder = await tools.getStandingOrder();
  assert.equal(enabledOrder.ok && enabledOrder.ambientEnabled, true);
  await tools.setStandingOrder("keep watching");
  assert.equal((await channelPolicy.get("C1"))?.ambientEnabled, true);
  await tools.setStandingOrder("keep watching", undefined, null);
  assert.equal((await channelPolicy.get("C1"))?.ambientEnabled, undefined);
  const defaultOrder = await tools.getStandingOrder();
  assert.equal(defaultOrder.ok && defaultOrder.ambientEnabled, undefined);
});

test("collectNamedOutbound: a missing/empty path is reported (so post can fail the WHOLE call)", async () => {
  const transfer = createMemoryBlobTransferStore();
  const sandbox = fakeSandbox({ "outbox/there.png": bytes("X"), "outbox/blank.txt": bytes("") }, []);
  const r = await collectNamedOutbound(
    sandbox,
    handle,
    ["outbox/there.png", "outbox/gone.png", "outbox/blank.txt"],
    transfer,
  );
  assert.deepEqual(r.missing, ["outbox/gone.png"], "the unresolvable path is surfaced");
  assert.deepEqual(r.empty, ["outbox/blank.txt"], "the empty file is surfaced");
  assert.deepEqual(r.attachments, [], "no attachment survives a doomed call");
  assert.equal(await transfer.sweep(0), 0, "no orphaned transfer blob for the good file");
});

test("collectNamedOutbound: a doomed call's rollback never deletes an artifact an earlier call created (idempotent ids under a shared seed)", async () => {
  const transfer = createMemoryBlobTransferStore();
  const store = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const register: ArtifactRegistration = {
    store,
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    seed: "run-1",
  };
  const sandbox = fakeSandbox({ "outbox/first.md": bytes("delivered earlier"), "outbox/kept.md": bytes("good") }, []);
  const ok = await collectNamedOutbound(sandbox, handle, ["outbox/first.md"], transfer, register);
  assert.equal(ok.attachments.length, 1);
  const priorArtifactId = ok.attachments[0]!.artifactId!;
  assert.ok(await store.get(priorArtifactId), "post #1's artifact is registered");
  const doomed = await collectNamedOutbound(sandbox, handle, ["outbox/kept.md", "outbox/gone.md"], transfer, register);
  assert.deepEqual(doomed.missing, ["outbox/gone.md"]);
  assert.deepEqual(doomed.attachments, [], "the doomed call stages nothing");
  assert.ok(await store.get(priorArtifactId), "post #1's artifact survives post #2's rollback");
});

test("collectOutbound: harvests every outbox file (the turn-result rail for a non-surfaceTools turn)", async () => {
  const transfer = createMemoryBlobTransferStore();
  const sandbox = fakeSandbox({ "outbox/cover.png": bytes("A"), "outbox/leftover.txt": bytes("B") }, [
    "outbox/cover.png",
    "outbox/leftover.txt",
  ]);
  const r = await collectOutbound(sandbox, handle, transfer);
  assert.deepEqual(r.attachments.map((a) => a.name).sort(), ["cover.png", "leftover.txt"]);
});
