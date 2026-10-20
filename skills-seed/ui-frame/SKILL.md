---
name: ui-frame
description: Show a live web page — a published app, dashboard, doc, video or site — in a movable, resizable iframe window on top of the person's QM web UI. Use when they want to see or use a page alongside the chat instead of opening a link.
---

# ui-frame — iframe windows on the web UI canvas

Builds on the `ui-canvas` skill (read it first): same requirements (a web turn the person
started, `ui_canvas` enabled for them), same canvas. One script writes the canvas for you:

```sh
node scripts/frame.mjs https://example.com/page [more URLs] \
  [--title "Window title"]... [--width 960] [--height 640] [--pin] [--always-on]
```

Each URL becomes a window with a title bar the person can drag, a resize corner, and
reload, open-in-new-tab, minimize and close buttons. Up to 6 windows; titles pair with
URLs in order and default to the host name. `--pin` keeps it open across reloads;
`--always-on` puts it on their always-on canvas instead (only when they ask for it to
stay up everywhere). `--dry-run` prints the canvas JSON without writing it.

The script **replaces** this conversation's canvas. If something else is on it, say so
or save it first (`GET /v1/ui/canvas`) and restore it when the frame is done.

## What can be framed

- **https only**, no credentials in the URL, never QM's own web origin (the window
  refuses it: a same-origin frame would carry the person's session).
- **The page must allow framing.** The script fetches each URL first and stops (exit 3)
  if it sends `X-Frame-Options: DENY/SAMEORIGIN` or `frame-ancestors 'none'/'self'`;
  most big sites (GitHub, Google, Slack, X) do. Send a link instead. If it only lists
  certain origins it warns; `--force` sends anyway. Pages behind a login may answer the
  check differently from the person's browser; a warning is not proof either way.
- **Apps you published** are the best fit: republish with
  `embedAncestors: ["<QM web origin>"]` (the origin is `snapshot.url` from `ui-state`),
  then frame the app URL. Content in the sandbox needs a public URL first (an app or a
  shared file link); localhost and sandbox ports are unreachable from their browser.
- Embeddable forms of popular sites work: `https://www.youtube.com/embed/<id>`,
  `https://www.google.com/maps/embed?...`, Figma/Loom/Docs "embed" links.

The frame is sandboxed: it keeps its own origin and can run scripts, forms and popups,
but cannot navigate the QM tab or read anything from it. It sees the person's own
cookies for that site, so it shows what they would see logged in.

## Checking it

`ui-state` screenshots are DOM renders and show iframes as empty boxes; check the window
chrome and `snapshot.canvasErrors` there, and trust the preflight for the page itself. Ask
the person if it matters whether the page loaded.

Dismiss with `DELETE /v1/ui/canvas` (add `?alwaysOn=true` for that canvas) when done.
