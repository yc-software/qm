# Web UI plugin

An end-user web surface with a custom chat shell, connected to the
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

## Suggested activities

Suggested activity generation is **on by default** when the configured harness supports
it. Set `SUGGESTED_ACTIVITIES_ENABLED=false` on core to disable generation. Optionally
set `WEB_UI_SUGGESTED_ACTIVITIES` on web to a JSON array for fixed fallback starters;
unset it as well to hide suggestions entirely. No deployment-specific activity content
is bundled into the public application.

```json
[
  {
    "id": "weekly-brief",
    "title": "Wake up to a fresh briefing",
    "prompt": "Let's set up a recurring briefing on the topics I follow.",
    "icon": "schedule"
  },
  {
    "id": "project-app",
    "title": "Build a home for my projects",
    "prompt": "Let's build a private app to keep track of my projects.",
    "icon": "app"
  }
]
```

The first three entries appear above the empty personal-chat composer with colored
icons, without a heading or expansion link. Selecting an entry fills and focuses
an editable draft; it never submits a turn. Suggestions fade and collapse while a draft
or attachment is present and do not appear in existing chats, shared contexts,
or compact pane views. Collapsed suggestions are inert and hidden from assistive
technology; reduced-motion preferences disable the transition. Dark mode uses
subdued blue-gray suggestion text. Drafts use the normal persistence path.

Each entry requires a unique lowercase alphanumeric/hyphen `id` (up to 64
characters), `title` (up to 65 characters), `prompt` (up to 1,200 characters), and
`icon` (one emoji or `yc` for the orange YC mark; legacy `schedule`, `app`, `deck`,
`people`, `calendar`, and `book` values also render as emoji). Configuration
accepts up to 12 entries and 20,000 characters. Invalid configuration fails startup
without printing its contents. Restart the web service after changing it.

The authenticated `/me` response supplies the configured fallback and whether generation is enabled.
Fixed starters are organization-wide; keep them free of personal activity or credentials.

When enabled, opening a new personal chat enrolls the user in an ordinary personal
cron named **Refresh my suggested activities**. Its first run starts immediately;
subsequent runs happen around 2am in the browser's timezone, with the minute
staggered by user. The cron runner uses the normal owner-scoped session, runtime
selection, memory, history, tools, and authorized data access. It has no delivery
destination. The standing task in `src/suggestions/activities.ts` asks it to research
relevant context, avoid mutations or notifications, and return three validated
activity objects. Draft prompts use a natural, collaborative voice, such as "Let's...",
with relevant facts and uncertainties as neutral context, without attributing knowledge,
feelings, or beliefs to the user. They preserve explicit user
preferences and scope while leaving the approach to the responding agent. It does not
create a separate reduced-context model call.

The UI reads the latest valid result from the cron's completed personal session,
including responses larger than the truncated fire-log preview. It displays the
previous result while a refresh runs and briefly polls for the first/new result;
opening another chat does not normally invoke a model. Failed initial generations
can retry after five minutes. Existing cron queueing, run persistence, authorization,
fire history, and failure handling apply.

Cadence is reevaluated hourly. Ten or more user messages in sampled recent private
conversations within 24 hours increases refreshes to every four hours; otherwise it
returns to nightly. Accounts with no observed conversation activity or suggestion
visits for 30 days are paused until activity returns. The owner can pause, delete,
or edit the cron; custom task text and schedules are preserved. The global disable
flag pauses managed jobs. Background work must also be enabled.

Set `SUGGESTED_ACTIVITIES_CONTEXT` on core for rollout guidance (up to 8,000
characters). For a YC rollout, describe WaaS sourcing, investor CRM, deck review,
office hours, and Bookface advice there; optionally provide fallback starters on web.
Guidance updates propagate to unmodified managed tasks. Public QM has no YC context
by default. Suggestions are private to their owner; generated sessions use the
same scoped access controls as other personal work.

## On a phone

Below 860px the same build behaves like an app rather than a shrunken desktop:

- **Drawer, not rail.** The sidebar slides over the content from a floating menu button (or an
  edge swipe); a leftward swipe or a tap on the scrim closes it. Every top bar reserves the
  button's column so nothing renders under it.
- **Bottom sheets.** Popover menus — composer settings, a session's ⋯, the user menu, the
  per-session tools — render as sheets with a backdrop; tap outside or swipe down to dismiss.
- **Compact composer.** Attach · input · settings · send on one row; model, harness, effort, and
  Fast live in the settings sheet. Inputs are 16px so iOS never zooms on focus, and the layout
  tracks the visual viewport so the composer stays above the on-screen keyboard.
- **Touch targets.** Message actions, file chips, selects, drawer rows, approvals, and back
  links are ≥44px; hover tooltips are suppressed on hoverless devices.
- **Split canvas stays on the desk.** A phone never mounts the split layout and leaves the
  persisted desktop layout untouched.
- **Installable.** `manifest.webmanifest` (named after the org's brand label), home-screen
  icons, Apple meta, and theme colors — "Add to Home Screen" opens standalone at `/`.

The phone-class breakpoint is one constant (`src/viewport.ts`, `PHONE_MAX_WIDTH`), shared by
the CSS media queries, the composer, and the split canvas.

## What you get

- **Custom chat UI** — a first-party conversation surface with a left history rail, centered
  transcript, bottom composer, inline **model selector** (the models core reports as
  serviceable for the approved harnesses),
  explicit **effort selector** (`low|medium|high|xhigh|max|ultracode|auto`), **Fast mode**
  toggle, attachments, streaming partials, and a theme picker. Settings → Theme takes
  light, dark, or system, or an imported palette: drop in an iTerm2 `.itermcolors` preset or
  a VS Code color theme `.json` and the app repaints from it (background, text, sidebar,
  buttons, links, text selection, status badges, and code highlighting, mapped from the
  terminal's ANSI colours or the theme's token scopes). The palette is kept per browser
  alongside the light/dark choice.
  The UI drives Pi's `Agent` with a custom `streamFn` (`src/core-bridge.ts`) instead of
  mounting Pi's stock `AgentInterface`.
- **Slash-command skill picker** — type `/` at the start of the composer to browse the
  **skills** available to you (B6): icon · name · description · scope, with the
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
  `firstFireAt` (which may not be in the past). The server enforces a 1-minute interval floor; the
  scheduler itself runs in the core.
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

## Chat connection chips

Chat authorization links share the connector service logos. Composio links use recognized
service names in their Markdown labels; unknown or ambiguous names keep a generic icon.
The destination URL and authorization behavior do not depend on the inferred logo.
Gmail, Google Calendar, Google Drive, and Google Sheets artwork comes from
[Simple Icons v16.0.0](https://github.com/simple-icons/simple-icons/tree/16.0.0)
(CC0) and is bundled locally with the existing connector SVG artwork.

## Cohort welcome and app picker

Set `WEB_UI_WELCOME_COHORT=F26` on the web surface to show the cohort welcome in a new user's empty chat. It replaces the automatic first agent turn for that deployment; ordinary chat starts when the user sends a message. The greeting uses the signed-in display name. The welcome remains above the messages in the earliest personal web conversation, including when reopened. It is selected from persisted session creation times. The champagne and soft flutter sequence replays on refresh only before the first message and respects reduced motion.

The picker reads Composio's live catalog in usage order, omits apps that need no authorization, and searches the complete paginated catalog. Known services use local logos; remaining catalog logos use Composio's logo host. Selecting an app submits to the authenticated web surface and opens the provider's authorization link directly. Consent remains on the provider page. The Slack action opens the existing administrator setup page.

The core bridge accepts a verified portal identity and uses either that person's own `COMPOSIO_API_KEY` keychain entry or an enabled org service credential granted to them. Secrets never enter the browser. The agent skill reads `/v1/composio/identity` to use the same organization/person identity as the picker. A company project key retains Composio's existing project-wide access boundary; the identity selects accounts and does not isolate them from other holders of that key.

### Local connection-return preview

Open `http://localhost:8138/?connectionDemo=1` on the local dev instance. This loopback-only UI mode replaces app authorization with a provider simulation offering approval, cancellation, and failure. It makes a full navigation round trip with a callback URL, attempt nonce, status, and connected-account ID. The simulated verifier checks its own record rather than trusting `status=success` in the URL.

Session storage retains the account-scoped attempt for twenty minutes, picker query, expanded state, scroll position, and simulated connections. Returning skips the welcome animation, verifies the simulated result, clears callback parameters, and restores the picker. Reset clears the preview's simulated connections. No provider authorization, tokens, or actual connected accounts are changed by this mode.

Real authorization supplies a callback URL on the configured public origin and returns to the same conversation. A twenty-minute, user-bound session-storage attempt retains the account ID, originating widget, search, expanded state, and scroll position. The server lists only the authenticated actor’s active connected accounts; the browser verifies the expected account before showing success and removes callback parameters. Connected apps are refreshed on page load and window focus. Returning skips the welcome animation. Reply widgets become available after the reply is persisted. The loopback preview remains a separate simulation and does not connect real accounts.

The welcome uses the organization's configured branding `orgName`, falling back to “your company” when it is unavailable.

### Setup widgets in agent replies

In web chat, an assistant reply can include `::connect-apps{}` as a standalone paragraph to render the reusable app picker. The separate `::add-to-slack{}` directive renders the Slack setup action for administrators; include both to show both. It omits the welcome and animation and uses the signed-in viewer’s authorization routes. The Composio skill teaches this response for requests to connect apps or reopen setup. Code blocks, quotations, and inline examples remain ordinary text. The directive persists in the transcript and renders again when reopened. Connected-account status retains the same limitations as the onboarding picker and local return-flow preview.
