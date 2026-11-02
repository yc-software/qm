# WS8 PR4: orchestrator and agent tools read surface capabilities and prompt hints instead of branching on Slack (no behavior change)

Branch `regan/ws8-pr4-capabilities`, based on `regan/ws8-surface-contract` (PR 1, qm#2845 head `2621e471a`). Per the integration plan this branch has no separate PR. It is merged into #2845 together with PR 3 and PR 5, and this file holds the description content for that combined PR. Code head reviewed: `292deab01`. CI/CD (workflow_dispatch) is green on that commit: run 41520053628.

## What / Why

QM's orchestrator, its prompt templates and the agent surface tool used to decide Slack-specific behavior and wording with `input.surface === "slack"` and `destination.type === "slack"`. WS8 moves Slack behind the platform-agnostic `Surface` contract, so other chat platforms can plug in as adapters. This change makes those sites ask the surface registry (`deps.surfaces`) instead. The Slack adapter now owns the Slack wording and declares the capabilities those branches key on. Rendered prompts, tool text and branch outcomes stay identical for every surface value.

- **`src/surfaces/contract.ts`:** `Surface` gains three members:
  - `label: string`
  - `capabilities: { mirrored, liveReplies, nativeActor, externalParticipants }` (all booleans)
  - `promptHints: { mentionSyntax, linkSyntax, autonomousStyle, conversationStyle }` (all strings; a readonly property)

  Each flag exists only because a current branch keys on it:
  - `mirrored`: the surface's messages are mirrored in the surface cache. It gates message-revision tracking, the mirror-search path and the cache-container split.
  - `liveReplies`: the gateway streams the first block as a task ack and tracks the run's `replying` delivery state. It gates `earlyTaskAck`, `harvestedAck` and the run-lease `replying` write.
  - `nativeActor`: the actor id is the surface's native user id. It gates `actingSlackUserId` and the rate-limit-notice recipient.
  - `externalParticipants`: the org's external-participants setting applies to this surface.

- **`src/surfaces/slack/adapter.ts`:** sets `label: "Slack"`, sets all four flags true, and supplies the four Slack prompt strings.
- **`src/surfaces/registry.ts`:** adds `SurfaceToolPrompt` (`Pick<Surface,"label"> & Pick<SurfacePromptHints,"mentionSyntax">`) and `surfaceToolPrompt(surface)`.
- **`src/core/orchestrator.ts`:**
  - Resolves `surface = deps.surfaces.get(input.surface)` once per turn and reads its flags at each converted branch.
  - Resolves `toolSurface = deps.surfaces.get(surfaceName || "slack")`, keyed on the tool name the agent layer actually registers. It feeds both the frame `surfaceLabel` and the turn's `surfacePrompt`.
  - Prompt templates receive `surfaceStyle` and `surfaceLinks` strings in place of the `slack` boolean.
- **`src/resolution/protocols/{mode-autonomous,mode-conversation,shared-core}.md`:** each `{{#if slack}}…{{/if}}` block becomes a `{{surfaceStyle}}` or `{{surfaceLinks}}` variable. It renders the adapter string, or `""` when no surface is registered.
- **Agent tool layer:** `AgentTurnInput` and `AgentToolsOptions` carry `surfacePrompt`, forwarded by `agent-run` and `turn-support`. `agent-tools/surface.ts` takes its label and mention syntax from it instead of testing `surfaceName === "slack"`.
- **`src/surfaces/surface-tools.ts`:** destination checks read `deps.surfaces.get(destination.type)?.capabilities`:
  - `nativeActor` for the rate-limit-notice recipient
  - `mirrored` for the cache-container split and mirror search
- **`OrchestratorDeps.surfaces` is now required.** `src/wiring.ts` builds the registry with the Slack adapter. Tests get it through `singleProcessDeps()` or `testSurfaces()`.

## Surface value → branch outcome (identical before and after)

Lookups use three different keys:

- `S` = `input.surface`, where unset means "no surface".
- `T` = the tool name: `input.surface ?? "slack"`, or `"slack"` for automation turns with a platform destination. The agent layer also treats `""` as `"slack"`.
- `D` = `destination.type`, used in `surface-tools.ts`.

| Branch (key)                                                       | `"slack"`                        | `"web"`                                      | `"monitor"`                                            | `"cron"` / other unregistered (e.g. `"acme"`) | `""`        | unset       |
| ------------------------------------------------------------------ | -------------------------------- | -------------------------------------------- | ------------------------------------------------------ | --------------------------------------------- | ----------- | ----------- |
| Frame `surfaceLabel` (T)                                           | Slack                            | `the <bot> web app`                          | Slack (fallback)                                       | Slack (fallback)                              | Slack       | Slack       |
| Mode style hint, autonomous/conversation (S)                       | Slack text                       | none                                         | none                                                   | none                                          | none        | none        |
| Link-syntax line in shared core (S)                                | Slack text                       | none (web keeps its own `{{#if web}}` line)  | none                                                   | none                                          | none        | none        |
| Surface tool label (T)                                             | Slack                            | web                                          | monitor                                                | cron / acme                                   | Slack       | Slack       |
| Tool mention syntax (T)                                            | yes                              | no                                           | no                                                     | no                                            | yes         | yes         |
| Automation turn with destination: tool label / mention (T=`slack`) | Slack / yes                      | Slack / yes                                  | Slack / yes                                            | Slack / yes                                   | Slack / yes | Slack / yes |
| External participants allowed via org flag (S)                     | flag checked                     | no                                           | no                                                     | no                                            | no          | no          |
| `trackRevisions` (S, needs `surfaceCache`)                         | yes                              | no                                           | no                                                     | no                                            | no          | no          |
| Run lease `replying` (S)                                           | yes                              | no                                           | **yes** (unchanged `\|\| input.surface === "monitor"`) | no                                            | no          | no          |
| `earlyTaskAck` / `harvestedAck` (S)                                | yes (other conditions unchanged) | no                                           | no                                                     | no                                            | no          | no          |
| `actingSlackUserId` (S)                                            | set                              | unset                                        | unset                                                  | unset                                         | unset       | unset       |
| Rate-limit-notice recipient (D)                                    | `slack` dest: yes                | other dest types: no                         |                                                        |                                               |             |             |
| Cache-container split / mirror search (D)                          | `slack` dest: split + mirror     | other dest types: whole container, no mirror |                                                        |                                               |             |             |

The new test `test/surface-prompt-hints.test.ts` asserts the prompt and tool rows of this table through a real `!sysprompt` orchestrator turn: slack, web, monitor, acme, empty and unset, DM and autonomous, plus automation turns from cron, monitor and web. A second test registers a non-Slack surface and asserts it supplies its own label, style, links and mention syntax. Both tests fail on the base branch. The remaining rows are covered by the existing suites, which pass unchanged: `early-task-ack`, `message-revisions*`, `external-slack-participants`, `slack-rate-limit-notice`, `slack-mirror-context`, `finalize-on-reply-ready`, `resume-surface-post`, `turn-stream` and `subagent-parity`.

## What is NOT changed

- **No renames.** The agent-facing `slack` tool keeps its name. The `search` tool's `source: "mirror" | "slack"` enum and its copy are unchanged, including "retry with source \"slack\"…" and "no matches in Slack's full history…".
- **No behavior change for any surface value**, including `""` and unset.
- **No new env vars, settings, config, schema, tables or persisted payload shapes.** `OrchestratorDeps.surfaces` is an in-process dependency.
- **Text intentionally left in place:**
  - **External-audience note** ("This conversation has an external Slack audience…"): it is gated on `input.externalSlack`, which PR 3 owns. Looking it up by `input.surface` would drop it for an `externalSlack` turn whose surface is not `"slack"`. That combination is reachable at the orchestrator layer, and the 40-case comparison exercises it.
  - **Automation delivery instruction** ("…Do not call Slack, email, chat, or other send APIs…"): generic, and not keyed on a surface.
  - **Addressed-directly nudge** ("[system] You were addressed directly. Reply with the `slack` tool's `post` action…"): it names `slack` for every spine-routed surface, including non-Slack gateways. Parameterising it changes text for those gateways (this is a latent bug).
  - **`(@{{botHandle}} in Slack)`** in shared-core.
  - **Project home channel block:** its data source, `managedGroups.slackChannel`, is Slack-specific.
  - **Cron reminder mention hint** in `src/cron/scheduler.ts`.
  - **Slack-only ack-emoji prompt** in `src/agent/agent-run.ts` (`pickAckEmoji`): Slack-only by design.
- **Behavior-preserving fallbacks that stay in the orchestrator:**
  - the `?? "Slack"` label fallback for unregistered surfaces
  - the `|| input.surface === "monitor"` run-lease clause
- **The test-only `turnToolOptions()` default** `{ surfaceTools: true, surfaceName: "slack" }` without a `surfacePrompt`: this path is reached only from `test/subagent-parity.test.ts`.
- **Sibling regions are untouched:** PR 3's `slackSource`, `externalSlack` and `Destination.slack*` sites, and PR 5's `src/surface-cache/*`.

## English text a model reads: every moved or touched string, verbatim

1. **Surface label in the mode frame (`{{surfaceLabel}}`).** Moved, unchanged.
   - Old: `isWeb ? \`the ${botName} web app\` : "Slack"`
   - New: `isWeb ? \`the ${botName} web app\` : (toolSurface?.label ?? "Slack")`, with the Slack adapter's `label: "Slack"`
2. **Surface tool label in the tool description** ("Everything you do on {label} goes through this tool — …"). Moved, unchanged.
   - Old: `surfaceName === "slack" ? "Slack" : surfaceName`
   - New: `opts?.surfacePrompt?.label ?? surfaceName`, where the label is `"Slack"` from the adapter
3. **Mention syntax**, appended to the surface tool's `text` parameter description after a single space. Moved, unchanged.
   - Old (inline in `agent-tools/surface.ts`, only when `surfaceName === "slack"`): `To @-mention on Slack, use \`<@U…>\` for a person or \`<!subteam^S…>\` for a user group (ids appear in the conversation roster and in read / search results). A typed \`@name\` is plain text and pings no one; @here/@channel/@everyone never ping.`
   - New (Slack adapter `promptHints.mentionSyntax`, appended when the turn's tool surface supplies it): `To @-mention on Slack, use \`<@U…>\` for a person or \`<!subteam^S…>\` for a user group (ids appear in the conversation roster and in read / search results). A typed \`@name\` is plain text and pings no one; @here/@channel/@everyone never ping.`
4. **Link syntax line in `shared-core.md`.** Moved, unchanged.
   - Old: `{{#if web}}Use Markdown in your messages: \`[label](url)\`.{{/if}}{{#if slack}}Use Markdown text; Slack-style links are also supported: \`<https://example.com|label>\`.{{/if}}`
   - New template: `{{#if web}}Use Markdown in your messages: \`[label](url)\`.{{/if}}{{surfaceLinks}}`
   - New adapter `promptHints.linkSyntax`: `Use Markdown text; Slack-style links are also supported: \`<https://example.com|label>\`.`
5. **Autonomous-mode style line in `mode-autonomous.md`.** Moved, rendered bytes unchanged.
   - Old: `{{#if slack}}You're on Slack: keep each posted message to at most two sentences unless asked for more. You see only a recent window here; use the \`{{surfaceTool}}\` tool's read actions (or \`POST $AGENT_API_URL/v1/surface-context\`) to reach further back and into other channels.{{/if}}`
   - New template: `{{surfaceStyle}}`
   - New adapter `promptHints.autonomousStyle`: `You're on Slack: keep each posted message to at most two sentences unless asked for more. You see only a recent window here; use the \`slack\` tool's read actions (or \`POST $AGENT_API_URL/v1/surface-context\`) to reach further back and into other channels.`
   - `{{surfaceTool}}` became the literal `slack`. The old block rendered only when `input.surface === "slack"`, and then `surfaceTool` was always `slack`.
6. **Conversation-mode style lines in `mode-conversation.md`.** Moved, unchanged.
   - Old: `{{#if slack}}- This is Slack: keep each reply to a couple of sentences unless they ask for more.` + newline + `- Each Slack thread or DM is its own session, so \`history\` only searches this one. If someone refers to something you can't find here (an earlier request, a file, a brief), read the Slack history with \`POST $AGENT_API_URL/v1/surface-context\` (no body reads this conversation, including the DM above a thread; use \`before\`/\`match\` to page) before asking them to repeat it.{{/if}}`
   - New template: `{{surfaceStyle}}`
   - New adapter `promptHints.conversationStyle`: `- This is Slack: keep each reply to a couple of sentences unless they ask for more.\n- Each Slack thread or DM is its own session, so \`history\` only searches this one. If someone refers to something you can't find here (an earlier request, a file, a brief), read the Slack history with \`POST $AGENT_API_URL/v1/surface-context\` (no body reads this conversation, including the DM above a thread; use \`before\`/\`match\` to page) before asking them to repeat it.`

No other model-, user- or UI-visible string changed.

## How identity was verified

- **Byte-for-byte prompt and tool comparison (one-off, not committed):**
  - **Matrix:** 40 cases on both the base branch and this branch:
    - surface `slack`, `web`, `monitor`, `cron`, `bookface`, `Slack`, `""` and unset
    - × shapes DM, channel (fallback), autonomous spine, automation-with-destination and external-Slack channel
  - **Compared:** the full system prompt, `surfaceName`, and every tool's name, description and parameters.
  - **Result:** identical in all 40 cases.
  - **Drift found and fixed:** an earlier iteration dropped the Slack tool label and mention syntax for surface `""`. The fix resolves the tool surface with the agent's empty-name default.
  - **Second check:** an independent adversarial reviewer ran its own 40-case comparison and also found no drift.
- **Local checks:**
  - `tsrs --noEmit`, `eslint`, `oxlint --deny-warnings`, `prettier --check` and `knip` are clean.
  - The affected suites pass, about 75 files including the ones listed above.
- **CI/CD:** green on `292deab01` (workflow_dispatch run 41520053628).
  - An earlier run on `e5ee700da` had one failure, in `test/postgres-base-schema.test.ts`: "terminating connection due to administrator command" (an infrastructure flake in an unrelated schema test).
  - The next run, on `a5275f307`, was green.

## Live dev-instance QA

**Setup:**

- `bash scripts/dev-instance.sh up --surface both --sandbox e2b`, slot pool2, bot `@rbot2`.
- Sandbox backend: real E2B, with the key read from Labs SSM `/work-claw/prod/E2B_API_KEY`.
- Postgres: native PostgreSQL 16 (`DATABASE_URL` in the worktree `.env`).
- Slack: the dev workspace through the `slack-dev-pool` credential.
- Model: Claude subscription token.
- Slack messages were sent as the dev workspace user through the Slack Web API, using that user's saved browser session.

**Two key failures before the turns ran:**

- Regan's `anthropic` keychain key returned `401 invalid x-api-key` on the first DM turn.
- Labs SSM `/work-claw/labs/ANTHROPIC_API_KEY` also returned 401 when called directly.
- Effect: the first two DM attempts failed with "I hit an error". The instance was then restarted on the Claude subscription token.

**Results on this branch:**

1. **DM turn:** "what is the capital of France?" → "The capital of France is Paris."
2. **Channel @-mention** in fresh channel `#qa-ws8-pr4-1102` → threaded reply "Hey <@U06QWCEQFCH>, this is your ping — QA ws8-pr4 confirmed.", with a real `<@U…>` mention.
3. **Ambient, unprompted reply:**
   - A standing order set by mention ("answer quick arithmetic questions even if not mentioned") was stored through the `guidance` tool.
   - The unmentioned question "what is 48 divided by 6?" was judged `act` and answered "8" in thread.
   - One earlier ambient question was judged `ignore` by the ambient judge model. That code is untouched, and the base branch showed the same variance.
4. **Explicit decline:** a mention asking for no response ran an addressed turn. The transcript shows a `finish_silently` tool call and no post; run result `silent`.
5. **Web turn:** `POST /api/turn` through the portal → "The capital of Japan is Tokyo."

**Comparison with base:** the worktree was checked out at the base commit (`2621e471a`), the dev children were restarted, and the same flows were replayed (DM, mention, ambient act, decline, web). All replies were equivalent.

- **DM and web:** the captured model prompt envelopes (system prompt + tools) **hash identically** on base and branch (`0825f639…` DM, `041fd686…` web).
- **Channel mention and decline:** envelopes differ only in per-thread `thread_ts`, destination keys and the scheduled-work block. The tools are identical.
- **Ambient:** every Slack-related system line and the `slack` tool are identical. The only differences come from the ambient judge choosing a different actor (human asker vs `system:ambient`), which is untouched code.
- The dev instance is still running on slot pool2 for the integrator.

## Diff size (vs `regan/ws8-surface-contract`; `PR_NOTES.md` excluded)

|                     | Added   | Removed | Net      |
| ------------------- | ------- | ------- | -------- |
| Production (`src/`) | 80      | 25      | +55      |
| Tests               | 233     | 4       | +229     |
| **Total**           | **313** | **29**  | **+284** |

No generated or lockfile changes.

## Reviews

### Fresh-context adversarial review

An independent agent had repo access and read `AGENTS.md`. It reviewed `4e8a4e0ad` and ran its own 40-case base/branch comparison: no prompt drift and no branch-outcome drift.

Its findings, all resolved:

1. Hand-built test dependencies lacked the now-required `surfaces` (9 tests in 5 files). Fixed.
2. An `agent-tools` mention test built the tool without `surfacePrompt`. Fixed.
3. The parity test missed whitespace-only drift. It was replaced by the reference-based hint test, and the full comparison was re-run.
4. The mirror split's gating was inconsistent. Unified under `mirrored`.
5. Leftover Slack text. Listed above as intentionally untouched.

### Wall of shame review report

Reviewed commit: `292deab01`, round 3.

- **Triage:** claude-haiku-4-5. Relevant and always-reviewed lenses each got a fresh-context reviewer (claude-opus-5-5) that saw the diff and an author note on scope.
- **Earlier rounds:**
  - Round 1 (`e5ee700da`) asked for:
    - fewer capability flags (7 → 5 → 4)
    - `promptHints` as a property
    - neutral test names (`bookface` → `acme`; the `batch` account id went away with the golden test)
    - deleting the 201-line golden fixture
  - Round 2 (`a5275f3`) asked for one registry lookup per turn and a shared `surfaceToolPrompt` helper.

  All of those were applied.

**Open requests: author response.** The remaining "request changes" verdicts ask for one of these:

- dropping the `?? "Slack"` label fallback
- registering `monitor` as a surface to replace the `=== "monitor"` clause
- renaming `actingSlackUserId`
- moving the Slack container split into the adapter
- collapsing all flags into one bit, or deleting the capability set

Each of the first four changes rendered prompts or runtime behavior for unregistered surfaces, which this PR is scoped not to do, or edits sibling PR regions (the container split sits with the PR 5 surface-cache work). They are follow-ups for the series. Collapsing to one bit would rename `=== "slack"` instead of describing behavior. These lenses still show **Request changes**, and this needs a decision before the combined PR merges:

- Overengineering
- Band-aid fixes
- Duplication
- Config-matrix expansion
- Historylessness

| Lens                           | Reviewer                                              | Verdict         | Score  | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------- | --------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overengineering                | Independent reviewer (claude-opus-5-5, fresh context) | Request changes | 60/100 | The contract is now lean, but the PR still adds about +330 net lines to move four string checks behind a registry: a new `SurfaceToolPrompt` type and `surfaceToolPrompt` helper threaded through `AgentTurnInput`, `AgentToolsOptions`, `CoreToolOptions`, turn-support and agent-run, plus a 205-line orchestrator-harness test with its own `fakeSandbox`. Separately, the four capability flags are all true for the only registered surface and all false for everything else, so in this PR they amount to one bit spread across four config knobs.                                                                                                                                                                                                                                                      |
| Band-aid fixes                 | Independent reviewer (claude-opus-5-5, fresh context) | Request changes | 62/100 | The PR mostly removes `=== 'slack'` branches, but the one drift the parity check found (surface '' losing the Slack label) was patched by copying the agent layer's empty-name default into the orchestrator (`deps.surfaces.get(surfaceName \|\| 'slack')`). The tool name now has a default in four places: `surfaceTool`, `turnToolOptions`, the orchestrator `surfaceName`, and `toolSurface`, so the root cause was copied rather than removed. Separately, `mirrored` gates `container.split(':')[0]`, which is Slack's container encoding, and `liveReplies \|\| input.surface === 'monitor'` keeps a string-matched branch beside the flag meant to replace it.                                                                                                                                        |
| Duplication                    | Independent reviewer (claude-opus-5-5, fresh context) | Request changes | 58/100 | The empty-surface default `slack` now has another independent copy: the orchestrator's new `surfaceName \|\| 'slack'` mirrors the agent's `opts?.surfaceName ?? 'slack'`, alongside the existing `input.surface ?? 'slack'` and turn-support's `surfaceName: 'slack'`. The empty-surface `''` drift the author caught came from exactly these competing defaults, and the fix added a copy instead of one owner. The frame-label fallback `?? 'Slack'` also restates the Slack adapter's `label: 'Slack'` as a second literal, and `testSurfaces()` re-implements wiring's inline registry construction, so test and production surface sets can drift.                                                                                                                                                        |
| Hand-rolling                   | Independent reviewer (claude-opus-5-5, fresh context) | Accept          | 90/100 | The diff swaps `=== 'slack'` checks for capability flags and `promptHints` from the existing in-repo `SurfaceRegistry`, and keeps using the existing `applyPromptVars` templating. It adds no custom protocol, queue, transport or retry mechanics that duplicate an SDK or library, so the hand-rolling lens finds nothing to flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Non-durability                 | Independent reviewer (claude-opus-5-5, fresh context) | Accept          | 90/100 | Nothing in this diff stores mutable state in process memory. The new `SurfaceRegistry` Map is built once in wiring from static adapter definitions (code-level config, the same on every instance). `capabilities` and `promptHints` are constants. `surfacePrompt` is derived per turn from `input.surface`, so it is rebuilt the same way after a deploy, crash, or reroute to another instance. The durable reads (`getExternalSlackParticipantsDurable`, `setDeliveryState`) keep their Postgres backing and are now gated by capability flags.                                                                                                                                                                                                                                                            |
| Config-matrix expansion        | Independent reviewer (claude-opus-5-5, fresh context) | Request changes | 42/100 | The PR swaps one implicit `=== 'slack'` mode for four new hard-coded capability booleans (`mirrored`, `liveReplies`, `nativeActor`, `externalParticipants`). They are all true for the only registered surface and all false otherwise, so the possible matrix grows from 2 states to 16 with no surface that diverges. Several flags still feed Slack-only machinery (`actingSlackUserId`, `getExternalSlackParticipantsDurable`, the `split(':')` Slack container format), so a non-Slack surface setting them would be wrong. The orchestrator also now resolves surface identity four overlapping ways (`surface`, `surfaceTool`, `surfaceName` with the automation override, and `toolSurface` with the `\|\| 'slack'` fallback), alongside the remaining `?? 'Slack'` and `=== 'monitor'` special cases. |
| Provider drift                 | Triage (claude-haiku-4-5)                             | Not relevant    | —      | PR is platform-agnostic; it adds the machinery for future surfaces to diverge on capabilities and hints, but does not introduce surface-specific deviations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| God files                      | Triage (claude-haiku-4-5)                             | Not relevant    | —      | PR moves Slack-specific logic _out_ of orchestrator.ts and agent-tools.ts into a pluggable registry and adapter; responsibilities are separated, not accumulated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Mismatched UI                  | Triage (claude-haiku-4-5)                             | Not relevant    | —      | PR is backend-only (orchestrator, agent, prompt rendering); no UI changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Over-indexing on YC            | Triage (claude-haiku-4-5)                             | Not relevant    | —      | PR is generic Surface infrastructure; no YC-specific data, configuration, or defaults.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Regex                          | Triage (claude-haiku-4-5)                             | Not relevant    | —      | No regex added or modified; PR reads surface capabilities from structured registry instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| YC info leaking into public qm | Triage (claude-haiku-4-5)                             | Not relevant    | —      | No new copy, fixtures, or identifiers; PR is infrastructure-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Discarded error evidence       | Triage (claude-haiku-4-5)                             | Not relevant    | —      | No error handling changed; orchestrator still propagates surface-related failures; PR only changes how surface type is looked up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Arbitrary limits               | Triage (claude-haiku-4-5)                             | Not relevant    | —      | No new caps or bounds added; prompt hints and capability flags are data-driven from the registry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Historylessness                | Independent reviewer (claude-opus-5-5, fresh context) | Request changes | 55/100 | The diff adds the typed capability registry but keeps the old string-matched paths running beside it. `(surface?.capabilities.liveReplies \|\| input.surface === 'monitor')` still keys on a surface name, and `toolSurface?.label ?? 'Slack'` keeps the hardcoded Slack label for any unregistered surface. The new test then locks this legacy layer in by asserting that `monitor`, `acme`, empty and unset surfaces render 'over/via Slack', even though the tool says 'on acme'.                                                                                                                                                                                                                                                                                                                          |
| Over-testing                   | Triage (claude-haiku-4-5)                             | Not relevant    | —      | No test inflation; new test is a focused integration check (byte-identical prompts for Slack, correct label/hints for unregistered surfaces) and a contract test for a new surface type.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Prod-like QA                   | Triage (claude-haiku-4-5)                             | Not relevant    | —      | PR changes only prompt rendering and tool descriptions for non-Slack surfaces (which are untested in prod); Slack behavior is byte-identical to the base branch, verified by 40-case comparison in PR notes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Performance                    | Triage (claude-haiku-4-5)                             | Not relevant    | —      | One additional registry lookup per turn (constant cost, negligible vs. model request); prompt caching improved because hard-coded Slack branches are eliminated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Token performance              | Triage (claude-haiku-4-5)                             | Not relevant    | —      | No token changes for Slack (hints inlined in prompt templates, unchanged); unregistered surfaces get no hints (fewer tokens than hard-coded Slack text).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Honorable mentions             | Independent reviewer (claude-opus-5-5, fresh context) | Accept          | 92/100 | No added line in the diff is a code comment (`//`, `/* */`, or a TODO), including the new test file, the adapter hints, the registry helper and the protocol markdown edits, and the diff adds no screenshots or image files. The only `//` sequences are inside URL strings such as `https://api.test` and `$AGENT_API_URL` paths, so this lens has nothing to flag.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
