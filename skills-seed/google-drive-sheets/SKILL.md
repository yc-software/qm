---
name: google-drive-sheets
description: Find, read, export, edit, and manage the user's Google Drive, Docs, Sheets, and Slides through per-user OAuth.
requiredCapabilities:
  - egress:www.googleapis.com
  - egress:sheets.googleapis.com
  - egress:docs.googleapis.com
  - egress:slides.googleapis.com
---

# Google Drive / Docs / Sheets / Slides

Use this skill when the user asks about Drive files, Google Docs, Google Sheets, Google
Slides, sharing/access problems, or reading/editing any of that content.

This is an OAuth connector. The resolved user's Google OAuth token already lives on
your computer as an environment variable, one per Google API host (the way a logged-in
CLI's cached credential would):

- `$VAULT_TOKEN_WWW_GOOGLEAPIS_COM` — for `www.googleapis.com` (Drive)
- `$VAULT_TOKEN_SHEETS_GOOGLEAPIS_COM` — for `sheets.googleapis.com` (Sheets)
- `$VAULT_TOKEN_DOCS_GOOGLEAPIS_COM` — for `docs.googleapis.com` (Docs)
- `$VAULT_TOKEN_SLIDES_GOOGLEAPIS_COM` — for `slides.googleapis.com` (Slides)

These all carry the **same** Google token (one OAuth grant spans every Google API), so
if a host-specific var is empty (e.g. an older connection made before that host was
added), `$VAULT_TOKEN_WWW_GOOGLEAPIS_COM` works as the bearer for any Google API host.

Call the Google APIs directly over `https://` with `curl` and pass the matching token
as a bearer header (`-H "Authorization: Bearer $VAULT_TOKEN_..."`). Do not ask the user
for a token, log it, or use another principal's credential or a service fallback.

If the variable is empty or the API returns 401/403 or a file is inaccessible, tell the
user which Google account/principal needs access and whether they should connect Google
or share the file with that account.

## Find files

Search Drive by name, owner, MIME type, or recency:

```bash
curl -sS --get 'https://www.googleapis.com/drive/v3/files' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM" \
  --data-urlencode "q=name contains 'deadline' and trashed=false" \
  --data-urlencode 'fields=nextPageToken,files(id,name,mimeType,webViewLink,owners(emailAddress,displayName),modifiedTime)' \
  --data-urlencode 'corpora=allDrives' \
  --data-urlencode 'includeItemsFromAllDrives=true' \
  --data-urlencode 'supportsAllDrives=true' \
  --data-urlencode 'pageSize=100'
```

The three `allDrives` params matter: without them the API searches only "My Drive",
and files living in shared drives — most team docs — are invisible, so you'd wrongly
report a file doesn't exist. If the response has a `nextPageToken`, keep fetching with
`pageToken=` before concluding anything is missing.

For a specific file, fetch metadata first:

```bash
curl -sS 'https://www.googleapis.com/drive/v3/files/FILE_ID?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,owners(emailAddress,displayName),capabilities' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM"
```

Add `supportsAllDrives=true` to every per-file call (get, download, PATCH, DELETE) —
without it, operations on shared-drive files 404.

## Read files

For uploaded files, download media:

```bash
curl -sS 'https://www.googleapis.com/drive/v3/files/FILE_ID?alt=media' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM" \
  -o inbox/drive-file.bin
```

For Google Docs/Sheets/Slides, export to a useful format:

```bash
curl -sS --get 'https://www.googleapis.com/drive/v3/files/FILE_ID/export' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM" \
  --data-urlencode 'mimeType=text/plain'
```

Keep source file ids and links in your answer so claims can be traced.

## Read Sheets

Read values from a named range:

```bash
curl -sS 'https://sheets.googleapis.com/v4/spreadsheets/SPREADSHEET_ID/values/Sheet1!A1:Z100' \
  -H "Authorization: Bearer $VAULT_TOKEN_SHEETS_GOOGLEAPIS_COM"
```

For workbook structure:

```bash
curl -sS 'https://sheets.googleapis.com/v4/spreadsheets/SPREADSHEET_ID?includeGridData=false' \
  -H "Authorization: Bearer $VAULT_TOKEN_SHEETS_GOOGLEAPIS_COM"
```

## Writes require approval

Creating, moving, sharing, or editing Drive/Sheets content is a write. Prepare the exact
change, summarize the target file/range, and ask for approval before running it.

After approval, update values:

```bash
curl -sS -X PUT 'https://sheets.googleapis.com/v4/spreadsheets/SPREADSHEET_ID/values/Sheet1!A1:B2?valueInputOption=USER_ENTERED' \
  -H "Authorization: Bearer $VAULT_TOKEN_SHEETS_GOOGLEAPIS_COM" \
  -H 'content-type: application/json' \
  --data @values.json
```

Always report the file id/link and the modified range.

## Persist a file to Drive (upload)

You can save a file you produced (a report, an export, an outbox artifact) into the
user's Drive. This is a write — summarize what you're uploading and where, and get
approval first.

After approval, multipart-upload the bytes. Send the metadata part then the file part:

```bash
curl -sS -X POST 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM" \
  -F "metadata={\"name\":\"report.pdf\"};type=application/json;charset=UTF-8" \
  -F "file=@outbox/report.pdf;type=application/pdf"
```

To place it in a specific folder, add `"parents":["FOLDER_ID"]` to the metadata. The
response returns the new file's `id` and `webViewLink` — report both so the user can open
it.

## Rename, move, or delete files

The connector has full Drive access, so you can rename, move, and delete any file the
connected user can reach — including pre-existing files in shared folders, not just ones
this connector created. These are destructive writes: name the exact file (id + name) and
the change, and get approval first. Deletes are especially irreversible — prefer trashing
(`trashed=true`) over permanent `DELETE` unless the user asks to purge.

Rename a file:

```bash
curl -sS -X PATCH 'https://www.googleapis.com/drive/v3/files/FILE_ID?fields=id,name' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM" \
  -H 'content-type: application/json' \
  --data '{"name":"new-name.pdf"}'
```

Move a file (swap its parent folder):

```bash
curl -sS -X PATCH 'https://www.googleapis.com/drive/v3/files/FILE_ID?addParents=DEST_FOLDER_ID&removeParents=OLD_FOLDER_ID&fields=id,parents' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM"
```

Trash a file (reversible) or permanently delete it:

```bash
curl -sS -X PATCH 'https://www.googleapis.com/drive/v3/files/FILE_ID?fields=id,trashed' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM" \
  -H 'content-type: application/json' \
  --data '{"trashed":true}'

curl -sS -X DELETE 'https://www.googleapis.com/drive/v3/files/FILE_ID' \
  -H "Authorization: Bearer $VAULT_TOKEN_WWW_GOOGLEAPIS_COM"
```

Report the file id/link and what changed.

## Edit a Google Doc

Editing a Doc's content uses the Docs API (`docs.googleapis.com`), not the Drive export
endpoint (export is read-only). First read the document to find the character indexes you
want to edit:

```bash
curl -sS 'https://docs.googleapis.com/v1/documents/DOCUMENT_ID' \
  -H "Authorization: Bearer $VAULT_TOKEN_DOCS_GOOGLEAPIS_COM"
```

The response's `body.content[]` carries each element's `startIndex`/`endIndex` — use those
to target an edit. All edits go through `:batchUpdate`. This is a write — summarize the
exact change and get approval first. Insert text at an index:

```bash
curl -sS -X POST 'https://docs.googleapis.com/v1/documents/DOCUMENT_ID:batchUpdate' \
  -H "Authorization: Bearer $VAULT_TOKEN_DOCS_GOOGLEAPIS_COM" \
  -H 'content-type: application/json' \
  --data '{"requests":[{"insertText":{"location":{"index":1},"text":"Hello\n"}}]}'
```

Other common requests in the same `requests[]` array: `deleteContentRange`
(`{"range":{"startIndex":N,"endIndex":M}}`), `replaceAllText`
(`{"containsText":{"text":"OLD","matchCase":true},"replaceText":"NEW"}`), and
`insertInlineImage`. Create a new doc with `POST https://docs.googleapis.com/v1/documents`
and a `{"title":"..."}` body. Report the document id/link and what changed.

## Edit a Google Slides presentation

Slides editing uses the Slides API (`slides.googleapis.com`). Read the deck to find slide
and element object ids:

```bash
curl -sS 'https://slides.googleapis.com/v1/presentations/PRESENTATION_ID' \
  -H "Authorization: Bearer $VAULT_TOKEN_SLIDES_GOOGLEAPIS_COM"
```

Edits go through `:batchUpdate`. Get approval first, then e.g. replace text across the deck:

```bash
curl -sS -X POST 'https://slides.googleapis.com/v1/presentations/PRESENTATION_ID:batchUpdate' \
  -H "Authorization: Bearer $VAULT_TOKEN_SLIDES_GOOGLEAPIS_COM" \
  -H 'content-type: application/json' \
  --data '{"requests":[{"replaceAllText":{"containsText":{"text":"{{TITLE}}","matchCase":true},"replaceText":"Q3 Review"}}]}'
```

Other common requests: `createSlide`, `insertText` (`{"objectId":"...","text":"...","insertionIndex":0}`),
and `createImage`. Create a new deck with `POST https://slides.googleapis.com/v1/presentations`
and a `{"title":"..."}` body. Report the presentation id/link and what changed.
