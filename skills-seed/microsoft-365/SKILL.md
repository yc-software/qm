---
name: microsoft-365
description: Read, search, draft, and send the user's Outlook mail and browse, read, upload, and share their OneDrive and SharePoint files through their own Microsoft 365 connection.
requiredCapabilities:
  - egress:graph.microsoft.com
---

# Microsoft 365 (Outlook mail and OneDrive)

Use this skill when the user asks about their Outlook email (inbox, searching, reading,
drafting, replying, sending) or their OneDrive / SharePoint files (listing, searching,
reading, uploading, sharing).

## Connection

`$VAULT_TOKEN_GRAPH_MICROSOFT_COM` holds the user's Microsoft Graph token. Pass it as
`-H "Authorization: Bearer $VAULT_TOKEN_GRAPH_MICROSOFT_COM"` on every call; nothing on the
network path adds it for you. Everything goes to `https://graph.microsoft.com/v1.0`.

Never ask the user for a token, log it, or use another principal's.

Per-user connector tokens are injected only in a direct conversation with the user (a DM or
web chat). If the variable is empty in a channel or group chat, ask them to DM you. If it is
empty in a DM, they haven't connected Microsoft 365: point them to the Connectors page.
People who sign in to QM with Microsoft are usually connected already.

A `401` means the token was rejected: have them reconnect. A `403` naming a permission means
the app registration lacks it (the connector asks for `Mail.ReadWrite`, `Mail.Send` and
`Files.ReadWrite.All`).

Check who is connected first when anything looks wrong:

```bash
curl -sS https://graph.microsoft.com/v1.0/me -H "Authorization: Bearer $VAULT_TOKEN_GRAPH_MICROSOFT_COM"
```

## Outlook mail

```bash
G=https://graph.microsoft.com/v1.0; A="Authorization: Bearer $VAULT_TOKEN_GRAPH_MICROSOFT_COM"
# newest inbox messages
curl -sS -G "$G/me/mailFolders/inbox/messages" -H "$A" \
  --data-urlencode '$top=15' --data-urlencode '$select=id,subject,from,receivedDateTime,isRead,bodyPreview' \
  --data-urlencode '$orderby=receivedDateTime desc'
# search (sender, subject, body); $search cannot be combined with $orderby
curl -sS -G "$G/me/messages" -H "$A" -H 'ConsistencyLevel: eventual' \
  --data-urlencode '$search="invoice"' --data-urlencode '$select=id,subject,from,receivedDateTime,bodyPreview'
# one message as plain text
curl -sS "$G/me/messages/MESSAGE_ID?\$select=subject,from,toRecipients,body" -H "$A" -H 'Prefer: outlook.body-content-type="text"'
```

Write a draft first and show it to the user before sending anything:

```bash
curl -sS -X POST "$G/me/messages" -H "$A" -H 'content-type: application/json' --data @- <<'JSON'
{"subject":"...","body":{"contentType":"Text","content":"..."},"toRecipients":[{"emailAddress":{"address":"a@b.com"}}]}
JSON
curl -sS -X POST "$G/me/messages/MESSAGE_ID/createReply" -H "$A" -H 'content-type: application/json' \
  --data '{"comment":"..."}'   # a reply draft; createReplyAll for reply-all
curl -sS -X POST "$G/me/messages/DRAFT_ID/send" -H "$A" -H 'content-length: 0'   # send only when the user says so
```

## OneDrive and SharePoint files

```bash
curl -sS "$G/me/drive/root/children?\$select=id,name,size,folder,file,lastModifiedDateTime,webUrl" -H "$A"
curl -sS "$G/me/drive/root:/Documents/Reports:/children" -H "$A"            # a folder by path
curl -sS "$G/me/drive/root/search(q='budget')?\$select=id,name,webUrl,parentReference" -H "$A"
curl -sS "$G/me/drive/sharedWithMe" -H "$A"                                 # files others shared
curl -sSL "$G/me/drive/items/ITEM_ID/content" -H "$A" -o file.bin           # download
curl -sS -X PUT "$G/me/drive/root:/Uploads/report.csv:/content" -H "$A" \
  -H 'content-type: text/csv' --data-binary @report.csv                    # upload up to 250 MB
curl -sS -X POST "$G/me/drive/items/ITEM_ID/createLink" -H "$A" -H 'content-type: application/json' \
  --data '{"type":"view","scope":"organization"}'                           # share inside the org
```

Office documents (`.docx`, `.xlsx`, `.pptx`) download as their binary format; convert with
the tools in your computer, or append `?format=pdf` to `/content` for a PDF. Lists page with
`@odata.nextLink`: follow it until it is absent.
