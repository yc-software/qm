# Document conversations

A surface can associate each document with a shared conversation in an administrator-selected project and a separate personal conversation for each member. No document reference grants membership. Resolution checks the project's current active roster, including for a saved private preference. Shared sessions exist before the first message, so another authorized member can send the first turn on the same binding.

An org admin configures a surface using `PUT /api/admin/documents/surface` with `{ "surface": "https://sheets.example.test", "projectId": "<existing project id>" }`. The signed core equivalent is `/v1/admin/documents/surface`. This is deployment configuration, not an end-user picker. Changing it affects new document associations only; existing associations, conversations, messages, and grants retain their audience.

An authenticated embedded client calls `POST /api/documents/resolve` with `{ "surface": "https://sheets.example.test", "documentId": "<persisted document identifier>", "mode": "private" }`. Omit `mode` to resume the member's saved preference, initially `shared`. The core equivalent is `/v1/web/documents/resolve`. Identity comes from the authenticated request; body principal claims do not select an owner.

A successful response is `{ "status": "ok", "conversation": { "scopeId": "personal:alice", "threadRef": "web:alice:<uuid>", "sessionId": "<session id>", "mode": "private" } }`. Shared mode uses the configured project's group scope. Unknown surfaces return 503; nonmembers return 403. The browser API checks session identity, the server checks active membership, and ordinary session and turn authorization applies afterwards.

## Persistence change

Before: no document binding table. Existing `projects`, sessions, membership, and grant schemas are unchanged.

After: `document_conversations` uses the existing tenant-bound durable-map schema: `(tenant_id, id)` primary key and JSONB `json`. The existing map factory applies its standard tenant isolation, versioning, and claim migrations. No new environment setting or custom index is introduced.

The id is SHA-256 of a JSON array of the following key components; the examples are invented:

| Key components                                                                                         | Complete JSON value                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `["surface", "https://sheets.example.test"]`                                                           | `{ "kind": "surface", "projectId": "p1" }`                                                           |
| `["conversation", "https://sheets.example.test", "group:web-project-p1", "book1", "shared", ""]`       | `{ "kind": "conversation", "scopeId": "group:web-project-p1", "threadRef": "web:alice:<uuid>" }`     |
| `["conversation", "https://sheets.example.test", "group:web-project-p1", "book1", "private", "alice"]` | `{ "kind": "conversation", "scopeId": "personal:alice", "threadRef": "web:alice:<different uuid>" }` |
| `["preference", "https://sheets.example.test", "book1", "alice"]`                                      | `{ "kind": "preference", "mode": "private" }`                                                        |

Bindings use atomic put-if-absent. Project roster locking coordinates resolution with membership edits. Preferences exclude project id so remapping a surface cannot silently reset private mode. Document association records pin the project when first resolved. Binding keys include project scope so remapping never reuses a conversation from another audience. Session content stays in the existing session store; private references and preferences need not be written to the document.

A client adopting existing settings may include `previous: { scopeId, threadRef }`. Resolution accepts only an existing managed project whose active roster includes that person. If the thread exists, its actual session scope must match. The association retains that project and existing thread; nothing copies history or broadens its audience. An unused reference receives a fresh thread in the original project. Subsequent resolutions use the durable association rather than further client hints.

No old fields are moved or dropped. Adoption adds `["document", surface, documentId]` with `{ "kind": "document", "projectId": "p1", "threadRef": "web:alice:<uuid>" }`; `threadRef` is present only when adopting an existing session. New documents omit it. Existing embedded clients are unaffected until they call the new API. The table and mapping must be available before enabling clients that require resolution. Automatic knowledge routing and additional authorized read destinations are separate work; this API alone does not establish their privacy guarantees.

## Automatic knowledge routing

Each document association also defines a group knowledge scope, `group:document-<document record hash>`. The managed-group directory resolves its membership and version from the original parent project on each request. It stores no copied roster. Batch membership resolves parent projects together; disclosure loads each source roster once per read and preserves linked-person identity checks. Unknown associations deny membership.

A session is indexed to exactly one document association. The index is immutable: resolving another document with the same saved legacy thread creates a fresh conversation instead of changing the first session's document. Actual malformed/conflicting stored associations produce 409. Team remapping continues to affect new associations only.

Shared document turns can recall relevant team and current-document knowledge, subject to the full conversation audience's current entitlement. Other documents' scopes are not added to recall. These native reads do not require open sharing. Document turns do not automatically carry unrelated personal/open-scope files, skills, or memory into the conversation.

The ordinary memory tool defaults writes to the current document. `scope=team` selects the authoritative team notebook only when the server issued `teamWrite`; private conversations receive no such grant. Edit/delete use the same writable-notebook check. The agent self-API accepts the same bounded `scope: "team"` destination, alongside its existing org-admin destination. Private document turns do not receive automatic org-write capability.

Automatic post-turn extraction uses the existing utility-model request with a structured applicability result: team, document, or discard. Scope IDs and provenance come from server metadata, never model output. Unrecognized applicability remains document-specific. The extractor excludes transient values/results and treats only the user's own directives as applicability instructions. Private captures remain in the owner's personal notebook. Captures are audited by destination, count, session, and private status without including their text in the audit event.

## Additional persistence changes

The durable map now also contains these complete JSON shapes (examples invented):

| Key components                                     | JSON value                                                                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `["knowledge", "document-<document record hash>"]` | `{ "kind": "knowledge", "groupRef": "document-<document record hash>", "projectId": "p1" }`                                                                 |
| `["session", "session1"]`                          | `{ "kind": "session", "documentKey": "<document record hash>", "projectId": "p1", "scopeId": "group:web-project-p1", "mode": "shared" }`                    |
| `["session", "session2"]`                          | `{ "kind": "session", "documentKey": "<document record hash>", "projectId": "p1", "scopeId": "personal:alice", "mode": "private", "principalId": "alice" }` |

These are direct-key records in the same tenant-bound map. No new index, environment setting, or scope kind is added. Resolution populates metadata for adopted sessions before use; existing session content remains in its original store and audience.

Migration `memory/facts/0005-personal-only` adds `memory_facts.personal_only BOOLEAN NOT NULL DEFAULT false`. All existing columns, keys and indexes remain unchanged. Existing rows get false; this does not reinterpret historical ordinary chats as private. New private document captures and edits set true. For example, an old personal fact row retains its text, source scopes, sensitivity, timestamps and session id with `personal_only=false`; replacing it from a private document changes its text/timestamp and sets `personal_only=true`.

The TypeScript provenance shape adds optional `personalOnly: true`; false SQL values remain absent in that shape. Duplicate merges, edits and derived facts retain the strongest restriction, and SQL updates cannot clear true. Disclosure applies it before native/open-sharing exceptions, including a shared audience containing only the owner. Linked owner identities remain eligible only in their personal context.

Opaque memory providers cannot retain this provenance. Routing therefore withholds direct and inherited personal-only captures from those providers. A configured provenance-aware notebook receives the private capture; if no eligible notebook route exists, capture is denied rather than sent to the opaque provider. Existing provider capture-off policies remain effective.

Deploy the migration and updated API/workers before enabling the Excel changes; do not enable private capture while older workers can still process new turns. Older code does not enforce the new provenance field, so rolling back requires disabling the new client behavior first. There is no automatic publication or audience expansion for previously captured private facts.

## Fresh discussions and client tool execution

`POST /api/documents/:sessionId/restart` creates an empty conversation in the same mode and audience, then atomically rotates its current document binding. The signed core equivalent is `/v1/web/documents/:sessionId/restart`. Old sessions and durable knowledge remain. Restarting an obsolete binding or a child session returns a conflict; another member cannot restart a private conversation.

Session association metadata requires `bindingKey`, the opaque hash of the conversation binding. Invented before: `{ "kind": "session", "documentKey": "doc-hash", "projectId": "p1", "scopeId": "group:web-project-p1", "mode": "shared" }`. After: `{ "kind": "session", "documentKey": "doc-hash", "projectId": "p1", "scopeId": "group:web-project-p1", "mode": "shared", "bindingKey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }`. Private associations retain their existing `principalId`; all other record variants are unchanged. Migration `sessions/store/0066-document-binding-keys` fills keys once from same-tenant conversation bindings and exact association dimensions, including historical and derived sessions. It deletes only association metadata whose session no longer exists, leaving all session/history rows and audiences unchanged. Missing or ambiguous recoverable keys fail the migration transaction. A JSON CHECK requires a 64-character string key on session associations; resolution no longer repairs old rows. The migration follows session/table creation and increments the existing map version. No SQL columns, indexes, settings or grants change. Drain old writers before upgrading; old code that omits the key cannot write session associations after the constraint is installed.

Authenticated browser run responses add `clientToolsFor`, containing the canonical viewer id only when that viewer initiated the web run and declared client tools. It is null otherwise. Other callers do not receive this field. For example, `{ "status": "running", "result": null }` becomes `{ "status": "running", "result": null, "clientToolsFor": "alice" }` for the initiating browser and uses null for a collaborator. Clients must obtain fresh run authorization before dispatching native tools; matching a tool name in shared history is insufficient. Deploy the server first. An older server omits the field, so updated clients refuse execution.

## Development identities

Local development portal instances expose `/api/development/impersonation` for administrator-only testing. GET verifies the original actor and selected view; POST starts or stops ordinary audited impersonation. The endpoint is unavailable outside the existing localhost development-auth mode; it adds no environment setting.

Each pane sends an opaque `development_view` and, while impersonating, `development_impersonating=1`. The portal stores the selected target in a sealed HttpOnly cookie unique to that view, preserving ordinary impersonation permissions and expiry. Optional `driver` identifiers must resolve to the original signed-in actor. Missing or expired active-view cookies fail closed. Browser storage contains identity hints, never an authentication credential. These cookies are disposable testing sessions; authoritative membership and audit state continue to use existing durable stores.

## Selected private learning publication

The native `memory` tool adds `action=publish` to its existing search/read/add/edit/delete actions. The person asks in ordinary conversation; the agent reads the private notebook and proposes `facts: [{id, text}]` with current IDs and verbatim stored text, and `scope=team` or `scope=workbook`. QM chooses the destination from the document binding. These are tool arguments, not user-facing settings.

Publication uses the existing durable exact-call approval mechanism. Its approval record stores the complete tool input and permits only a once-only decision; session-wide and permanent approval are unavailable. Approval of changed text, IDs, or destination does not authorize the original call or a future call. On replay, publication rechecks the private owner, current document-team membership under the project roster lock, and each selected fact's current text. Missing or changed facts cannot publish.

Only the approved owner's personal restriction is removed on the new copy. The private source is unchanged. Sensitivity, source uncertainty, and every known non-personal source remain attached; normal destination disclosure checks still apply. For example, a selected private fact with `personalOnly=true`, `sourceUnknown=true`, and sources `[personal:alice, group:project-a]` becomes a new destination fact with `personalOnly` absent, `sourceUnknown=true`, and the retained `group:project-a` source plus its destination. It cannot publish where that known source is unavailable, and later source-access revocation also restricts retrieval. Source uncertainty is retained rather than treated as proof of complete origin tracking; exact human publication authorizes the selected content's new home.

Memory-disabled or capture-disabled turns cannot publish. There is no new browser endpoint, environment setting, SQL column, or approval store. Existing private facts are not rewritten or backfilled. General artifact publication and private-derived output paths require separate qualification; this operation authorizes neither transcript sharing nor future output publication.

## Attachment selection recovery

Successful `attach` results keep `ok`, current-call `files`, and `staged` count. They additionally return `stagedFiles`, the complete ordered selection, and positive integer `stagedRevision`. Each staged entry contains the existing `artifactId`, `name`, `mimetype`, and `sizeBytes`, optional `artifactViewerId`, plus `key` and `created`. A key is `["path", sandboxIdOrNull, path]` or `["file", artifactId]`; `created` records whether staging owns the artifact for cleanup. The current-call `files` metadata also gains optional `artifactViewerId`.

The successful persisted `ToolResult.body` previously contained `{ok:true,files:[...]}` and now adds `stagedFiles`/`stagedRevision`; it does not persist the `staged` count. The existing `AgentMessage` variant `files_delivered` retains its `files` metadata and every new receipt, including replay, carries the same full snapshot/revision. No item kind or variant changes. Invented snapshot: `{stagedRevision:2,stagedFiles:[{key:["path",null,"report.txt"],artifactId:"file-b",name:"report.txt",mimetype:"text/plain",sizeBytes:3,artifactViewerId:"alice",created:true}]}`. Superseded artifact `file-a` is absent even if cleanup failed.

The staging owner restores the highest durable revision before resuming; result append order and surviving artifacts do not determine selection. Final receipts can establish a later selection even when its tool-result persistence failed. Missing selected artifacts fail explicitly. Recovery authorizes file reads for the current actor and retains that viewer for delivery after temporary blobs expire. Historical attach-call count reserves future registration ordinals. Superseded temporary blobs are discarded immediately; durable artifacts are retained until a complete final receipt commits, then cleanup is best effort. Interruption can retain unselected artifacts but cannot delete the prior acknowledged selection.

Migration `sessions/store/0067-attachment-staging` reconstructs snapshots only for pending/running turns with same-tenant session/run ownership, sequential recorded calls, deduplicated tuple keys, and provable output alignment. It leaves completed history and turns with delivery receipts unchanged. Unknown historical cleanup ownership is false. Overlapping or unmappable in-flight selections receive `ToolResult.body.stagingRecoveryError=true`; recovery reports that files must be attached again in a new turn. No runtime reconstruction from old call arguments or artifact existence remains. No SQL columns, indexes, settings or providers are added. Drain old writers before applying the migration and starting updated workers.


Migration `sessions/store/0068-attachment-receipts` canonicalizes authoritative files-only receipts for pending/running turns with matching tenant/session/run ownership. Each prefix contains the exact cumulative acknowledged file list, with unknown cleanup ownership false and revisions above prior staging snapshots. Completed history is unchanged. New receipt writers require the staging owner's snapshot; runtime conversion from old files-only receipts is removed. This migration adds no columns, indexes, configuration or item variants.
