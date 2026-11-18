# Document conversations

A surface can associate each document with a shared conversation in an administrator-selected project and a separate personal conversation for each member. No document reference grants membership. Resolution checks the project's current active roster, including for a saved private preference. Shared sessions exist before the first message, so another authorized member can send the first turn on the same binding.

An org admin configures a surface using `PUT /api/admin/documents/surface` with `{ "surface": "https://sheets.example.test", "projectId": "<existing project id>" }`. The signed core equivalent is `/v1/admin/documents/surface`. This is deployment configuration, not an end-user picker. Changing it does not migrate conversations, messages, or grants.

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

Bindings use atomic put-if-absent. Project roster locking coordinates resolution with membership edits. Preferences exclude project id so remapping a surface cannot silently reset private mode. Binding keys include project scope so remapping never reuses a conversation from another audience. Session content stays in the existing session store; private references and preferences need not be written to the document.

No old fields are moved or dropped and no automatic backfill or conversation import occurs in this foundation. Existing embedded clients are unaffected until they call the new API. The table and mapping must be available before enabling clients that require resolution. Automatic knowledge routing and additional authorized read destinations are separate work; this API alone does not establish their privacy guarantees.
