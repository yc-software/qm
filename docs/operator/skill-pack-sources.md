# Skill pack sources

Administrators can register an HTTPS Git repository or upload an offline ZIP from
Admin → Skills. Both sources use the same skill preview, scope selection, validation,
import, and materialization pipeline. Uploading a ZIP alone does not install skills.
Open **Browse skills…**, review eligibility, select target scopes, and import.

## Offline ZIPs

A ZIP must contain at least one `SKILL.md`. A common enclosing directory is removed.
UTF-8 instructions, configuration files, scripts, and text assets are accepted.
Binary attachments, Git history, encrypted entries, links, unsafe paths, duplicate
paths, and corrupt entries are rejected. macOS metadata is ignored. The limits are
16 MiB compressed, 32 MiB expanded, and 5,000 entries.

The archive SHA-256 identifies its version. Source contents persist in the same
Postgres-backed artifact store as other skill state. No repository connection is
needed for preview, import, or an application restart.

Use **Upload new ZIP…** on an existing pack to stage a replacement. The installed
skills remain at their current version until **Apply uploaded version** refreshes
already-imported skills. New skills still require Browse. The immediately previous
selected archive is retained: **Select previous version** selects it, and applying
that version updates the installed skills. This is a one-version rollback, not a
complete archive history. Keep original ZIPs if more history is needed.

## Repository download cache

A successful repository fetch saves a durable source snapshot. Branch and tag
previews reuse it for five minutes; an explicit full commit hash remains reusable.
Preview responses include the snapshot commit, and imports from the admin UI use
that exact snapshot without downloading it again. The current and immediately
previous snapshots can satisfy a previewed import. An expired or invalidated preview
returns a conflict and must be opened again.

Manual sync and tracked synchronization request a fresh repository download.
Download failures remain visible as failures and leave installed skills intact;
previously saved source contents are not silently presented as a successful sync.
Changing the URL, ref, owner, or credential identity invalidates snapshot reuse.
Removing a pack removes its saved source snapshot.

## API

Stage ZIP bytes through the existing signed `POST /v1/blobs` endpoint. Then submit
`{ "blobId": "...", "name": "skills.zip" }` to
`POST /v1/admin/skill-packs/upload`, or
`POST /v1/admin/skill-packs/:id/upload` for an archive replacement. Both require
organization administrator access. Archives retain third-party trust by default.

`GET /v1/admin/skill-packs/:id/catalog` returns a `commit` alongside the plan.
Pass it as `expectedCommit` to the existing import endpoint to bind the import to
that preview. Legacy callers that omit it continue to request a fresh fetch.
