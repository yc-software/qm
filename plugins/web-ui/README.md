# Web UI plugin

An end-user web surface with a custom ChatGPT/Claude-style chat shell, stitched to the
platform core. It still uses Pi's `Agent` state machine and selected Pi web utilities
for markdown, attachment loading, and model metadata, but the visible conversation UI is
owned by this plugin. Two processes:

- **A zero-dep `node:http` server** (`server/index.ts`) — holds the signed-in principal
  in an `HttpOnly` cookie, injects it as the turn's actor, and proxies a small set of
  `/api/*` routes to the core (chat turns, unified history, and **webhook management** —
  see below). It never imports the core and never sends a model/API key to the browser.
- **A Vite-bundled front-end** (`src/`) — a custom Lit shell + transcript + composer.
  Pi's `Agent` LLM-call boundary (`streamFn`) is swapped for a bridge to the core.
  It `POST`s the turn (`POST /v1/turns?async=1`), then watches the in-flight reply over
  **SSE** (`GET /api/runs/:id/events`, relayed from the core's `partial`) so tokens are
  pushed as they arrive instead of discovered on the next poll tick. It falls back to
  polling `GET /api/runs/:id` where SSE can't be established (old/proxy-hostile
  environments). The real agent loop (model + the three primitives + memory + audit) runs
  server-side in the core's sandbox; the browser is a thin chat client.

**Behind the portal.** When fronted by `plugins/portal` (the public SSO front door), this SPA
is served at the portal root — the default `WEB_UI_BASE=/` build is the one the portal fronts
(the old `/web-ui/` prefix is gone; the portal 308-redirects `/web-ui/*` to root for stale
links). The front-end joins its base via `import.meta.env.BASE_URL` (the `withBase()` helper in
`core-bridge.ts`), so direct/standalone access and `npm run dev` behave identically.
Core binds run reads and signals to the portal-verified actor;
no run bearer is exposed to browser code or placed in a URL. The active-run resume index
(`/api/runs/active`) is per-process best-effort with a durable core fallback for personal threads.

```
npm install
npm run build
npm run serve

npm start
```

Dev (HMR): run `npm run serve` in one terminal and `npm run dev` in another — Vite serves
the front-end on :5173 and proxies `/signin`, `/me`, `/api/*` to the node server.

Env (see `.env.example`): `CORE_API_URL` (default `http://localhost:8080`),
`CORE_ORG_ID` (default `acme`), `PORT` (default 8096), `WEB_UI_PUBLIC_URL`,
`WEB_UI_PRINCIPALS` (csv allowlist; empty = any id, **dev only**),
and `CORE_SIGNING_SECRET` (same value as the core when source-auth is enabled).

## What you get

- **Custom chat UI** — a first-party conversation surface with a left history rail, centered
  transcript, bottom composer, inline **model selector** (the models core reports as
  serviceable for the approved harnesses),
  explicit **effort selector** (`low|medium|high|xhigh|max|ultracode|auto`), **Fast mode**
  toggle, attachments, streaming partials, and a theme toggle.
  The UI drives Pi's `Agent` with a custom `streamFn` (`src/core-bridge.ts`) instead of
  mounting Pi's stock `AgentInterface`.
- **Slash-command skill picker** — type `/` at the start of the composer for a Codex-style
  autofill of the **skills** available to you (B6): icon · name · description · scope, with the
  typed letters emboldened. Arrow/Tab/Enter to choose (it inserts `/<name> `), Esc/click-out to
  dismiss. The list is the signed-in principal's _visible_ skills — the same set the agent gets
  materialized into a DM turn — fetched once per session via the server's `/api/skills` proxy
  (→ core `GET /v1/skills?principalId=`, resolved by `app.listVisibleSkills`). The skill _body_
  never reaches the browser; only name/description/scope do.
- **Functional selectors** — the chosen model + effort + Fast mode ride along on each turn
  (`POST /v1/turns` `model`/`thinkingLevel`/`fastMode`); the Pi harness applies them
  server-side, bypassing Pi's stale thinking-level clamp for newer effort values and falling
  back to its default on any unknown value. Attachments are forwarded as `IncomingAttachment`s
  and materialized into the agent's sandbox inbox (same path as Slack file shares).
- **Unified history** — every session you participated in (DMs, channels, web), via
  `GET /v1/sessions?principalId=`. The same person sees the same history here and in Slack
  (surface-independence, spec B6).
- **Continue web DMs** — threads originated here (`threadRef` = `web:…`) are continuable.
- **Contexts** (the **Contexts** sidebar view) — one card per scope the signed-in person can
  talk to the agent in: their `personal:` scope plus every channel/group context (each context
  is a separate workspace — own files, own memory). `GET /api/contexts` → core
  `GET /v1/contexts?principalId=` (personal + channels the pre-pushed directory membership
  places the principal in + any shared scope their own sessions place them in — assembled
  entirely from core-local data, never a live Slack call). Opening a context shows its conversations and
  a **New chat** that starts a _web_ conversation inside that shared workspace: the turn carries
  `scopeId` (+ `channelName` for the session label), the server maps it onto
  `conversation {kind: channel|group, channelRef}`, and **core re-authorizes membership**
  (pre-pushed channel membership, or prior participation in the scope's sessions — deliberately
  stricter than the cron-create "any internal may post to a public channel" rule: a post is
  visible to the channel, mounting its workspace from the web is not). The web-ui never vouches for
  membership — it only shapes the claim. Such chats are continuable like any web thread and show
  a floating pill naming the shared context; replies stay on the web (nothing is posted to
  Slack).
- **Deep links** — the address bar always identifies the open conversation (`?session=<id>`)
  or view (`?view=…`), kept in sync via `replaceState`; each conversation's ⋯ menu has a
  **Copy link**. Opening a link while signed out keeps the query string through sign-in, so
  shared links land in the right conversation (subject to the recipient's own access).
- **Read Slack & group/channel sessions** — they render **read-only** (transcript only, no
  composer). One-way projection: a web reply would be invisible to Slack participants, so
  contributing to those Slack threads from the web isn't allowed yet (spec B6) — start a fresh
  web chat in the same context from the **Contexts** page instead. In the sidebar these read-only rows sit
  visibly recessed (a shade darker/dimmer) and carry the Slack mark plus the channel they live in
  (for example, `#engineering`) — the channel name is captured from the surface onto the session record
  (`Session.channelName`, plumbed `conversation.channelName` → `getOrCreateByThread`) and surfaced
  via `GET /v1/sessions`, so you recognize _where_ a conversation happened at a glance.
- **Webhook management** (the **Webhooks** sidebar view) — register, list, and disable your
  own incoming webhooks (spec §7). Each registration is created with `owner = createdBy = you`
  in your `personal:<you>` scope (identity comes from the cookie, **never** the request body —
  the same trust model as `/api/turn`). The server proxies three routes:
  - `POST /api/webhooks` → core `POST /v1/webhooks`; relays core's response — the webhook, the
    **absolute** public ingress URL (core builds it from its public base — the portal in prod),
    and the signing secret **once** (auto-generated if you leave it blank; never shown again).
  - `GET /api/webhooks` → core `GET /v1/webhooks`, then **filtered to `owner === you`** (core's
    source-auth list is operator-wide; secrets are already elided by the core).
  - `POST /api/webhooks/:id/disable` → ownership is **verified here first** (core's operator
    disable has no ownership check), mirroring the run-ownership gate, then proxied.
    The inbound ingress (`POST /v1/webhooks/incoming/:id`) is served by the **core** receiver,
    reached in prod through the **portal**'s one unauthenticated passthrough (the core is not
    publicly exposed); senders sign with their own per-webhook secret, which is the auth on that
    path. Dev single-host posts to the core directly.
- **Cron management** (the **Crons** sidebar view) — create, list, run-now, enable/disable, and
  delete your own scheduled tasks (spec §7), same trust model as webhooks: created with
  `owner = createdBy = you` in your `personal:<you>` scope (identity from the cookie, never the
  body), list filtered to `owner === you`, and every per-cron route ownership-gated here first
  (core's source-auth routes are operator-wide). A cron is either a **task** (a prompt the agent
  re-runs at each fire) or a **message** (literal text relayed as-is — requires a destination,
  since a relay with nowhere to deliver is a no-op), on an `everyMs` interval and/or a one-time
  `firstFireAt`. The server enforces a 1-minute interval floor; the scheduler itself runs in the
  core.
- **Files / Connectors / Deploys** (sidebar views — management lives here in one place):
  - **Files** — the doc store (spec §19 `artifacts(kind=file)`; §3 "files & sharing =
    Google Docs"): one `GET /api/files` call (→ core `GET /v1/files?viewer=`) lists files you
    **created/uploaded** (owned) + files **shared with you**, recency-sorted, with Open/Download
    (`GET /api/files/:id/content`, streamed binary). Image files (`image/*`) show an inline
    thumbnail rendered straight from that same `/content` stream. Backed by a durable, owner-scoped registry —
    NOT a transcript scan. Delivered/uploaded files are owned at the initiator's personal scope so
    they surface here, and auto-shared with the conversation (ADR-0003 D2/D4): a public-channel file
    gets an `org:` read grant so every member sees it under "Shared with you"; private-channel
    per-member grants are sequencing-gated (off until enabled), so those stay owner-only until then.
  - **Connectors** — per-provider OAuth status with Connect / Reconnect / Disconnect. The server
    proxies `GET /api/connectors` → core `/v1/connectors/oauth/status`, `POST /api/connectors/:p/start`
    → core `/v1/connectors/oauth/:p/start` (redirect URI = this surface's
    `/connectors/oauth/:p/callback`), and `POST /api/connectors/revoke` → core
    `/v1/connectors/oauth/revoke`. The callback exchanges the code server-side (tokens never reach
    the browser) and bounces back into the SPA via a base-relative redirect.
  - **Deploys** — `GET /api/deployments` → core `/v1/deployments`, grouped into manageable,
    shared, and archived views. Detail and restore routes expose authorized metadata and bring an
    archived version back online; running apps open through the surface's signed deployment proxy.

## Notes

- **No browser-side model keys.** The real agent loop (model +
  the three primitives + memory + audit) runs server-side in the core's sandbox. The model
  picker only expresses a _preference_ the core honors within its policy floor — keys, egress,
  and tools stay server-side.
- Pi's client-side artifacts / JavaScript REPL are not enabled (tools run server-side).
- The custom transcript renders from Pi `Agent` lifecycle events and `waitForIdle()`, so
  in-place streaming mutations are reflected without depending on Pi's stock chat renderer.

This is a **surface plugin**: it carries its own front-end deps (Vite, lit, pi-web-ui) and
runs as a separate process. The zero-runtime-dep core is untouched.
