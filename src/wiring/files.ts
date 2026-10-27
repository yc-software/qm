import type { StoresModule } from "./stores.ts";
import type { Head } from "./late.ts";
import { tenantConfig } from "../tenants/tenant-config.ts";
import { perTenant } from "../tenant.ts";
import { createPostgresToolOutputStore } from "../sessions/tool-output.ts";
import { createAclStore } from "../acl/acl-store.ts";
import { createPostgresGrantStore } from "../acl/postgres-grant-store.ts";
import { createPostgresRateLimiter, RATE_LIMIT } from "../ratelimit/postgres-rate-limiter.ts";
import { createPostgresBudgetTracker } from "../ratelimit/postgres-budget.ts";
import { createResolutionService } from "../resolution/resolution-service.ts";
import { createLocalWorkspaceStore } from "../workspace/workspace-store.ts";
import {
  type BlobTransferStore,
  createS3BlobTransferStore,
  createLocalBlobTransferStore,
} from "../persistence/blob-transfer.ts";
import { join } from "node:path";
import {
  type DurableByteStore,
  createS3DurableByteStore,
  createLocalDurableByteStore,
} from "../files/durable-byte-store.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import { createPostgresFileArtifactStore } from "../files/postgres-file-artifact-store.ts";
import { createDirectFileUploads } from "../files/direct-file-upload.ts";
import { createPostgresFileUploadStore } from "../files/file-upload-store.ts";
import { createMcpServerStore } from "../mcp/mcp-server-store.ts";
import { withErrorReporting } from "../admin/error-log.ts";
import { createPostgresErrorLog } from "../admin/postgres-error-log.ts";

type FilesInputs = Pick<Head, "config"> & { stores: StoresModule };

export function buildFiles(deps: FilesInputs) {
  const { databaseUrl, managesArtifactHome, configStore, pgPool, every } = deps.stores;
  const { config } = deps;

  const acl = createAclStore(createPostgresGrantStore(databaseUrl), {
    manages: (principalId, scopeId, authoredBy) => managesArtifactHome(scopeId, authoredBy ?? "", principalId),
    resolveFiles: (refs) => files.resolveByIds(refs),
  });
  const rateLimiter = createPostgresRateLimiter(databaseUrl, RATE_LIMIT);
  const budgetOpts = {
    ...(config.budgetUsdPerWindow !== undefined ? { limitUsd: config.budgetUsdPerWindow } : {}),
    ...(config.orgBudgetUsdPerWindow !== undefined ? { orgLimitUsd: config.orgBudgetUsdPerWindow } : {}),
  };
  const budget =
    config.budgetUsdPerWindow !== undefined || config.orgBudgetUsdPerWindow !== undefined
      ? createPostgresBudgetTracker(databaseUrl, budgetOpts)
      : undefined;
  const resolution = createResolutionService(configStore, acl);
  const workspace = createLocalWorkspaceStore(config.dataDir);
  const s3Options = (prefix: string) => ({
    get bucket() {
      return tenantConfig(config).s3Bucket ?? config.s3Bucket!;
    },
    ...(config.s3Region ? { region: config.s3Region } : {}),
    get prefix() {
      return `${tenantConfig(config).s3Prefix ?? ""}${prefix}`;
    },
  });
  const blobTransfer: BlobTransferStore = config.s3Bucket
    ? tenantBlobTransfer(perTenant(() => createS3BlobTransferStore(s3Options(""))))
    : createLocalBlobTransferStore(join(config.dataDir, "transfer"));
  const s3Bytes = (prefix: string): DurableByteStore =>
    tenantBytes(perTenant(() => createS3DurableByteStore(s3Options(prefix))));
  const byteStore = (prefix: string, localDir: string): DurableByteStore =>
    config.s3Bucket ? s3Bytes(prefix) : createLocalDurableByteStore(join(config.dataDir, localDir));
  const fileBytes = byteStore("", "docstore");
  const files: FileArtifactStore = createPostgresFileArtifactStore(databaseUrl, fileBytes);
  const fileUploads = config.s3Bucket
    ? createDirectFileUploads(
        Object.assign(s3Options(""), { store: createPostgresFileUploadStore(databaseUrl), files }),
      )
    : undefined;
  const mcpServers = createMcpServerStore(databaseUrl);
  const errors = withErrorReporting(createPostgresErrorLog(databaseUrl));
  const toolOutput = createPostgresToolOutputStore({
    pool: pgPool,
    bytesFor: (prefix) => byteStore(prefix, prefix),
  });
  if (fileUploads) every("file-uploads", 60_000, () => fileUploads.sweep(), { immediate: true });
  every("blob-transfer", 30 * 60_000, () => blobTransfer.sweep(6 * 60 * 60_000));
  return {
    toolOutput,
    errors,
    blobTransfer,
    workspace,
    mcpServers,
    byteStore,
    s3Bytes,
    acl,
    resolution,
    files,
    rateLimiter,
    budget,
    fileUploads,
  };
}

function tenantBytes(store: () => DurableByteStore): DurableByteStore {
  return {
    put: (source, opts) => store().put(source, opts),
    open: (blobKey) => store().open(blobKey),
    delete: (blobKey) => store().delete(blobKey),
  };
}

function tenantBlobTransfer(store: () => BlobTransferStore): BlobTransferStore {
  return {
    put: (source, opts) => store().put(source, opts),
    open: (blobId) => store().open(blobId),
    delete: (blobId) => store().delete(blobId),
    sweep: (maxAgeMs) => store().sweep(maxAgeMs),
    ensureExpiry: (maxAgeDays) => store().ensureExpiry!(maxAgeDays),
    s3Ref: (blobId) => store().s3Ref!(blobId),
  };
}

export type FilesModule = ReturnType<typeof buildFiles>;
