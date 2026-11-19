# Private app sharing

App release is implemented and natively qualified on top of455edad. Other output types and full-head checks remain outstanding; this is not a release-readiness claim.

The existing native apps share action accepts optional privateRevision, which requests existing once-only, exact-call approval. A private sharing preflight returns canonical app ID, selected revision and destination scope. Release requires those exact values and current personal-owner context. Direct HTTP share requests cannot supply release authority.

The selected revision hashes app metadata and the saved live-edit draft commit/entrypoint, excluding transient endpoint/status/access bookkeeping. It is not a snapshot of mutable runtime-data bytes. Approval covers sharing this app, including its stored data and history. The same app remains running with its existing data, source history and version records; the private conversation and other outputs stay private.

Under the deployment lock, release validates the current selection and remaining source restrictions, refuses existing grants on a still-private app, grants the approved audience, then removes the private flag. A failed second write leaves the app private and its durable pending grant blocks all later releases until revoked through the existing revoke path. This prevents a subsequent release from activating a stranded earlier grant.

All later grants, public access and ownership transfers check persisted source restrictions. Writes also validate merged incoming provenance against the app’s actual owner/creation/grant/public audiences before mutation; automatic creation audiences are checked before grants or execution. Existing isolated/open sharing posture remains authoritative. Document-source aliases come from the existing document-to-Team mapping, not from treating every recorded source as native.

## Persistence and rollout

No SQL tables, keys, indexes, constraints, migrations, settings or providers are added. The existing deployments JSON personalOnly field changes from true to absent only on successful explicit release; sourceProvenance retains sensitivity, sourceUnknown and all sources other than the consenting person’s personal source. Its sources array may become empty. Every other app field, source version, draft and runtime-data record is preserved.

Invented before row: {"id":"example","ownerScopeId":"personal:alice","createdBy":"alice","currentVersion":1,"status":"running","endpoint":{"host":"127.0.0.1","port":5000},"versions":[{"version":1,"createdAt":1,"entrypoint":"node server.js","snapshotDir":"/snap/example"}],"personalOnly":true,"sourceProvenance":{"sensitivity":"ordinary","sources":["personal:alice"],"sourceUnknown":false}}. After: the same row with personalOnly omitted and sourceProvenance.sources=[]; a normal ACL read grant for personal:bob is added. All existing SQL keys and ACL constraints remain unchanged. No historical private data is inferred or backfilled. Upgrade all readers/writers before enabling release.

The payload additions below are internal/native sharing values. The privateRelease error result guides the next native call; supplying privateRevision on POST /v1/share returns 400 and performs no grant.

## Before sharing payloads

```typescript
export interface ArtifactHome {
  id: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  grantRef: string;
}

export interface ShareArtifactRequest {
  type: ArtifactType;
  id: string;
  scope?: string;
  recipient?: string;
  email?: string;
  permission?: Permission;
  move?: boolean;
  notify?: boolean;
}

export type ShareArtifactResult =
  | {
      ok: true;
      verb: "share" | "move" | "promote";
      type: ArtifactType;
      id: string;
      target: { scope: ScopeId; label: string };
      permission: Permission;
      invitation?: AppInvitation;
    }
  | {
      ok: false;
      code:
        | "bad_request"
        | "not_found"
        | "forbidden"
        | "human_consent_required"
        | "recipient_not_found"
        | "ambiguous_recipient"
        | "share_failed";
      message: string;
      candidates?: Array<{ id: string; label: string }>;
    };
```

## After sharing payloads

```typescript
export interface ArtifactHome {
  id: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  grantRef: string;
  privateRevision?: string;
}

export interface ShareArtifactRequest {
  type: ArtifactType;
  id: string;
  privateRevision?: string;
  scope?: string;
  recipient?: string;
  email?: string;
  permission?: Permission;
  move?: boolean;
  notify?: boolean;
}

export type ShareArtifactResult =
  | {
      ok: true;
      verb: "share" | "move" | "promote";
      type: ArtifactType;
      id: string;
      target: { scope: ScopeId; label: string };
      permission: Permission;
      invitation?: AppInvitation;
    }
  | {
      ok: false;
      code:
        | "bad_request"
        | "not_found"
        | "forbidden"
        | "human_consent_required"
        | "recipient_not_found"
        | "ambiguous_recipient"
        | "share_failed";
      message: string;
      candidates?: Array<{ id: string; label: string }>;
      privateRelease?: { id: string; revision: string; scope: ScopeId };
    };
```

## Internal interfaces

App.grant options add optional privateRevision and trusted PrivateContext. DeployService adds releasePrivateApp(grant, revision, context). DeployStore adds releaseContext(id, metadataRevision, sourceProvenance). AclStore.grant accepts internal options.releasePrivate?:true; it still validates the personal owner, and no HTTP handler accepts it. DeployServiceDeps adds the existing-source-policy callback wired with authoritative membership/configuration; provenance-bearing audience changes fail closed when that callback is unavailable. No persisted approval format changes: the existing durable exact-tool call and once-only grant are used.

## Validation checkpoint

Twenty real-Postgres private-app cases pass, including canonical selection, person-to-person release, stale live edits, partial-write recovery, retained restrictions on subsequent grants/public/transfer, isolated versus open foreign sources, and existing-audience refusal before source/runtime mutation. The exact once-only native tool approval and forged HTTP release cases pass. The affected 13-file batch passed before the final write-audience checks; subsequent focused runs cover those checks and the extracted document-memory logic. Typecheck and changed-file lint pass. Independent checkpoint review accepted94; this does not replace full-head Wall reviews.

Unknown or retained source restrictions can refuse an agent edit to an already shared app. The stricter path remains subject to the historical-output/rollout audit. Other artifact types and final checks remain unfinished. No production merge or deployment is implied.

## Native release and approval corrections

Native real-model QA now covers private creation, denial without a grant, a fresh once-only card after denial, exact selected-app release and a second user's authenticated200 read. The selected app kept its version, source history, endpoint and remaining provenance; its conversation and a separate app stayed private. No access notifications or invitations were sent, and development identities were restored. Review images and private fixture IDs remain outside the public checkout.

The approval reason exposes the selected app ID, exact private revision, canonical audience, permission and notification choice. Generic command redaction remains in place. Internally, ToolApprovalDeclaration.approvalReason changes from optional string to optional string or `(params:unknown)=>string`; the resolved persisted/API reason remains a string, with every other field unchanged.

New approval issuances use an opaque ID scoped to the originating durable run, or the caller's idempotency key/direct-turn nonce. Previously a repeated command reused its earlier denied ID and the chat correctly retained the terminal decision, hiding the new card. Retries of one turn remain stable; a new request has a distinct ID and stale decisions cannot consume it. Existing pending IDs remain addressable; no schema, payload field or historical record changes are required. Native denial/reissue verified the new card appeared without reloading the chat. Existing record and returned PendingApproval shapes are unchanged; only the opaque requestId value is newly scoped.

The private app regression suite passes20 cases; the agent-tool suite passes165; the orchestrator approval suite passes38; six additional affected input-screening/execution/session/approval-delivery files pass. Focused independent review accepted the app release and approval corrections94. Native sharing also exposed the Docker reload collision documented in [docker-app-ports.md](docker-app-ports.md).

App release is implemented and natively qualified. Explicit release of skills and schedules, the complete resource/unknown-source compatibility audit, full-head reviews/CI and final rollout audit remain outstanding. No production merge or deployment has occurred.

The approval issuance regression also fails against unchanged22efcad:37 existing cases pass and the new case detects the reused denied ID. With the fix, all38 pass; stale approval submissions leave the newer request pending. The Docker provider regression separately fails on its unchanged old source. Native sharing proof confirms exactly one executed share call and zero grants before approval.

Private file release and the shared disclosure helper are documented in [private-file-sharing.md](private-file-sharing.md). The internal ACL preparation/CAS interfaces there supersede the earlier grant signature described above.
