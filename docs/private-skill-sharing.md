# Private skill sharing

Native skills share now supports the same exact once-only approval used for private apps and files. Preflight identifies the canonical skill, current revision, destination and permission; the approval text displays them. Only the live owner in their private personal context can approve. Direct HTTP cannot supply release authority. Sharing into the organization still requires organization administration and does not transfer ownership.

Release verifies the saved manifest signature and the selected metadata revision. It holds the skill name lock and row lock, writes the prepared empty-to-one ACL grant and clears privacy in the same Postgres transaction. A failed grant, stale revision or invalid signature leaves both unchanged. The transaction performs no independent-pool reads. Use telemetry does not invalidate an approval; content, review, status, version, source or ownership changes do.

Ordinary skill edits refresh session provenance after acquiring the name lock, merge retained provenance, and authorize every current reader before writing. Ordinary grants and grant replacement hold that same lock through authorization and persistence. The edit uses an atomic row update with the authorized revision. Copies, promotion and moves preserve and validate retained sources. Moves acquire both source and destination name locks with the existing nonblocking multi-lock operation, refusing concurrent changes rather than waiting in opposite lock orders. Destination grants are validated before a move, including dormant grants left from an earlier home. An actor's personal destination does not bypass validation of its other readers.

## Persistence and compatibility

No SQL table, key, index, constraint, enum, environment variable, provider or user setting changes. No migration or backfill. Existing ordinary skills remain ordinary. Private release requires valid signed content and present source provenance; older invalid signatures cannot be released. The revision is computed, not persisted. Upgrade all readers and writers before enabling use.

The persisted Skill shape is unchanged. Invented complete representative before:

```json
{
  "id": "example",
  "scopeId": "personal:alice",
  "manifest": {
    "name": "selected-procedure",
    "description": "Example",
    "requiredCapabilities": [],
    "body": "Selected procedure",
    "files": [{ "path": "references/checklist.txt", "content": "Selected appendix" }]
  },
  "signature": "saved-signature",
  "status": "published",
  "createdBy": "alice",
  "personalOnly": true,
  "sourceProvenance": {
    "sensitivity": "restricted",
    "sources": ["personal:alice", "group:team"],
    "sourceUnknown": false
  },
  "version": 1,
  "grantedCapabilities": [],
  "approvals": ["alice"],
  "createdAt": 1,
  "updatedAt": 2,
  "lastUsedAt": 3,
  "pack": { "packId": "example-pack", "commit": "saved-commit", "upstreamName": "selected-procedure" }
}
```

After: every key and value above is preserved except personalOnly is omitted and sourceProvenance.sources becomes ["group:team"]. No timestamps, content, files, signature, review state, capabilities, version, pack or home change. Optional files/executable, provenance, timestamps, use telemetry and pack fields remain optional. One ordinary same-tenant grant is added: {ownerScopeId:"personal:alice",ref:"skill:example",granteeScopeId:"group:team",permission:"read",grantedBy:"alice"}. The private conversation and its other outputs remain private.

## API and internal interfaces

The existing share request retains action/id/toScope/permission; skills share adds optional privateRevision:string. Its absence requests preflight; its presence requires exact native once-only approval. No new response fields: ArtifactHome.privateRevision and refusal privateRelease:{id,revision,scope} already exist for apps/files. HTTP still rejects privateRevision. The existing approval payload, resolution and grantModes shape are unchanged.

Internal changes, old to new:

- SkillStore adds releasePrivate(id:string, revision:string, provenance:SourceProvenance, writeGrant:(transaction:PoolClient)=>Promise<void>):Promise<Skill>.
- SkillStore.update(id,manifest,sourceProvenance?) becomes update(id,manifest,sourceProvenance?,expectedRevision?:string). All original parameters and Promise<Skill> result remain.
- SkillStore.promote(id,targetScopeId) and move(id,toScopeId) add optional third expectedRevision:string; all original parameters and Promise<Skill> results remain.
- DurableMap<T> retains every method and adds updateInTransaction(id:string,fn:(value:T,transaction:PoolClient)=>T|Promise<T>):Promise<T|null>. Ordinary update(id,fn:(value:T)=>T) is unchanged. Both use the existing row transaction/version bump.
- AclStoreOptions retains every option and adds optional withArtifactLock:<R>(ownerScopeId:ScopeId,ref:string,write:()=>Promise<R>)=>Promise<R>. Production wiring supplies the skill name lock; other resource kinds retain their existing locking.
- App.updateOwnedSkill retains its existing arguments/result and options botActor?,personalOnly?,contextScopeId?,sourceProvenance?; options add context?:PrivateContext. The authenticated surface passes request context so policy refreshes durable session privacy and provenance inside the lock. Model request bodies cannot supply trusted context.

All other payload fields, signatures and stored shapes are retained. These internal additions do not create settings, modes, providers or compatibility shims.

## Verification

Affected checks: 17 selected-release cases, 4 ACL/privacy/grant suites and 9 additional tool/HTTP/skill/map/app/file suites passed; TypeScript and changed-file ESLint passed. The privacy integration fixture now disables its background claim loop before manually claiming capability runs, preventing its own worker from consuming those fixture runs.

Live document-surface QA covered real native creation, once-only approval and second-user reads. Native-created skills retained private learning source restrictions, and incompatible release was refused. A separately seeded synthetic selected-output fixture used the production SkillStore with known personal-only provenance; its approved release preserved content, signature, version, reviews and home. The intended team reader loaded the exact validation code with the native skills tool; the same actor in another team context could not find it. An older invalid signature was refused. Other skills and the owner conversation stayed private; impersonation and private preferences were restored. This is checkpoint verification, not completion of all private-output work.
