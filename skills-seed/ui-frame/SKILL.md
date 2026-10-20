---
name: ui-frame
description: Show a live web page — a published app, dashboard, doc or video — in a movable iframe window over the person's QM web UI. Use when they want a page alongside the chat instead of a link.
---

# ui-frame — iframe windows on the canvas

Writes this conversation's canvas (see `ui-canvas` for requirements and the canvas API),
replacing what is there:

```sh
node scripts/frame.mjs https://example.com/page [more URLs] [--title T]... [--width 960] [--height 640] [--pin]
```

Each URL becomes a window the person can drag by its title bar, resize from the corner,
open in a new tab or close. Titles pair with URLs in order. `--pin` keeps it open across
reloads.

- Only https, no credentials in the URL, never QM's own origin (the window won't load it).
- The page must allow framing. If `curl -sI <url>` shows `X-Frame-Options` or a
  `frame-ancestors` that excludes the QM origin, send a link instead. Most big sites
  refuse; their embed URLs (`youtube.com/embed/<id>`, `google.com/maps/embed?...`) work.
- For apps you publish, set `embedAncestors` to the QM web origin (`snapshot.url` from
  `ui-state`). Sandbox ports are unreachable from their browser; publish first.
- The frame runs sandboxed in its own origin with the person's cookies for that site; it
  cannot navigate or read the QM tab.

`ui-state` screenshots show iframes as blank boxes; check `canvasErrors` there and ask
the person whether the page loaded if it matters. `DELETE /v1/ui/canvas` when done.
