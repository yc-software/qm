---
name: dropbox
description: Browse, search, read, upload, and share the user's Dropbox — including team/shared folders — through per-user OAuth.
requiredCapabilities:
  - egress:api.dropboxapi.com
  - egress:content.dropboxapi.com
---

# Dropbox

Use this skill when the user asks about their Dropbox files or folders — listing,
searching, reading/downloading, uploading, or sharing.

This is an OAuth connector. The resolved user's Dropbox token already lives on your
computer as an environment variable, one per Dropbox API host (the way a logged-in CLI's
cached credential would):

- `$VAULT_TOKEN_API_DROPBOXAPI_COM` — for `api.dropboxapi.com` (RPC: list, search, share, move, delete)
- `$VAULT_TOKEN_CONTENT_DROPBOXAPI_COM` — for `content.dropboxapi.com` (download, upload)

Both carry the **same** Dropbox token (one OAuth grant spans every host), so if a
host-specific var is empty, `$VAULT_TOKEN_API_DROPBOXAPI_COM` works as the bearer for any
Dropbox host. Pass it as `-H "Authorization: Bearer $VAULT_TOKEN_..."`. Never ask the user
for a token, log it, or use another principal's credential or a service fallback.

If `$VAULT_TOKEN_API_DROPBOXAPI_COM` is **empty**: per-user connector tokens are injected
only in a **direct DM** with the user (their personal scope) — in a channel or group
they're absent by design, even for a fully-connected user. So don't tell a channel user to
reconnect; ask them to DM you to run this. Only if it's empty inside a DM does it mean they
haven't connected Dropbox — then point them to the Connectors page.

On **401**: the token is expired/invalid → have them reconnect — _unless_ the error body's
`.tag` is `missing_scope`, in which case the app lacks a permission; name the `required_scope`
it returns (the connected app grants account_info.read, files.metadata.read,
files.content.read/write, sharing.read/write).

## First: pick the right namespace (team vs personal)

**This is the step that makes team and shared folders visible.** By default the Dropbox
API only lists the user's _personal_ (home) namespace — for a Business member that root
is often nearly empty. The team folders they see in the Dropbox web UI live in the
_team_ namespace, and the API only shows them when you set the `Dropbox-API-Path-Root`
header.

Resolve the account's namespaces once, then reuse the `root_namespace_id` for the rest of
the session — it doesn't change. This endpoint takes no arguments: send **no request body
and no `Content-Type`** (adding `Content-Type: application/json` with an empty body returns
a 400):

```bash
curl -sS -X POST 'https://api.dropboxapi.com/2/users/get_current_account' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_DROPBOXAPI_COM"
```

Read `root_info` from the response. If `root_info[".tag"]` is `team`, use its
`root_namespace_id` to see everything (team folders + the member's own files); if it is
`user` (individual account), the default root is fine and no header is needed.

When you have a `root_namespace_id`, add this header to **every** files/sharing call so
your view matches the web UI (substitute the id):

```
-H 'Dropbox-API-Path-Root: {".tag":"root","root":"ROOT_NAMESPACE_ID"}'
```

Prefer referencing items by **id** (`"id:..."`, returned by list/search) over path
strings — ids are stable across namespaces and avoid path-escaping issues.

## List a folder

`path` is `""` for the root of the active namespace, or a folder path/id:

```bash
curl -sS -X POST 'https://api.dropboxapi.com/2/files/list_folder' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_DROPBOXAPI_COM" \
  -H 'Dropbox-API-Path-Root: {".tag":"root","root":"ROOT_NAMESPACE_ID"}' \
  -H 'Content-Type: application/json' \
  --data '{"path":"","recursive":false}'
```

For an `ls -R`-style or find-across-a-tree request, set `"recursive":true` to stream the
whole subtree in one paginated pass instead of walking folder by folder.

If the response has `"has_more":true`, page with the returned `cursor`:

```bash
curl -sS -X POST 'https://api.dropboxapi.com/2/files/list_folder/continue' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_DROPBOXAPI_COM" \
  -H 'Content-Type: application/json' \
  --data '{"cursor":"CURSOR"}'
```

## Search

```bash
curl -sS -X POST 'https://api.dropboxapi.com/2/files/search_v2' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_DROPBOXAPI_COM" \
  -H 'Dropbox-API-Path-Root: {".tag":"root","root":"ROOT_NAMESPACE_ID"}' \
  -H 'Content-Type: application/json' \
  --data '{"query":"budget","options":{"max_results":100}}'
```

If the response has `"has_more": true`, keep fetching with its `cursor` via
`files/search/continue_v2` (same shape as `list_folder/continue` above) before
concluding a file doesn't exist.

## Read / download a file

Downloads use the content host and carry their argument in the `Dropbox-API-Arg` header
(no JSON body). Reference the file by id or path:

```bash
curl -sS -X POST 'https://content.dropboxapi.com/2/files/download' \
  -H "Authorization: Bearer $VAULT_TOKEN_CONTENT_DROPBOXAPI_COM" \
  -H 'Dropbox-API-Path-Root: {".tag":"root","root":"ROOT_NAMESPACE_ID"}' \
  -H 'Dropbox-API-Arg: {"path":"id:FILE_ID"}' \
  -o inbox/dropbox-file.bin
```

Keep source paths/ids in your answer so claims can be traced.

## Writes require approval

Uploading, sharing, moving, and deleting are writes. Prepare the exact change, name the
target file/folder (id + path), and get approval before running it.

Upload bytes you produced (content host; the arg is a header, the file is the body):

```bash
curl -sS -X POST 'https://content.dropboxapi.com/2/files/upload' \
  -H "Authorization: Bearer $VAULT_TOKEN_CONTENT_DROPBOXAPI_COM" \
  -H 'Dropbox-API-Path-Root: {".tag":"root","root":"ROOT_NAMESPACE_ID"}' \
  -H 'Dropbox-API-Arg: {"path":"/Reports/q3.pdf","mode":"add","autorename":true}' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @outbox/q3.pdf
```

Create a shared link (returns a `url`; a 409 `shared_link_already_exists` carries the
existing link in its metadata — reuse it):

```bash
curl -sS -X POST 'https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_DROPBOXAPI_COM" \
  -H 'Dropbox-API-Path-Root: {".tag":"root","root":"ROOT_NAMESPACE_ID"}' \
  -H 'Content-Type: application/json' \
  --data '{"path":"id:FILE_ID"}'
```

Move/rename or delete (delete_v2 is recoverable — the file goes to the user's deleted
files, not a permanent purge):

```bash
curl -sS -X POST 'https://api.dropboxapi.com/2/files/move_v2' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_DROPBOXAPI_COM" \
  -H 'Dropbox-API-Path-Root: {".tag":"root","root":"ROOT_NAMESPACE_ID"}' \
  -H 'Content-Type: application/json' \
  --data '{"from_path":"id:FILE_ID","to_path":"/Archive/q3.pdf"}'

curl -sS -X POST 'https://api.dropboxapi.com/2/files/delete_v2' \
  -H "Authorization: Bearer $VAULT_TOKEN_API_DROPBOXAPI_COM" \
  -H 'Dropbox-API-Path-Root: {".tag":"root","root":"ROOT_NAMESPACE_ID"}' \
  -H 'Content-Type: application/json' \
  --data '{"path":"id:FILE_ID"}'
```

Always report the file path/id and what changed, plus any shared link you created.
