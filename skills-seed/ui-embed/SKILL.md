---
name: ui-embed
description: Embed a live web page (a published app, dashboard, doc, video or map) inline in your web chat reply by writing an ```embed block with its URL. Use when seeing the page in the conversation beats a link.
---

# ui-embed: inline iframes in web replies

Write a fenced block with the language `embed`, the page URL on the first line, and
optionally a height in pixels (120–2000, default 420):

````md
```embed
https://www.youtube.com/embed/<id>
height=360
```
````

In the QM web UI, the person's always-on canvas swaps each such block in your messages
for a sandboxed iframe with an open-in-new-tab link once the message finishes. Elsewhere
(Slack, email) the block shows as plain text, so outside the web UI send a link instead.

**Once per person:** the swap needs the embed script on their always-on canvas (the
`ui-canvas` requirements apply). Run `node scripts/install.mjs` from this skill's
directory in a web turn. It exits 0 if the script is already there. Exit 3 means their
always-on canvas holds something else; ask before rerunning with `--replace`. If they
close the always-on canvas, the blocks go back to plain text.

What embeds:

- Only https URLs, with no credentials in them, and never QM's own origin. Other blocks
  are left as text.
- The page must allow framing. Most big sites refuse (`curl -sI <url>` shows
  `X-Frame-Options` or a restrictive `frame-ancestors`); use their embed URLs (YouTube
  `/embed/<id>`, Google Maps `/maps/embed?...`, Figma, Loom) or send a link.
- For apps you publish, set `embedAncestors` to the QM web origin. Sandbox ports are
  unreachable from their browser, so publish first.
- The frame is sandboxed in its own origin with the person's cookies for that site. It
  cannot navigate or read the QM tab.
