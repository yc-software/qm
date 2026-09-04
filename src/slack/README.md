# Slack surface (Socket Mode)

The Slack surface, run **in-process with the agent core**: core boots it when
Slack tokens are present in its env and hands it a direct client into core's
services. **Socket Mode** means no public URL, ingress, domain, or TLS — it opens
an outbound WebSocket to Slack, so you can run it from a laptop or any box with
internet.

```
Slack  ⇄ (WebSocket)  slack surface (in core)  ── direct calls ──▶  core services (Pi)
```

## 1. Create the Slack app (one paste)

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Pick your workspace, paste [`manifest.json`](./manifest.json), create.
3. **Install to Workspace** (OAuth & Permissions → Install). Copy the
   **Bot User OAuth Token** → `xoxb-…` → `SLACK_BOT_TOKEN`.
4. **Basic Information → App-Level Tokens → Generate Token and Scopes**: add the
   `connections:write` scope, generate. Copy `xapp-…` → `SLACK_APP_TOKEN`.

(Socket Mode is already enabled by the manifest. No request URLs to configure.)

### Slack Agents (top-bar pin)

The manifest enables Slack's [Agents & AI Apps](https://docs.slack.dev/ai/developing-agents)
feature (`agent_view`) for one reason: users can pin the app to the Slack top bar and open
it anywhere. Conversations in the resulting split pane are ordinary DM thread messages and
flow through the normal DM machinery unchanged — none of the extra agent UI (status
indicators, thread titles, context passing, suggested prompts) is implemented.

Two caveats:

- **Paid plan required.** Slack only serves the AI-apps experience on paid plans (the
  Developer Program sandbox also works).
- **Existing installs must update the manifest and reinstall** to pick up the
  `assistant:write` scope and the `assistant_thread_started` and
  `assistant_thread_context_changed` events (Slack requires both to enable the feature;
  the plugin acknowledges them as no-ops). Installs that don't update keep working
  exactly as before.

> **Running locally alongside another developer? Each dev needs their OWN app.**
> See [Local dev with multiple developers](#local-dev-with-multiple-developers)
> below — set the manifest `name`/`display_name` to `agent-<yourname>` before
> creating, so you don't share a bot identity.

## 2. Run

One process — core boots the Slack surface itself when the tokens are in its env:

```bash
cd ~/Programming/qm
nvm use
HARNESS=pi ORG_ID=acme ANTHROPIC_API_KEY=… \
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… \
npm start
```

(`OPENAI_API_KEY` or `OPENROUTER_API_KEY` works in place of `ANTHROPIC_API_KEY`; the base
model follows whichever provider you configure.)

(Or put the tokens in the repo-root `.env` — `npm start` loads it via
`node --env-file-if-exists`.) It logs `connected as @agent …` when live; without
the tokens, core simply runs without Slack.

## 3. Use it

- **DM the bot** anything → it replies in the DM (one continuous session per DM). While it's
  working on your reply you'll see a **⚙ Working…** status message; once the agent starts
  producing text, the reply streams in place by editing that same message — so the wait is
  never blank and there's never a duplicate post.
- **@mention it in a channel** → it replies in a thread (one session per thread). After
  a real Slack mention in that thread, **just keep talking in the thread — no need to
  re-@mention.** The bot then _listens_
  to every reply and decides whether to chime in **like a thoughtful coworker** (a "turn
  detection" step in the core): it answers a question or a request aimed at it, but stays out
  of a back-and-forth between other people. When it decides to stay quiet it posts nothing at
  all (no spinner, no "I'll stay out of it"). An explicit @mention always gets a reply, and a
  _new_ top-level message still needs an @mention to start a fresh thread.
- **Share a file** with it (DM or @mention with an attachment) → it downloads the file
  and the agent can read/process it; **ask it to send a file** and it uploads the produced
  file back into the thread. Bytes travel **out-of-band**: the plugin streams them to the
  core's blob endpoint (`POST /v1/blobs`) and the turn carries only a lightweight `blobId`,
  so files up to **~1 GB** (Slack's own per-file limit), up to 10 per message, ride the same
  path — no more squeezing base64 into the 1 MB turn body. Outbound files are fetched back
  from the core (`GET /v1/blobs/:id`) and uploaded via `files.uploadV2`. **Only Slack-hosted
  files are ingested** — externally-hosted ("remote") files are refused, since fetching an
  off-Slack URL from the plugin host would be an SSRF / token-leak vector.
- **Replies render natively.** The agent emits standard Markdown; the plugin translates it
  to Slack "mrkdwn" before posting (`toSlackMrkdwn` in [`lib.ts`](./lib.ts)) so `**bold**`,
  `[links](url)`, `# headers`, and `- bullets` show as Slack styling instead of raw markup.
- **The agent can react with emoji — a Slack-only feature with two paths.**
  For explicit reaction requests inside a normal assistant turn, the plugin teaches the agent the
  reply convention via a surface instruction in the turn's `gatewayContext` (`REACTION_INSTRUCTION`):
  include a directive like `[[react: eyes white_check_mark]]` anywhere in the reply. The reply can be
  **just the directive with no other text** — the agent then reacts silently, the way a human drops a 👍
  without typing anything (no "(no response)" placeholder, and the streamed status is torn down
  cleanly rather than flashing an empty bubble). The plugin parses the directive out of the reply
  (`extractReactions` in [`lib.ts`](./lib.ts)), removes it from the text, and applies the emoji
  with `reactions.add` to the message that triggered the turn — or, when the directive carries an
  `@ <id>` target (`[[react: tada @ ~abc123]]`), to that _specific_ earlier message instead. So the
  agent can resolve a phrase like "react to Alice's last message," each channel turn
  reconstructs the conversation as structured roled turns (`renderConversationView`, fed by a
  best-effort `conversations.history`/`replies` fetch that reuses the `channels:history` /
  `groups:history` scopes); every reaction-eligible message carries a **short, stable id** in
  brackets like `[~abc123]` — the message's Slack `ts` packed into base36 (`encodeTs`), written
  **once** on that message's turn. The agent copies that `~id` into the directive and the plugin
  **decodes it straight back to the `ts`** (`decodeTs` — no lookup map), validated against the set of
  message ts it actually showed this turn so a stale/forged id is dropped rather than reacting to the
  wrong message. The id is short (~10 chars vs a 17-char raw timestamp) and STABLE (it always points
  at the same message, so persisting it never drifts,
  unlike the old positional `[N]` handle). A raw `@ <ts>` still works for back-compat. In-thread
  replies are tagged `(reply)` so the agent sees thread structure, and the parent of any listed reply
  is pulled in alongside it (`recentWindow`/`arrangeForDisplay`).
  The **bot token never leaves the plugin**. Names are normalized against the
  **complete Slack emoji set** — `:eyes:`, `eyes`, or a literal char all work, including the ~1900
  standard emoji, ZWJ sequences (`🧑‍💻` → `technologist`), the `❤️`/`❤` variation-selector forms,
  and skin tones (`👍🏽` → `+1::skin-tone-4`). That table (`src/emoji-map.ts`) is built at module load
  from the [`emoji-datasource`](https://www.npmjs.com/package/emoji-datasource) package
  (iamcal/emoji-data, the dataset Slack itself uses) — bump the dependency to refresh it. Names are
  deduped and capped; a per-emoji failure (or a missing
  scope) is logged, never breaking the reply. The directive is also stripped from streamed partials
  so it never flashes while the reply types out.
  Separately, unprompted channel-thread messages can be acknowledged before the assistant turn runs:
  Slack passes `gatewayContext.reactionGuidance`, the core detector may return `status: "react"` with
  emoji names, and the plugin applies those to the triggering message without posting a reply.
- **The agent also HEARS reactions — if someone reacts to a message, it can see it.** With the
  `reactions:read` scope and the `reaction_added` / `reaction_removed` events, a reaction the bot has
  a **stake** in is surfaced to the agent: a reaction on its **own** message, a reaction in a **DM**
  with it, or one on a **thread root it's following** (`shouldSurfaceReaction` in
  [`lib.ts`](./lib.ts)). Everything else — a stray reaction in a channel it merely sits in —
  is ignored, so a busy channel never floods the agent. A relevant reaction is delivered as an
  **unprompted turn** (exactly like a thread-follow message): the core runs **turn detection**, so a
  passing 👍 stays silent while a ✅ on the bot's "shall I deploy?" gets acted on. The reacted message
  is read once via `reactions.get` so the agent sees its text **and its full current emoji set** —
  e.g. _"Alice reacted with :white_check_mark: on your message: …(it now has :white_check_mark: :eyes:)"_
  (`buildReactionTurnText`). The bot's own reactions never loop back, and the same emoji the agent can
  read on recent messages are appended to the reaction-targeting list (`buildRecentMessages`), so it
  can read the slackmojis there too. The reactor is classified and the channel audience is computed
  exactly as for a message — so a reaction in a Slack-Connect / guest-containing context never makes
  the bot respond — and that full audience is resolved (stake → dedup → coalesce → membership) **before**
  any message content is read, so a non-internal channel's content is never fetched. A burst of reactions on
  one message is **collapsed** to a single turn while one is in flight (`reactionsInFlight` guard), so an
  emoji-pile can't wake the agent once per emoji. _(Bounded by design: a reaction on someone else's non-root reply
  inside a followed thread isn't surfaced — the message thread-follow path owns that conversation.)_
- **Dangerous commands ask for approval in Slack.** When a tool call hits a
  `require_approval` command-policy rule, the bot posts buttons for **Allow once**,
  **Allow session**, **Allow always**, and **Deny**. Session/always approvals are exact-command
  grants; deny rules still cannot be bypassed. This works whether the turn _paused_ awaiting
  approval (`pending_approval`) or _finished with a reply but skipped_ the gated command
  (collect-mode `ok` + `pendingApprovals`, what the real Pi harness does) — in the latter case
  the buttons are posted alongside the reply. Clicking re-runs the turn with the command approved.
- **Channel agents can ask personal agents.** If a channel task needs a member's personal setup
  (their env, browser login, resident CLI, connected app, or private files), the channel agent can
  ask that person's personal agent instead of pretending the shared context has the resource. The
  request appears in the original thread as `#channel agent → Name's personal agent`, and the target
  person gets a DM with **Run with my setup** / **Decline** buttons. If they approve, the plugin runs
  a normal DM-scoped turn as that user and posts the result back to the thread as
  `Name's personal agent → #channel agent`. The target must already be an internal participant in
  the channel conversation. In `HARNESS=mock`, use `!askagent <@USERID> task` to test the full flow.
- In an **externally-shared (Slack Connect) channel**, or any channel/mpim whose audience
  includes a **guest or external member**, it stays silent in-channel and replies privately
  (ephemeral) — and uploads no file there — internal-only (spec §9). Group DMs (mpim) aren't
  handled yet (it says so out-of-band rather than mis-scoping them).

> **Re-install after upgrading to file sharing.** The `files:read` / `files:write` scopes
> were added to `manifest.json`; update the app's scopes (or re-create from the manifest)
> and **reinstall to the workspace** so Slack grants them, then restart the plugin.

> **Re-install after upgrading to emoji reactions.** The `reactions:write` scope was added to
> `manifest.json`. Update the app from the manifest and **reinstall to the workspace** so Slack
> grants it, then restart the plugin — otherwise the agent's reactions are silently dropped
> (logged as a missing-scope hint).

> **Re-install after upgrading to inbound reactions.** The `reactions:read` scope and the
> `reaction_added` / `reaction_removed` events were added to `manifest.json`. Update the app from
> the manifest and **reinstall to the workspace** (re-subscribing the events), then restart the
> plugin — otherwise the bot won't receive reactions others add, and `reactions.get` reads fail.

> **Re-install after upgrading to workspace emoji.** The `emoji:read` scope lets the
> acknowledgment picker include custom workspace emoji. Update the app from the manifest and
> **reinstall to the workspace**, then restart the plugin.

> **Re-install after upgrading to thread-follow.** The `channels:history` / `groups:history`
> scopes and the `message.channels` / `message.groups` events were added to `manifest.json`.
> Update the app from the manifest and **reinstall to the workspace** (and re-subscribe the
> events), then restart the plugin — otherwise the bot won't see non-mention thread replies.

> **Re-install after upgrading to approval buttons.** The manifest now enables Slack
> interactivity so Block Kit button clicks are delivered as Socket Mode `block_actions`
> payloads. No public request URL is needed, but the app must be updated from the manifest
> and reinstalled.

> **Re-install after upgrading to group-DM thread-follow.** The `message.mpim` event and the
> `mpim:write` / `mpim:history` scopes were added to `manifest.json`. Update the app from the
> manifest and **reinstall to the workspace** (re-subscribing the events), then restart the
> plugin — otherwise the bot won't see non-mention messages in **group DMs (mpims)**, so it only
> ever responds there when explicitly @-mentioned.

## Local dev with multiple developers

Slack **Socket Mode load-balances events across every client connected to the same
app**. If two developers both run this plugin against one shared app, Slack delivers
each incoming message to only _one_ of them (round-robin) — so you each lose ~half
your messages, and a message can land on a teammate whose core is down. More config
won't fix it; the collision is the shared _app identity_.

**Fix: one Slack app per developer.** Separate apps = separate bot identities, and
Slack delivers each app's events only to that app's own connection — zero contention.

Each developer, once:

1. **Create your own app** from [`manifest.json`](./manifest.json) (step 1 above),
   but first change the manifest's `name` to `Agent (yourname)` and `bot_user.display_name`
   to `agent-yourname`. Install it; grab your own `xoxb-…` + `xapp-…`.
2. Put your tokens in the repo-root `.env` (gitignored — see [`.env.example`](../../.env.example)).
   Pick a distinct core `PORT` per dev if you share a machine.
3. `npm start` at the repo root. In Slack, talk to **your** bot: `@agent-yourname` / DM it.

Nothing shared, nothing to coordinate. The repo's `manifest.json` is the template;
your per-dev name + tokens live only in your local app and your gitignored `.env`.

## How it maps to the core

| Slack                                                                                                            | Core                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_mention` / `message.im`                                                                                     | `POST /v1/turns`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `message.channels` / `message.groups` in a thread where the bot has a stake (it posted or was really @mentioned) | `POST /v1/turns` with `unprompted: true` (+ serialized conversation context) → core runs turn detection; `status: "silent"` ⇒ post nothing; `status: "react"` ⇒ add reactions and post nothing                                                                                                                                                                                                                                                                                                                                                                         |
| `reaction_added` / `reaction_removed` on a message the bot has a stake in (DM / own message / followed root)     | `reactions.get` to read the message + its emoji → `POST /v1/turns` with `unprompted: true` → core runs turn detection; `status: "silent"` ⇒ post nothing; `status: "react"` ⇒ add reactions and post nothing                                                                                                                                                                                                                                                                                                                                                           |
| user id + `users.info` (guest/restricted/other-team → guest)                                                     | `actor` + `isExternalGuest`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `conversations.info.is_ext_shared`                                                                               | audience contains a non-internal member → core refuses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| DM channel                                                                                                       | `threadRef` = `dm:<channel>` (one continuous session per DM — channel-scoped; the assistant `thread_ts` only routes the reply + native typing status, never session identity)                                                                                                                                                                                                                                                                                                                                                                                          |
| channel `thread_ts` (root)                                                                                       | `threadRef` = `ch:<channel>:<root>` (one session per thread)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `TurnResult.reply`                                                                                               | posted in-thread; unprompted `refused` (`security_quarantine` included) → silent, addressed `refused` → requester-only (ephemeral in channels) except addressed `security_quarantine` → fixed in-thread acknowledgement; `pending_approval` (or `ok` + `pendingApprovals`, collect-mode) → Block Kit approval buttons                                                                                                                                                                                                                                                  |
| Block Kit approval button (`block_actions`)                                                                      | `POST /v1/turns` with `approval` (`once` / `session` / `always` / deny)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `[[ask-agent: <@U…> \| task]]` in a channel reply                                                                | Slack strips the directive, DMs that user for consent, then runs `POST /v1/turns` as a DM-scoped personal-agent turn and posts the result back to the original thread                                                                                                                                                                                                                                                                                                                                                                                                  |
| Pending `/v1/surface-context` request (hanging long-poll, source-authed)                                         | The agent's mid-turn context pull: core resolved the target (current conversation via the capability's opaque destination, or a directory-resolved public channel) and parked the request; the plugin enforces visibility (public, bot-member, not externally shared — or the current conversation itself, even private), fetches history with `before` paging + `match` filtering, and POSTs the messages back (`buildContextWindow`). The default injected window is small (`MAX_RECENT_MESSAGES`, env `SLACK_RECENT_MESSAGES`); context beyond it is pull, not push |

## Notes / next

- The failed-turn admin link needs **no Slack config**: when a turn comes back `refused`
  with a real failure, the core supplies the admin transcript deep link (`TurnResult.adminUrl`,
  built from the session org's portal) and the plugin appends it as `Full error:`. Absent when
  there's nothing to link (boundary refusals, no portal configured).
- Channel audience is enumerated per-member: `computeChannelAudience` (lib.ts) resolves
  the full member list (with a Slack-Connect / guest external marker, and an actor-only
  fallback when membership is unreadable) so the core's audience-floor is fine-grained.
