import { test } from "node:test";
import assert from "node:assert/strict";
import { collectOutbound, type ArtifactRegistration } from "../src/core/attachments.ts";
import { defaultPublishAudience } from "../src/resolution/publish-audience.ts";
import { createApp, type AppDeps } from "../src/api/app.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createMemoryFileArtifactStore, type FileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { scopeId } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";

const ORG = "default-org";
const initiator = "U1";
const HANDLE = { id: "h", rootDir: "/workspace" } as SandboxHandle;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7f]);

function memSandbox(files: Record<string, Uint8Array>): Sandbox {
  const map = new Map(Object.entries(files));
  return {
    async listDir(_h: SandboxHandle, dir: string) {
      return [...map.keys()].filter((k) => k === dir || k.startsWith(`${dir}/`));
    },
    async readFileBytes(_h: SandboxHandle, rel: string) {
      return map.get(rel) ?? null;
    },
  } as unknown as Sandbox;
}

function registration(
  store: FileArtifactStore,
  acl: ReturnType<typeof createAclStore>,
  isPrivate: boolean | undefined,
  kind: "dm" | "channel",
): ArtifactRegistration {
  const grantees = defaultPublishAudience({
    kind,
    ...(isPrivate !== undefined ? { isPrivate } : {}),
    orgScopeId: scopeId("org", ORG),
    ownerId: initiator,
  }).grantees;
  return {
    store,
    ownerScopeId: scopeId("personal", initiator),
    createdBy: initiator,
    createdInScope: kind === "channel" ? scopeId("channel", "C1") : scopeId("personal", initiator),
    seed: "run-1",
    ...(grantees.length
      ? {
          onRegistered: async ({ ownerScopeId, path }) => {
            for (const granteeScopeId of grantees) {
              await acl.grant({ ownerScopeId, ref: path, granteeScopeId, permission: "read", grantedBy: initiator });
            }
          },
        }
      : {}),
  };
}

function makeApp(files: FileArtifactStore, acl: ReturnType<typeof createAclStore>) {
  return createApp({ acl, files, identity: createIdentityService() } as unknown as AppDeps);
}

test("a file delivered in a PUBLIC channel is auto-shared (read) with the org — visible to other members", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const acl = createAclStore();
  await collectOutbound(
    memSandbox({ "outbox/flag.png": PNG }),
    HANDLE,
    createMemoryBlobTransferStore(),
    registration(files, acl, false, "channel"),
  );

  const u1 = await makeApp(files, acl).listFilesForViewer(initiator);
  assert.equal(u1.owned.length, 1);
  assert.equal(u1.owned[0]!.name, "flag.png");

  const app = makeApp(files, acl);
  const u2 = await app.listFilesForViewer("U2");
  assert.equal(u2.owned.length, 0, "U2 doesn't own it");
  assert.equal(u2.shared.length, 1, "the org read grant surfaces it to U2");
  const opened = await app.openFileForViewer(u2.shared[0]!.id, "U2");
  assert.ok(opened, "the org grant authorizes the bytes");
});

test("a file delivered in a DM stays owner-only — no auto-share", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const acl = createAclStore();
  await collectOutbound(
    memSandbox({ "outbox/note.txt": Buffer.from("private") }),
    HANDLE,
    createMemoryBlobTransferStore(),
    registration(files, acl, undefined, "dm"),
  );

  assert.equal((await makeApp(files, acl).listFilesForViewer(initiator)).owned.length, 1, "owner sees it");
  const u2 = await makeApp(files, acl).listFilesForViewer("U2");
  assert.equal(u2.owned.length + u2.shared.length, 0, "nobody else sees a DM file");
});
