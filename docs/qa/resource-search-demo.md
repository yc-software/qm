# Cmd+K resource search demo

Build two self-contained HTML demos without starting the application:

```sh
npm ci
npm --prefix plugins/web-ui ci
node docs/qa/resource-search-demo.mjs
open /tmp/qm-resource-search-demo/resource-search-after.html
```

The files include all scripts and styles and work directly from disk. The Before and After links switch between the original chat-only palette and the current palette. Search for `release`, `dashboard`, or `digest`; use arrow keys and Enter, or click a result. Escape closes the palette; the Open search button reopens it.

The demo bundles the real search component, shared result formatting, icons, and palette CSS. Synthetic responses provide a release-review skill, weekly release digest cron, release dashboard app, release planning project, and a release-readiness conversation. API calls, session access, relative recency, and navigation are mocked; selecting a resource displays its destination instead of opening the application. Asking QM displays a local status message. No backend or network access is involved.

The default before source is commit `e0966ba8`. Optional arguments choose the output directory and before revision:

```sh
node docs/qa/resource-search-demo.mjs /tmp/search-review e0966ba8
```

For the PR, link this document and attach the generated HTML pair if the review host allows HTML attachments. The generated bundles stay outside Git. DOM checks verified four resource results plus a conversation, before/after differences, and resource navigation. Browser verification confirmed the rendered demo and Enter navigation to `/skills/demo-skill`.
