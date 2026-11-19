# Private file sharing

The native files share action now supports the same exact once-only privateRevision approval as apps. The selected file keeps its ID and immutable saved bytes. Preflight returns its canonical ID, metadata/SHA revision and destination. Shared-context, non-owner and automated callers cannot release a private file. Direct HTTP requests cannot supply release authority. The existing native tool fields action/id/toScope/permission are retained; optional privateRevision is added only to the share action. Existing ShareArtifactRequest, ArtifactHome and refusal privateRelease fields are reused without new keys.

Authorization, session privacy inheritance and source-policy reads finish before the file transaction. The request-local prepared grant captures validated authority; it is not queued or persisted. The transaction takes the existing file advisory lock and a row lock, rechecks the exact revision and saved blob/SHA, and uses the existing tenant-scoped grant compare-and-set on the same client. It requires an empty prior grant set, preventing release from activating an earlier or concurrent unapproved grant. Grant creation and privacy clearing commit or roll back together. The callback performs only its supplied-client writes, avoiding query-pool saturation deadlocks.

The shared artifact disclosure helper is moved from deploy/app-disclosure.ts to memory/artifact-disclosure.ts and reused by apps, files and skill ACL validation. Current grant-replacement authority is changedBy, not the stored original grant attribution. Ordinary sharing back to the owner/actor/source target is preserved; other retained foreign sources continue to use the existing disclosure policy. Private release always runs that policy. The original private conversation, other outputs and their learning remain private.

## Persistence, compatibility and rollout

No SQL table, key, index, constraint, enum, migration, environment variable, provider or user setting changes. file_artifacts retains every column. Release changes only personal_only from true to false, updated_at to the release time and source_provenance by removing the consenting person's personal source. Sensitivity, sourceUnknown and all other sources remain. Bytes, SHA, blob key, size, ID, home, path, MIME type, direction/source, enabled state and creation time remain unchanged. One ordinary ACL read/manage grant is created. Existing ordinary records are not backfilled. Owner/same-source sharing is preserved; widening retained foreign provenance can now be refused. Upgrade all readers/writers before use.

Invented representative row before:

```json
{
  "tenant_id": "00000000-0000-4000-8000-000000000001",
  "id": "example",
  "kind": "file",
  "owner_scope_id": "personal:alice",
  "created_by": "alice",
  "name": "report.txt",
  "path": "artifacts/example/report.txt",
  "mimetype": "text/plain",
  "size_bytes": 53,
  "blob_key": "example-blob",
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "direction": "out",
  "source": "live",
  "created_in_scope": "personal:alice",
  "created_at": 1,
  "updated_at": 1,
  "enabled": true,
  "personal_only": true,
  "source_provenance": {
    "sensitivity": "restricted",
    "sources": ["personal:alice", "group:team"],
    "sourceUnknown": false
  }
}
```

After: every field above is retained unchanged except personal_only=false, updated_at=2 and source_provenance.sources=["group:team"]. New grant: {owner_scope_id:"personal:alice",path:"example",grantee_scope_id:"group:team",permission:"read",granted_by:"alice"}, in the same tenant. There are no new columns or value variants.

The selected revision is a full SHA-256 digest of canonical FileArtifact metadata, including saved SHA and blob identity, ownership, provenance and visibility. Metadata-only/unverified blobs cannot be released. The revision is not a new persisted field. The resolved approval payload and durable approval record remain unchanged; the native share request carries the digest.

## src/files/file-artifact-store.ts

### Before

```typescript
export interface FileArtifact {
  personalOnly?: true;
  sourceProvenance?: SourceProvenance;
  id: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  name: string;
  path: string;
  mimetype: string;
  sizeBytes: number;
  blobKey: string | null;
  sha256: string | null;
  direction: FileDirection;
  source: FileSource;
  createdInScope?: ScopeId;
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
}

export interface FileArtifactStore {
  put(input: PutFileInput): Promise<{ artifact: FileArtifact; created: boolean }>;
  publish(input: PublishFileInput, transaction?: PoolClient): Promise<{ artifact: FileArtifact; created: boolean }>;

  get(id: string, opts?: { includeDisabled?: boolean }): Promise<FileArtifact | null>;
  getMany(ids: readonly string[], opts?: { includeDisabled?: boolean }): Promise<FileArtifact[]>;

  open(id: string): Promise<{ artifact: FileArtifact; sizeBytes: number; stream: Readable } | null>;

  listContext(
    scopes: readonly ScopeId[],
    opts?: Pick<ListOwnedOptions, "limit" | "excludePersonalOnly">,
  ): Promise<FileArtifact[]>;
  listOwnedByScopes(scopes: readonly ScopeId[], opts?: ListOwnedOptions): Promise<FilePage>;

  listDocuments(
    scopes: readonly ScopeId[],
    sharedRefs: readonly FileArtifactRef[],
    opts?: ListOwnedOptions,
  ): Promise<FilePage>;

  resolveByIds(refs: readonly FileArtifactRef[]): Promise<FileArtifact[]>;

  setEnabled(id: string, enabled: boolean): Promise<void>;

  delete(id: string): Promise<void>;
}
```

### After

```typescript
export interface FileArtifact {
  personalOnly?: true;
  sourceProvenance?: SourceProvenance;
  id: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  name: string;
  path: string;
  mimetype: string;
  sizeBytes: number;
  blobKey: string | null;
  sha256: string | null;
  direction: FileDirection;
  source: FileSource;
  createdInScope?: ScopeId;
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
}

export interface FileArtifactStore {
  releasePrivate(
    id: string,
    revision: string,
    sourceProvenance: SourceProvenance,
    writeGrant: (transaction: PoolClient) => Promise<void>,
  ): Promise<FileArtifact>;
  put(input: PutFileInput): Promise<{ artifact: FileArtifact; created: boolean }>;
  publish(input: PublishFileInput, transaction?: PoolClient): Promise<{ artifact: FileArtifact; created: boolean }>;

  get(id: string, opts?: { includeDisabled?: boolean }): Promise<FileArtifact | null>;
  getMany(ids: readonly string[], opts?: { includeDisabled?: boolean }): Promise<FileArtifact[]>;

  open(id: string): Promise<{ artifact: FileArtifact; sizeBytes: number; stream: Readable } | null>;

  listContext(
    scopes: readonly ScopeId[],
    opts?: Pick<ListOwnedOptions, "limit" | "excludePersonalOnly">,
  ): Promise<FileArtifact[]>;
  listOwnedByScopes(scopes: readonly ScopeId[], opts?: ListOwnedOptions): Promise<FilePage>;

  listDocuments(
    scopes: readonly ScopeId[],
    sharedRefs: readonly FileArtifactRef[],
    opts?: ListOwnedOptions,
  ): Promise<FilePage>;

  resolveByIds(refs: readonly FileArtifactRef[]): Promise<FileArtifact[]>;

  setEnabled(id: string, enabled: boolean): Promise<void>;

  delete(id: string): Promise<void>;
}
```

## src/acl/acl-store.ts

### Before

```typescript
export interface AclStore {
  grant(tenant: Tenant, g: Grant, authoredBy?: string, releasePrivate?: true): Promise<void>;
  revoke(
    tenant: Tenant,
    ownerScopeId: ScopeId,
    ref: string,
    granteeScopeId: ScopeId,
    revokedBy: string,
    authoredBy?: string,
  ): Promise<void>;
  replaceGrantsIfCurrent(
    tenant: Tenant,
    ownerScopeId: ScopeId,
    ref: string,
    expected: readonly Grant[],
    replacement: readonly Grant[],
    changedBy: string,
    authoredBy?: string,
  ): Promise<boolean>;
  handlesFor(tenant: Tenant, scopeIds: readonly ScopeId[]): Promise<GrantedHandle[]>;
  handlesForAudience(
    tenant: Tenant,
    audience: readonly Principal[],
    sessionScopeId: ScopeId,
    orgScopeId: ScopeId,
    entitled: ScopeEntitlement,
  ): Promise<GrantedHandle[]>;
  grantsFor(tenant: Tenant, ownerScopeId: ScopeId, ref: string): Promise<Grant[]>;
  grantsOfKind(
    tenant: Tenant,
    kind: Exclude<ResourceKind, "file">,
    audience: readonly Principal[],
    sessionScopeId: ScopeId,
    orgScopeId: ScopeId,
    entitled: ScopeEntitlement,
  ): Promise<Grant[]>;
  sharedOfKindForAudience(
    tenant: Tenant,
    kind: Exclude<ResourceKind, "file">,
    audience: readonly Principal[],
    sessionScopeId: ScopeId,
    orgScopeId: ScopeId,
    entitled: ScopeEntitlement,
  ): Promise<Grant[]>;
  find(tenant: Tenant, query: GrantQuery): Promise<Grant[]>;
}

export interface AclStoreOptions {
  isPersonalOnly?: (ownerScopeId: ScopeId, ref: string) => Promise<boolean>;
  manages?: ScopeManagement;
  resolveFiles?: (refs: readonly FileArtifactRef[]) => Promise<FileArtifact[]>;
}

export interface GrantPersistence {
  find(tenant: Tenant, query: GrantQuery): Promise<Grant[]>;
  put(tenant: Tenant, g: Grant): Promise<void>;
  remove(tenant: Tenant, g: Grant): Promise<void>;
  replaceForResourceIfCurrent(
    tenant: Tenant,
    ownerScopeId: ScopeId,
    ref: string,
    expected: readonly Grant[],
    replacement: readonly Grant[],
  ): Promise<boolean>;
}
```

### After

```typescript
export interface AclStore {
  grant(tenant: Tenant, g: Grant, authoredBy?: string, options?: { releasePrivate?: true }): Promise<void>;
  preparePrivateGrant(
    tenant: Tenant,
    g: Grant,
    authoredBy?: string,
  ): Promise<(transaction: PoolClient) => Promise<void>>;
  revoke(
    tenant: Tenant,
    ownerScopeId: ScopeId,
    ref: string,
    granteeScopeId: ScopeId,
    revokedBy: string,
    authoredBy?: string,
  ): Promise<void>;
  replaceGrantsIfCurrent(
    tenant: Tenant,
    ownerScopeId: ScopeId,
    ref: string,
    expected: readonly Grant[],
    replacement: readonly Grant[],
    changedBy: string,
    authoredBy?: string,
  ): Promise<boolean>;
  handlesFor(tenant: Tenant, scopeIds: readonly ScopeId[]): Promise<GrantedHandle[]>;
  handlesForAudience(
    tenant: Tenant,
    audience: readonly Principal[],
    sessionScopeId: ScopeId,
    orgScopeId: ScopeId,
    entitled: ScopeEntitlement,
  ): Promise<GrantedHandle[]>;
  grantsFor(tenant: Tenant, ownerScopeId: ScopeId, ref: string): Promise<Grant[]>;
  grantsOfKind(
    tenant: Tenant,
    kind: Exclude<ResourceKind, "file">,
    audience: readonly Principal[],
    sessionScopeId: ScopeId,
    orgScopeId: ScopeId,
    entitled: ScopeEntitlement,
  ): Promise<Grant[]>;
  sharedOfKindForAudience(
    tenant: Tenant,
    kind: Exclude<ResourceKind, "file">,
    audience: readonly Principal[],
    sessionScopeId: ScopeId,
    orgScopeId: ScopeId,
    entitled: ScopeEntitlement,
  ): Promise<Grant[]>;
  find(tenant: Tenant, query: GrantQuery): Promise<Grant[]>;
}

export interface AclStoreOptions {
  authorizeArtifactShare?: (grant: Grant, actorId: string, releasePrivate?: true) => Promise<void>;
  manages?: ScopeManagement;
  resolveFiles?: (refs: readonly FileArtifactRef[]) => Promise<FileArtifact[]>;
}

export interface GrantPersistence {
  find(tenant: Tenant, query: GrantQuery): Promise<Grant[]>;
  put(tenant: Tenant, g: Grant): Promise<void>;
  remove(tenant: Tenant, g: Grant): Promise<void>;
  replaceForResourceIfCurrent(
    tenant: Tenant,
    ownerScopeId: ScopeId,
    ref: string,
    expected: readonly Grant[],
    replacement: readonly Grant[],
    transaction?: PoolClient,
  ): Promise<boolean>;
}
```

## Validation

All nine private-file cases pass, covering: atomic grant and byte preservation, rollback after grant write, stale selection, native preflight and role checks, retained restrictions on raw grants/replacements, operation with only one query-pool connection available, refusal of concurrent/existing grants, and refusal to clear privacy through a self-share (including equivalent email scopes). The five-file initial adapter/sharing batch and the final14-file affected batch pass. Types/lint/format pass. One interim batch hit an existing manual worker-claim race in the large private-skill fixture; standalone and final affected runs pass.

Independent checkpoint reviews accepted authorization95 and transaction/durability96 after correcting the nested-pool callback. These are not full-head Wall reviews.

Native real-model document-surface QA produced a concrete once-only card, created exactly one Team read grant and allowed a second user's authenticated200 download of all53 original bytes. Blob, hash and other metadata stayed unchanged; the private conversation and other app/schedule stayed private; no access notifications were sent; test identities/preferences were restored. Images and private fixture identifiers remain outside the public checkout.

Skill and schedule release, the complete resource/unknown-source audit, full-head reviews/CI and final rollout/dependency verification remain outstanding. No production merge or deployment.
