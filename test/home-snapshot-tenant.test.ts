import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createS3SnapshotStore } from "../src/sandbox/home-snapshot.ts";
import type { S3Send } from "../src/persistence/s3.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { withoutTenant, withTenant } from "../src/tenants/context.ts";
import { TEST_TENANT } from "./support/test-tenant-id.ts";

function fakeBucket(): { s3: S3Send; objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const s3 = {
    async send(command: unknown) {
      const input = (command as { input: { Key: string; Body?: Uint8Array } }).input;
      if (command instanceof PutObjectCommand) {
        objects.set(input.Key, input.Body!);
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const body = objects.get(input.Key);
        if (!body) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        return { Body: Readable.from([body]), ContentLength: body.length };
      }
      throw new Error(`unexpected command ${String(command)}`);
    },
  } as unknown as S3Send;
  return { s3, objects };
}

async function read(store: ReturnType<typeof createS3SnapshotStore>, scope: string): Promise<string | null> {
  const got = await store.open(scope);
  if (!got) return null;
  const chunks: Uint8Array[] = [];
  for await (const part of got.parts) chunks.push(part);
  return Buffer.concat(chunks).toString("utf8");
}

const SCOPE = "personal:U1";

test("home snapshots for the same scope in two tenants never share an object", async () => {
  const { s3, objects } = fakeBucket();
  const store = createS3SnapshotStore({ bucket: "b", prefix: "modal-home", s3 });
  const other = randomUUID();
  await withTenant(TEST_TENANT, () => store.put(SCOPE, Buffer.from("home of the first tenant")));
  assert.equal(await withTenant(other, () => read(store, SCOPE)), null);
  await withTenant(other, () => store.put(SCOPE, Buffer.from("home of the second tenant")));
  assert.equal(await withTenant(TEST_TENANT, () => read(store, SCOPE)), "home of the first tenant");
  assert.deepEqual(
    [...objects.keys()].sort(),
    [`modal-home/${TEST_TENANT}/personal%3AU1.tar`, `modal-home/${other}/personal%3AU1.tar`].sort(),
  );
});

test("multipart uploads land under the bound tenant", async () => {
  const keys: string[] = [];
  const s3 = {
    async send(command: { input: { Key: string } }) {
      keys.push(command.input.Key);
      return { UploadId: "u", ETag: "e" };
    },
  } as unknown as S3Send;
  const store = createS3SnapshotStore({ bucket: "b", prefix: "e2b-home", s3 });
  const tenant = randomUUID();
  await withTenant(tenant, async () => {
    const upload = await store.createUpload(SCOPE);
    await upload.addPart(Buffer.from("x"));
    await upload.complete();
  });
  assert.ok(keys.length > 0);
  assert.ok(keys.every((key) => key === `e2b-home/${tenant}/personal%3AU1.tar`));
});

test("home snapshot reads and writes fail closed when no tenant is bound", () =>
  withoutTenant(async () => {
    const { s3, objects } = fakeBucket();
    const store = createS3SnapshotStore({ bucket: "b", prefix: "modal-home", s3 });
    await assert.rejects(store.put(SCOPE, Buffer.from("x")), /tenant/);
    await assert.rejects(store.open(SCOPE), /tenant/);
    await assert.rejects(store.createUpload(SCOPE), /tenant/);
    assert.equal(objects.size, 0);
  }));

test("a pre-tenancy home is read back only by the sole tenant of a single-tenant core", async () => {
  const { s3, objects } = fakeBucket();
  objects.set("modal-home/personal%3AU1.tar", Buffer.from("legacy home"));
  const store = createS3SnapshotStore({ bucket: "b", prefix: "modal-home", s3 });
  try {
    await bindBootTenant(async () => TEST_TENANT);
    assert.equal(await withTenant(TEST_TENANT, () => read(store, SCOPE)), "legacy home");
    assert.equal(await withTenant(randomUUID(), () => read(store, SCOPE)), null);
    await withTenant(TEST_TENANT, () => store.put(SCOPE, Buffer.from("new home")));
    assert.equal(await withTenant(TEST_TENANT, () => read(store, SCOPE)), "new home");
    assert.equal(Buffer.from(objects.get("modal-home/personal%3AU1.tar")!).toString(), "legacy home");
    await bindBootTenant(async () => undefined);
    objects.delete(`modal-home/${TEST_TENANT}/personal%3AU1.tar`);
    assert.equal(await withTenant(TEST_TENANT, () => read(store, SCOPE)), null);
  } finally {
    await bindBootTenant(async () => TEST_TENANT);
  }
});
