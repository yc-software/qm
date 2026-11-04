import type { DirectFileUploads } from "../files/direct-file-upload.ts";
import type { DurableByteStore } from "../files/durable-byte-store.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import { perTenantInstance } from "./tenant-instances.ts";

export interface StorageTarget {
  bucket: string;
  prefix?: string;
}

const STORAGE_ENV = ["S3_BUCKET", "S3_PREFIX"] as const;

export function tenantStorage<T>(deployment: StorageTarget, build: (target: StorageTarget) => T): () => T {
  const base = build(deployment);
  const forTenant = perTenantInstance(STORAGE_ENV, (env) => {
    const prefix = env.S3_PREFIX ?? deployment.prefix;
    return build({ bucket: env.S3_BUCKET ?? deployment.bucket, ...(prefix !== undefined ? { prefix } : {}) });
  });
  return () => forTenant() ?? base;
}

export function tenantByteStore(pick: () => DurableByteStore): DurableByteStore {
  return {
    put: (source, opts) => pick().put(source, opts),
    open: (blobKey) => pick().open(blobKey),
    delete: (blobKey) => pick().delete(blobKey),
  };
}

export function tenantBlobTransfer(pick: () => BlobTransferStore): BlobTransferStore {
  const base = pick();
  return {
    put: (source, opts) => pick().put(source, opts),
    open: (blobId) => pick().open(blobId),
    delete: (blobId) => pick().delete(blobId),
    sweep: (maxAgeMs) => pick().sweep(maxAgeMs),
    ...(base.ensureExpiry
      ? { ensureExpiry: async (maxAgeDays: number) => (await pick().ensureExpiry?.(maxAgeDays)) ?? false }
      : {}),
  };
}

export function tenantFileUploads(pick: () => DirectFileUploads): DirectFileUploads {
  const base = pick();
  return {
    begin: (input) => pick().begin(input),
    get: (id) => pick().get(id),
    list: (actorId) => pick().list(actorId),
    sign: (id, partNumber) => pick().sign(id, partNumber),
    complete: (id) => pick().complete(id),
    abort: (id) => pick().abort(id),
    sweep: () => base.sweep(),
    start: () => base.start(),
    stop: () => base.stop(),
  };
}
