# Surfaces: Slack, generic chat and delivery

_Verified against `main` at eb148f69d (2026-11-24). Statements were read in the code at that commit unless marked **[interpretation]**._

## In one paragraph

A _surface_ is where a conversation is hosted. The web UI is one (see [web-clients](./web-clients.md)). This subspec covers the two _chat hosts_, Slack and the generic chat host, and the delivery path that every surface shares. A chat host does three jobs. Inbound, it turns a host event (a mention, a direct message, a reaction, a button click) into a turn request that says who spoke, in which conversation, who else can read it and where a reply should go. Outbound, it posts what the agent says. In between, it keeps a _mirror_: a copy of the host's messages in Postgres, so a turn can see what was said around it. Anything that must reach a host durably is a row in one Postgres outbox table, `deliveries`, and each host runs a worker that drains its own rows. Both chat hosts run inside the core process and call core's functions directly; neither is a separate service. Both are off until configured. A deployment with no chat host is normal, and the web UI is then its only surface.

## One mention, traced end to end

Ada works at Acme, whose deployment has Slack connected. In a thread in `#launch` she writes "@agent rotate the staging key". Acme has a command rule that requires approval for that command ([security](./security.md)).

1. **Receive.** Slack sends an `app_mention` event over Socket Mode. `createDeferredAckReceiver` (`src/slack/deferred-ack.ts`) passes it on but holds back the acknowledgement: Slack hears "received" only once the turn is stored (step 4). If that takes more than about 2.5 seconds, the event is first saved by `createEnvelopeStaging` (`src/slack/envelope-staging.ts`) so a sweeper can replay it after a crash.
2. **Gate.** The `app_mention` handler in `registerSlackEvents` (`src/slack/events.ts`) ignores the bot's own messages, applies the optional allow-list, and calls `dispatch`, which drops a duplicate event already seen by this process.
3. **Describe the turn.** `handleIncoming` inside `createTurnHandler` (`src/slack/turn-handler.ts`) builds the request. It identifies Ada (`classifyUser`, `src/slack/identity.ts`; by email when the bot can read member emails), lists the channel's members as the _audience_, names the session `ch:<channel>:<thread root>`, sets the reply target `<channel>:<thread root>`, renders the surrounding thread from the mirror (`createConversationSerializer`, `src/slack/conversation-view.ts`) and copies attached files into blob storage (`stageSlackFiles`, `src/slack/attachments.ts`). If the audience contains someone from outside the organization and the organization has not allowed that, Ada gets a private refusal and the trace ends here.
4. **Submit.** `runSurfaceTurn` (`src/surfaces/turn-driver.ts`) calls `callCore` from `createTurnFlow` (`src/surfaces/turn-flow.ts`), which reaches `turn` (`src/api/app-turn.ts`) through `submitTurn` on `SlackCoreClient` (`src/api/slack-core-client.ts`). This is a function call, not HTTP. The run is queued and the Slack event is acknowledged. Because this is a shared conversation on a chat host, `shouldRouteToSpine` (`src/api/app-ambient.ts`) makes it a _spine turn_: the agent will speak by calling a tool, and any text it returns is not posted. The turn itself is described in [turns](./turns.md).
5. **Show progress.** While `createRunWaiter` (`src/surfaces/run-wait.ts`) waits for the run, `createAckPresenter` (`src/surfaces/turn-presenters.ts`) adds an emoji reaction to Ada's message after two seconds and removes it when the agent first posts.
6. **Pause for approval.** The agent calls the gated command, and core stores a pending approval. The store is wrapped by `createApprovalStore` (`src/surfaces/approval-store.ts`), which asks `slackApprovalCardRoute` (`src/slack/approval-cards.ts`) where the card goes and enqueues a delivery. The card does not go to the thread. It goes to Ada alone: destination type `principal`, target her Slack user id. The run ends as `pending_approval`.
7. **Deliver the card.** `createSlackDeliveryJobs` (`src/slack/delivery-jobs.ts`) hears the enqueue and starts a pg-boss job for that one conversation. The job claims the oldest pending row with `claimHead` and passes it to `deliver` from `createSlackDeliverer` (`src/slack/deliveries.ts`), which opens Ada's DM, posts the buttons built by `approvalMessage`, and marks the row delivered.
8. **Click.** Ada presses "Allow once". `handleApprovalAction` in `createApprovals` (`src/slack/approvals.ts`) reloads the approval from core, checks that the clicker is the requester, and submits the stored request again with the decision attached. Nothing about a pending card lives only in memory, so any core process can handle the click.
9. **Reply.** The resumed turn runs the command, and the agent calls the `post` action of its surface tool. `createSurfaceToolDeps` (`src/surfaces/surface-tools.ts`) enqueues a `slack` delivery with `reachEnqueue` (`src/reach/reach.ts`). The delivery job posts it in the thread with `postWithVerify` (`src/slack/delivery.ts`), which writes the row's idempotency key into Slack message metadata, so a retry finds the earlier post instead of posting twice. The card in Ada's DM is edited to show her decision.

Where other paths diverge:

- **Slack DM.** Not a spine turn. The reply comes back as text and `runSurfaceTurn` posts it. When the run finishes, `wireRunResultDeliveries` (`src/delivery/run-result-delivery.ts`) also enqueues the same reply under key `run:<runId>`. The live path marks that row delivered after posting; if the process died first, the delivery job posts it. The approval card appears in the same DM.
- **Environment tokens or a stored installation.** Identical from step 1. With `SLACK_EVENTS_MODE=http`, `createHttpEventsReceiver` (`src/slack/http-events.ts`) listens on a local port and core's public route `POST /slack/events` (`src/api/routes/slack-events.ts`) forwards to it.
- **Shared Slack service, many tenants.** A separate service, which is not in this repository, receives Slack's events for the workspace and forwards each one to `POST /v1/slack/managed/events`. `managedSlackEvent` (`src/api/routes/admin/slack-installation.ts`) finds the tenant from the caller's token or the workspace id, and `handle` from `createManagedSlack` (`src/surfaces/slack-managed.ts`) feeds the event to that tenant's plugin. Steps 2 to 9 are unchanged and run inside that tenant.
- **Generic chat host.** The host POSTs a signed event to `/v1/surfaces/generic-chat/events`. `handle` from `createGenericChatInbound` (`src/surfaces/generic-chat/inbound.ts`) checks the signature, finds the tenant from the event's `account`, mirrors the message, and for a `protocol: 2` event starts the same `runSurfaceTurn` through `createGenericChatTurns` (`src/surfaces/generic-chat/turns.ts`). Posts leave through `createDeliveryRelay` (`src/delivery/relay.ts`) and `genericChatSender` (`src/surfaces/generic-chat/outbound.ts`). The approval card is posted in the chat itself, with buttons addressed only to the requester (`genericChatApprovalCardRoute`, `src/surfaces/generic-chat/approvals.ts`).
- **Cron or webhook.** There is no inbound step. The destination is stored with the automation ([background-work](./background-work.md)), and its posts enter the same outbox.

## The nouns

| Noun                   | Plain meaning                                                                                                                                                                                                                                                    | Where it lives                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Surface**            | A registered chat host: a name (`kind`), a label, capability flags and prompt hints. Slack is always registered; generic chat only when configured. The web UI is not a registered `Surface`.                                                                    | `Surface` in `src/surfaces/contract.ts`; `createSurfaceRegistry` in `src/surfaces/registry.ts`; `sessions.surface`                                     |
| **Account**            | One connection to a host. Slack: one bot in one workspace, named `default` or an id from `SLACK_ACCOUNTS`. Generic chat: the id the host sends.                                                                                                                  | `SurfaceAccount`; `Destination.account`                                                                                                                |
| **Surface origin**     | Who wrote the message on the host, through which account and workspace, and whether the audience is internal or external. Carried on the request and stored once on the session.                                                                                 | `TurnSurfaceOrigin`; `sessions.slack_binding` (used for every surface)                                                                                 |
| **Thread ref**         | The session's key. Slack: `dm:<channel>`, `dm:<channel>:<thread>`, `ch:<channel>:<root>`, `grp:<channel>:<root>`. Generic chat: `partner-chat:<account>:<group or dm>:<chat>[:<thread>]`.                                                                        | `dmThreadRef`, `channelThreadRef` in `src/slack/message-gating.ts`; `genericChatRef` in `src/surfaces/generic-chat/protocol.ts`; `sessions.thread_ref` |
| **Audience**           | The people who can read the conversation, each marked internal or external. Input to the access rules in [scopes](./scopes.md).                                                                                                                                  | `conversation.audience` on the request                                                                                                                 |
| **Destination**        | Where one outbound message goes: a `type` (`slack`, `group`, `principal`, `web`, `partner-chat`), a `target`, and optional action fields (`react`, `edit`, `delete`, `pin`, `commandApprovalId`). `principal` means "this person, wherever they can be reached". | `Destination` in `src/types.ts`                                                                                                                        |
| **Delivery target**    | A host address for replies. Slack: `<channel>` or `<channel>:<threadTs>`. Generic chat: the thread ref.                                                                                                                                                          | `encodeDeliveryTarget` in `src/slack/delivery.ts`                                                                                                      |
| **Delivery**           | One outbox row: destination, text, attachments, idempotency key, provenance, and marks for delivered, expired or failed.                                                                                                                                         | `deliveries`; `DeliveryStore` in `src/delivery/delivery-store.ts`                                                                                      |
| **Idempotency key**    | Unique per delivery; enqueueing a key twice yields one row. `run:<runId>` is a run's final reply, `post:<runId>:…` a tool post, `command-approval:<id>:<createdAt>` an approval card.                                                                            | `deliveries.idempotency_key`                                                                                                                           |
| **Mirror**             | Stored copy of host messages per container (a channel or chat), with edits, deletions and a "handled" mark. Also called the surface cache.                                                                                                                       | `channel_messages`, `channel_state`, `channel_files`; `src/surface-cache/surface-cache.ts`                                                             |
| **Channel policy**     | Per-container standing orders, per-bot modes and the ambient switch.                                                                                                                                                                                             | `channel_policy`, `channel_policy_history`                                                                                                             |
| **Ambient judgment**   | Record of the model call that decides whether unaddressed channel messages deserve a turn.                                                                                                                                                                       | `ambient_judgments`, `ambient_cursors`; `src/surface-cache/ambient-judge.ts`                                                                           |
| **Spine turn**         | A turn in which the agent speaks only through its surface tool.                                                                                                                                                                                                  | `surfaceTools` on the request; `src/surfaces/surface-tools.ts`                                                                                         |
| **Approval card**      | A host message with Allow and Deny buttons. The approval record belongs to core; the card is a delivery.                                                                                                                                                         | `approvals`; `src/surfaces/approval-cards.ts`                                                                                                          |
| **Context request**    | A question a running turn parks for a chat host ("read this thread", "fetch this file"). The host plugin answers it.                                                                                                                                             | `context_requests`; `src/api/surface-context-puller.ts`                                                                                                |
| **Slack installation** | A workspace's bot token, stored encrypted, one per tenant.                                                                                                                                                                                                       | `slack_installation`; `src/surfaces/slack-installation.ts`                                                                                             |
| **Staged envelope**    | A Slack event saved before it is acknowledged.                                                                                                                                                                                                                   | `slack_staged_envelopes`                                                                                                                               |

Slack also keeps `slack_task_acknowledgements` (the emoji that marks a DM request as in progress), `slack_session_status` (optional status cards) and `ack_emoji_picks`.

## The parts

### `src/surfaces`

**Job.** Say what a chat host is, and hold what both hosts share: driving one turn, approval cards, attachments, reactions, refusals, and the agent's surface tool.

**Key idea.** A host supplies a `SurfaceTransport` (post, edit, react, typing, upload) and a prepared request. `runSurfaceTurn` does the rest: submit, wait, show progress, then post the reply, the refusal or nothing. Replies may carry directives such as `[[react: eyes]]`, which `extractDirectives` (`src/surfaces/reply-directives.ts`) strips before posting.

**Surprising.**

- The Slack `Surface` object is registered in every deployment. Finding `slack` in the registry does not mean Slack is connected.
- Production code reads only `kind`, `label`, `mark`, `capabilities`, `promptHints`, `threadTarget` and `containerOf` from a `Surface`. Its `post`, `mention`, `principalFor` and `native` members are called only by tests.
- What decides which Slack connections run lives here, not in `src/slack`: `slack-installation.ts`, `slack-managed.ts`, `slack-runtime.ts`, `slack-tenants.ts`.
- `web-spine.ts`, `ui-state.ts`, `ui-canvas.ts`, `desktop-calls.ts` and `client-relay.ts` serve the web UI and desktop app ([web-clients](./web-clients.md)).
- Shared file limits are `MAX_ATTACHMENT_BYTES` (1 GB) and `MAX_ATTACHMENTS_PER_TURN` (10) in `attachments.ts`.

### `src/slack`

**Job.** The Slack plugin. One `startSlackPlugin` call per account builds a Bolt app and registers its handlers; the default account also drains the tenant's Slack deliveries. The largest files are `directory.ts` (copies people, channels and memberships into core's directory, see [scopes](./scopes.md)), `delivery.ts` and `deliveries.ts` (posting and retry), `turn-handler.ts`, `approvals.ts` and `events.ts`.

**Key idea.** It is a library inside core, started by `src/start.ts`, and its calls into core go through `SlackCoreClient`. Four things address the agent: an `app_mention`, any DM message, a reply in a thread where the bot already posted or was mentioned, and a reaction on its own message, in a DM, or on the root of such a thread. The last two are sent as ambient-origin turns, so core may decide to stay silent.

**Surprising.**

- Channel messages that address nobody are only mirrored. Whether the agent speaks up is decided later in core (`judgeAmbientContainer`, `src/api/app-ambient.ts`), and that is off by default per channel.
- Approval cards for channel turns go to the requester's DM.
- A thread inside a DM is its own session, separate from the DM. A group DM has conversation kind `group` and `grp:` refs.
- Redelivered events are dropped twice: by a per-process cache (`createDeduper`), then by `redeliveryKey` on the request, which core stores with the run.
- Only files hosted by Slack are downloaded (`isTrustedSlackHost`).
- Accounts from `SLACK_ACCOUNTS` handle their own inbound turns. Only the default account publishes the emoji catalog, answers context requests and pushes the directory.
- `lib.ts` is a list of re-exports. `README.md` is setup help for a local Slack app, and `manifest.json` lists the scopes and events the plugin needs.

### `src/surfaces/generic-chat`

**Job.** A second chat host for any chat product that implements the protocol under Contracts.

**Key idea.** Signed HTTP both ways, no SDK and no socket. Core mirrors every event it receives, so reading history never calls the host.

**Surprising.**

- The surface id, every stored ref and the tool the agent sees are named `partner-chat` (the `GENERIC_CHAT` constant). "Generic chat" appears only in file names, environment variables and the default label.
- One URL and one secret serve the whole deployment. An event's `account` selects the tenant through `tenants.settings.partnerChatAccount`. There is no single-tenant fallback: without a matching row the event gets `404 unknown_account`.
- Two protocol versions run side by side. An event without `protocol: 2` gets a queued turn and an outbox reply. With `protocol: 2` it gets the live driver: progress reactions, typing, approval buttons, reaction and button events, and group chats that include outsiders.
- By default the agent's tool is text only on this host (`textOnly`): no reactions, edits, deletes or files. A `protocol: 2` turn lifts that for its own chat (`turnCapabilities`, `src/surfaces/registry.ts`). Pins are never supported.
- It reuses Slack's emoji tables (`src/slack/emoji-map.ts`, `src/slack/ack-emoji.ts`) and stages files through `SlackCoreClient`.

### `src/api/slack-core-client.ts`

**Job.** The in-process facade a chat host calls instead of core's HTTP API: submit a turn, wait for a run, stage a blob, push the directory, ingest mirror events, acknowledge deliveries.

**Key idea.** Chat hosts run in process, so this "client" is a plain object of functions over core's services (`createSlackCoreClient`).

**Surprising.** It is built in every deployment, including ones with no Slack. Its name describes its first user, not a connection.

### `src/surface-cache`

**Job.** The mirror, channel policy, and the records of ambient judging.

**Key idea.** Ingest is an upsert keyed by surface, account, container and timestamp; edits and deletions are events too. The "handled" mark keeps a message from starting two turns.

**Surprising.** Tables are named `channel_*` and serve every mirrored surface. Slack mirrors a room only when all its members are internal, unless external participants are enabled (`createMirror`, `src/slack/mirror.ts`). The first read of a Slack conversation in each process also fetches one page of live history and stores it (`createSlackHistoryReader`, `src/slack/history.ts`).

### `src/delivery`

**Job.** The outbox: store, claim, expire.

**Key idea.** `enqueue` is idempotent by key. For the chat hosts, rows with the same type and target go out oldest first, one at a time. Three wrappers shape what enters or leaves:

- `run-result-delivery.ts` turns a finished run into a row, both when the run ends and in a sweep of recently finished runs that have none.
- `web-transcript-delivery.ts` writes a `web` delivery into the target session's transcript before the web UI is told about it.
- `off-chat-delivery.ts` rewrites a `principal` delivery into a `web` one when the person signs in on the web but is not in the chat directory. It lands in their `web:<id>:direct` session.

**Surprising.**

- A `run:<runId>` row exists for crash recovery. While the turn driver in the same process is posting that reply, the row is held back (`liveRunHoldsDelivery`).
- A spine turn that did not fail normally has no `run:` row (`runResultDelivery`). Its words are `post:` rows.
- The in-memory `createDeliveryStore` is used only by tests; production always uses `createPostgresDeliveryStore`.

### `src/start.ts` and the routes

**Job.** `src/start.ts` decides which Slack plugins run. The routes are the HTTP edges of this area.

**Key idea.** Each tenant has a reconciler (`createSlackRuntimeReconciler`, `src/surfaces/slack-runtime.ts`). Every five seconds it reloads the wanted configuration, restarts the plugin if it changed, and goes back to the previous one if the new one fails to start. Tenants with an installation are discovered on the same interval (`createTenantSlackRuntimes`, `src/surfaces/slack-tenants.ts`).

**Surprising.**

- `src/api/routes/surface.ts` is, despite its name, mostly session, memory, skill and settings routes. Only `/v1/surface-config`, `/v1/custom-emoji` and `/v1/channel-header-pin` belong to this area.
- `src/api/routes/admin/slack-installation.ts` holds both the admin endpoints for a stored installation and the endpoints the shared Slack service calls. `admin/slack-mirror.ts` lets an admin read the mirror.
- `src/api/routes/slack-reply.ts` lets a person who is viewing a Slack session in the web UI reply into the Slack thread as themselves, through their own Slack connection ([credentials](./credentials.md)). The message is also written into the session.
- `src/api/routes/surface-cache.ts` exposes mirror ingest and channel policy over HTTP. `emoji.ts` adds a custom emoji to the Slack workspace through a Slack browser session the person saved.

## Optional and per-deployment

Both chat hosts are off until configured. The outbox, the mirror tables and the Slack entry in the surface registry exist in every deployment. The deployment shapes are defined in [the master spec](../SPEC.md#deployment-shapes); what every deployment has is listed under [core and optional](../SPEC.md#core-and-optional).

**Slack has three separate ways to be on.** A tenant has at most one stored installation, written either by an admin or by the shared service, and it outranks environment tokens (`slackRuntimeFor` in `src/start.ts`):

| Way                  | What turns it on                                                                                                                                                                                                                                                            | When absent or overridden                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Stored installation  | An admin saves a bot token and an app token (`PUT /v1/admin/slack-installation`, checked by `validateSlackInstallation`). Stored in `slack_installation`, encrypted with a key derived from `CONNECTOR_SECRET_KEY`. Always Socket Mode.                                     | Disconnecting (`DELETE` on the same path) leaves a disabled record, and while any record exists environment tokens are not used.      |
| Shared Slack service | `QM_SLACK_SERVICE_URL` (https) on core, plus `slackBridgeToken` in the tenant's `tenants.settings` or `QM_SLACK_SERVICE_TOKEN` for the whole deployment. `QM_SLACK_APP_ID` pins the Slack app. The service stores an installation that has an `installId` and no app token. | Without the URL, `/v1/slack/managed/*` return `404 not_configured` and an installation with an `installId` is ignored.                |
| Environment tokens   | `SLACK_BOT_TOKEN` with `SLACK_APP_TOKEN` (Socket Mode, the default), or with `SLACK_SIGNING_SECRET`, `SLACK_EVENTS_PORT` and `SLACK_EVENTS_MODE=http`. Read by `slackPluginConfigFromEnv` in `src/slack/config.ts`.                                                         | Used only when the database has exactly one tenant and that tenant has no installation record. With several tenants they are ignored. |

In a Package, Platform-hosted or Source-built deployment any of the three works. In a Multi-tenant deployment only the first two do, one installation per tenant. A core process with `BACKGROUND_WORK_ENABLED=false` opens no Slack connection and drains no chat deliveries.

| Other switch              | What turns it on                                                                                                                                                                                    | Default                                                  | When absent                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Extra Slack accounts      | `SLACK_ACCOUNTS`, a JSON array (see Contracts)                                                                                                                                                      | none                                                     | One account, `default`. Ignored, with a logged error, unless there is exactly one tenant.                                                        |
| External workspace policy | `externalAccess` on an account, or `SLACK_EXTERNAL_ACCESS` for the default account                                                                                                                  | off                                                      | Slack behaves as an internal workspace.                                                                                                          |
| External participants     | Organization setting `externalSlackParticipants`                                                                                                                                                    | off                                                      | In a conversation with a guest or outside member, an addressed message gets a private refusal, others are ignored, and the room is not mirrored. |
| Ambient replies           | Organization switch (default on) and a per-channel `ambientEnabled` in `channel_policy`                                                                                                             | off for a channel with no standing orders or action bots | Only mentions, DMs, followed threads and reactions start turns.                                                                                  |
| Allow-list                | `SLACK_ALLOW_FROM` (emails or domains), `SLACK_DENY_MESSAGE`                                                                                                                                        | everyone internal                                        | No filter and no deny message.                                                                                                                   |
| Identity keying           | `SLACK_IDENTITY_EMAIL` (`1` email, `0` Slack id)                                                                                                                                                    | detected at start                                        | Email when member emails are visible to the bot, otherwise Slack user ids, with a warning.                                                       |
| Links back to the web UI  | `PUBLIC_WEB_URL`                                                                                                                                                                                    | unset                                                    | Slack messages and approval cards carry no link.                                                                                                 |
| Status cards              | Feature flag `slack_loading_indicator`                                                                                                                                                              | off                                                      | No status card is posted.                                                                                                                        |
| Generic chat host         | `GENERIC_CHAT_URL` and `GENERIC_CHAT_SECRET` (both or neither, else core refuses to start); optional `GENERIC_CHAT_LABEL`, `GENERIC_CHAT_MARK`; plus `partnerChatAccount` in each tenant's settings | off                                                      | The surface is not registered, the events route returns 404 and no relay runs.                                                                   |

The environment switches above are deployment-wide, not per tenant: `slackRuntimeFor` builds the configuration for a stored installation from the same environment, so `SLACK_EXTERNAL_ACCESS`, `SLACK_ALLOW_FROM` and `SLACK_IDENTITY_EMAIL` apply to every tenant's default account.

Tuning variables read by `slackPluginConfigFromEnv`: `SLACK_HISTORY_LIMIT`, `SLACK_RECENT_MESSAGES`, `SLACK_ACK_CAP_MS`, `SLACK_USER_TOKEN`, `SLACK_COPILOT_BOT_TOKEN`, `SLACK_API_URL`, `SLACK_LOG_LEVEL`, the `SLACK_*_TTL_MS` cache lifetimes and `SLACK_MAX_PRIVATE_CHANNELS`. `DEV_INSTANCE_NO_SLACK=1` keeps a process from starting any Slack plugin.

**With no chat host at all**, these are the places where code leans on Slack:

- Rows of type `slack`, `group` and `principal` are drained only by a running Slack plugin. `off-chat-delivery.ts` covers the common case by turning `principal` rows for web-only people into `web` rows, so their approval cards and direct messages arrive in a web conversation. Any other such row stays pending.
- Core fills in `"slack"` when a request names no surface (`handleTurn` in `src/core/orchestrator.ts`, `surfaceTool` in `src/agent/agent-tools/surface.ts`).
- A context request for Slack waits 25 seconds and returns nothing, because no plugin answers it.
- The admin endpoint reports `source: "none"`, and `/slack/events` returns 404.

## Where the complexity lives

**Two ways for words to reach a host.** Either the turn returns text and the live driver posts it, with a `run:` row for recovery, or the agent posts through its tool and each post is a row. Which one applies depends on surface, conversation kind, origin, audience and whether the request resumes an approval (`shouldRouteToSpine` plus two conditions in `turn`, `src/api/app-turn.ts`), and for web DMs on the feature flag `web_dm_spine`. The approval handler (`src/slack/approvals.ts`) and run-result recovery each branch on it again.

**Three drains for one outbox.** Slack uses pg-boss jobs per conversation with `claimHead`. Generic chat uses `createDeliveryRelay` with `claimDue`. The web UI polls with `pending` in `src/api/routes/web-events.ts`. The master's _Hand-rolling_ lens records the custom claim columns; pg-boss now wakes the Slack drain, but rows are still claimed through those columns. The six-hour expiry (`DELIVERY_MAX_AGE_MS`) runs only inside `claimPending` and `claimDue`, so where neither is called (no generic chat host, and nothing polling `GET /v1/deliveries`) stale rows are never marked expired.

**Two stores for one Slack conversation.** The session log holds what the agent did; the mirror holds what Slack shows. A turn in a channel thread is assembled from both, and `src/slack/message-revisions.ts` writes later Slack edits and deletions back into the session. Slack does not read sessions: it shows what was posted to it.

**Four progress signals.** A reaction after two seconds and the agent's first text block posted as an acknowledgement (`createAckPresenter`); a stored emoji on DM requests that outlives the process (`createTaskAcknowledgements`, `src/slack/task-ack.ts`); status cards behind a feature flag (`createSlackSessionStatus`, `src/slack/session-status.ts`); and typing indicators on the generic chat host.

**Three ways to connect Slack, times two event transports, times one or many tenants.** The precedence is one closure in `src/start.ts`. **[interpretation]** A disabled record outranks environment tokens so that an admin's disconnect is final.

**The plugin is not separable from core.** Core imports Slack code directly: `src/core/orchestrator.ts`, `src/api/app-messaging.ts`, `src/api/app-ambient.ts`, `src/agent/replay.ts` and `src/resolution/external-slack.ts` all import from `src/slack`, and the generic chat host does too.

**An abstraction with two implementations and unused members.** `Surface` has Slack and generic chat; the web UI is handled by `surface === "web"` branches instead. Four of its members have no production caller (see `src/surfaces`).

**Transitional code.**

- `src/surfaces/published-upgrade.ts` and `origin-migration.ts` are database migrations. They convert rows written with older Slack-only request fields into `surfaceOrigin` and `Destination.account`, and refuse to start on a database that still holds the old shape.
- Names lag behind their meaning: `sessions.slack_binding`, the `channel_*` tables, `SlackCoreClient`, `partner-chat`.
- `GET /v1/deliveries`, `POST /v1/deliveries/:id/ack`, `GET /v1/surface-context/pending` and `POST /v1/surface-cache/ingest` form an HTTP protocol for a chat host running outside core. Nothing in this repository calls them.
- `Destination.identity` selects a second Slack bot token (`SLACK_COPILOT_BOT_TOKEN`), but no code under `src/` sets it.
- The Slack app manifest exists twice with identical content: `src/slack/manifest.json` and `cli/templates/slack-manifest.json`.
- The master's _Arbitrary limits_ lens records the 600-character clip on context-pull messages (`MAX_CONTEXT_MESSAGE_CHARS`, `src/slack/conversation.ts`).

## Contracts

### Generic chat host

**Host to core.** `POST /v1/surfaces/generic-chat/events` with headers `x-agent-app-request-timestamp` (Unix seconds, within 300 of core's clock) and `x-agent-app-signature: v0=<hex>`, where the hex is HMAC-SHA256 with the shared secret over `v0:<timestamp>:<raw body>`. Body (`parseGenericChatEvent`, `src/surfaces/generic-chat/protocol.ts`):

```
{ "protocol": 2,                      // optional; required for actions and reactions
  "event_id": "…",
  "type": "message.created" | "message.updated" | "message.deleted"
        | "action.invoked" | "reaction.added" | "reaction.removed",
  "account": "<id>",
  "chat": { "id": "<id>", "kind": "group" | "dm", "name": "…", "members": [user] },
  "thread_id": "<message id>" | null,
  "message": { "id": "<digits>", "user": user, "body": "…", "mentions_agent": false,
               "app_post": false, "created_at": "<ISO time with offset>",
               "files": [{ "id": "<digits>", "name": "…", "content_type": "…", "size_bytes": 0 }] },
  "action": { "id": "…", "user": user },        // action.invoked
  "reaction": { "name": "…", "user": user } }   // reaction.*
user = { "id": "<id>", "email": "…", "name": "…", "bot": false, "member": false }
```

Ids match `[A-Za-z0-9_-]+`; message and file ids are 1 to 20 digits. `member: true` is the host vouching that the user belongs to the organization; core still needs an email. A `dm` chat must list exactly one person who is not a bot. Responses: `200 {"ok": true}` with an optional `ignored` reason, `400`, `401 unauthorized`, `404 unknown_account`, `413`.

**Core to host.** `POST <GENERIC_CHAT_URL><path>` with a JSON body and headers `x-agent-app-account`, `x-agent-app-request-timestamp` and `x-agent-app-signature`, here over `v0:<timestamp>:<account>:<path>:<body>` (`signGenericChatRequest`). Calls time out after 15 seconds. A 4xx other than 401, 403, 408 or 429 fails the delivery without retry.

| Path                                                      | Body                                                                                                                                      | Reply                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/agent_app/messages`                                     | `client_message_id`, `chat_id`, `thread_id?`, `body`, `file_ids?`, `actions?` (`id`, `label`, `style`, `user_ids?`), `recipient_user_id?` | `message_id`                                                                                       |
| `/agent_app/messages/update`                              | `chat_id`, `message_id`, `body`, `actions?`                                                                                               |                                                                                                    |
| `/agent_app/messages/delete`                              | `chat_id`, `message_id`                                                                                                                   |                                                                                                    |
| `/agent_app/typing`                                       | `chat_id`, `thread_id?`, `typing`                                                                                                         |                                                                                                    |
| `/agent_app/reactions/add`, `/agent_app/reactions/remove` | `chat_id`, `message_id`, `name`, `skin_tone?`                                                                                             |                                                                                                    |
| `/agent_app/files/url`                                    | `file_id`                                                                                                                                 | `url` (https)                                                                                      |
| `/agent_app/files/upload`                                 | `chat_id`, `name`, `content_type`, `size_bytes`                                                                                           | `file_id`, `upload.url`, `upload.fields`; core then sends the file to that URL as a multipart form |

### Shared Slack service

All calls carry `Authorization: Bearer <token>`, where the token is the tenant's `slackBridgeToken` or the deployment's `QM_SLACK_SERVICE_TOKEN`.

- Core to service: `GET /install/status` returns `companyOwned`, `appReady`, `connected` (booleans). `POST /install/start` with `step` (`setup` or `install`), `tenant`, `origin?` returns a `url` on the service's own origin.
- Service to core: `POST /v1/slack/managed/installation` with `installId`, `installedAt`, `appId`, `teamId`, `botToken`, `teamName?`, `tenant?` returns 200 or 202 with `ready`, or `409 installation_conflict`. `DELETE` on the same path with `installId` disables it. `POST /v1/slack/managed/events` with `installId`, `body` (the Slack event envelope), `retryNum?`, `retryReason?` returns the acknowledgement, `409 installation_mismatch`, `400 workspace_mismatch`, or 503 when that tenant's plugin is not running here or the event was not stored.

### `SLACK_ACCOUNTS` and external workspace access

`SLACK_ACCOUNTS` is a JSON array. Each entry has a unique `id`, a `botToken`, and `appToken` or (`eventsMode: "http"`, `signingSecret`, `eventsPort`). Optional: `apiUrl`, `identityEmail`, `allowFrom`, `denyMessage`, `externalAccess`. `default` is taken by the default account. Core's `/slack/events` route forwards only to the default account's port; an extra account in HTTP mode needs its own ingress to its `eventsPort`.

`externalAccess` marks a workspace whose channels include people from outside the organization (`parseExternalSlackAccess`, `src/slack/external-access.ts`):

```json
{ "companyDomains": ["example.com"], "companyTeamIds": ["T0ACME"], "serviceCredentials": ["public-search"] }
```

- `companyDomains` and `companyTeamIds` are required and non-empty. A person may start work only if their Slack account belongs to one of those workspaces and their profile email is at exactly one of those domains (`companySlackActor`). Guests, deleted users, bots and everyone else cannot, in DMs too. An allow-list narrows this further.
- Every conversation that is not a DM is treated as having an external audience. Its session and scope are named under a namespace made from the workspace id and a hash of the policy (`externalSlackNamespace`), so changing the policy starts a fresh scope and computer. Such a turn runs without personal or organization memory, files, keychain, connected apps or administrative tools ([security](./security.md)).
- `serviceCredentials` lists the shared service credentials such a turn may use. A credential must be on this list and also granted in the normal way (`externalSlackCapabilityAllowed`, `src/api/external-slack-capability.ts`).
- When work needs private context, the agent ends its reply with `[[continue-private: …]]`. `continueInPrivate` (`src/slack/private-continuation.ts`) re-checks the requester against the current policy, says so in the thread, and queues a new turn in that person's DM with the original request, channel context and files. Results and approvals stay in the DM.
- For such an account the mirror, ambient replies and reaction turns are off. Mentions, replies in a thread the agent has joined, and DMs from employees work. An approval raised in a shared conversation cannot be resumed there.
- A request for such a conversation is refused unless it carries the origin recorded by the Slack plugin under the current policy (`externalSlackRequestAllowed`, `src/resolution/external-slack.ts`). Deliveries created under an older policy are dropped, not posted.
- The policy is read from the environment by every core process and takes effect on restart. All processes that run turns need the same value.
