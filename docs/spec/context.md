# Context: prompt, guidance, memory, skills and personas

_Verified against `main` at d1de9e2d2 (2026-11-24). Statements were read in the code at that commit unless marked **[interpretation]**._

## In one paragraph

Context is everything the model is sent besides the conversation itself. It comes in two pieces. The **system prompt** orients the model: a short frame naming the kind of session, the organization's and the conversation's standing instructions, a fixed orientation text, and a list of blocks describing what this conversation has (where it is, files, sandboxes, crons, credentials, an index of skills). Core rebuilds it on every turn but sends the model a copy stored when the conversation started or was last compacted, so the bytes stay identical and the model provider's prompt cache keeps working; whatever changed since is stated in a note. The **environment note** is a small `<environment>` block appended to each incoming message: who is speaking, the local time, events, and recalled memory. Memory is a notebook of short facts per scope, kept in Postgres: a model extracts facts after a conversation goes quiet, and each turn recalls at most 6,000 characters of them. Skills are named instruction files kept in Postgres; the prompt lists only names and descriptions, and the model reads a skill when it needs one. A persona is a reusable bundle of instructions, skills, notes and credentials that a conversation can wear. Scopes, credentials and turns are defined in [scopes](./scopes.md), [credentials](./credentials.md) and [turns](./turns.md).

## One turn's context, traced end to end

Ada works at Acme. In the web app she opens her direct conversation with the agent and types "Draft the Q3 board update". The steps below all run inside `handleTurn` (`createOrchestrator` in `src/core/orchestrator.ts`), which calls the named functions.

1. **Standing instructions.** `resolve` on the resolution service (`createResolutionService`, `src/resolution/resolution-service.ts`) names the scope with `conversationScope` (`personal:ada@example.com`) and reads two texts from the config store's cache: the organization's and this scope's. `composeSoul` renders them as `## Organization instructions` and `## Conversation instructions (organization instructions take precedence)`. The scope text is dropped only when it equals the organization text exactly.
   _Channel:_ the scope is `channel:<ref>` and the second text is the channel's. _External audience:_ neither text is sent.
2. **Persona.** `routedPersonaTurn` (`src/personas/persona-service.ts`) finds no persona on Ada's conversation. Because the `personas` flag reaches Ada, it returns a short hint that becomes a `## Personas` block; with the flag off it returns nothing.
3. **What the turn may read.** `resolveTurnContext` (`src/resolution/turn-context.ts`) lists the notebooks to recall from (Ada's own, the organization's, her teams', plus other scopes when sharing is open, see [scopes](./scopes.md)) and the scopes to list skills from. It wraps the memory service in `disclosedMemory` (`src/memory/disclosure.ts`), which hides any fact that someone in the conversation may not see.
4. **Frame.** `handleTurn` picks one protocol file from `src/resolution/protocols/` and fills its `{{variables}}` with `applyPromptVars`. Ada gets `mode-conversation.md` ("You are QM, in a live private 1:1 with Ada…").
   _Slack:_ a surface that gives the agent a posting tool gets `mode-autonomous.md`. _Cron, webhook or other automated run:_ `mode-fallback.md`. _Chat beside a published app:_ `mode-app-edit.md`, which also skips memory and most blocks. _`web_dm_spine` flag:_ `mode-web-spine.md`.
5. **Body.** The body is concatenated in this order: the standing instructions; the persona block, if any; `shared-core.md` (orientation, about 4 KB); a notice for external audiences; memory strategy lines; one sentence explaining `## What you remember`; `Additional skill sources: …`; `## Deployment tool hints`; then `appendTurnGuidance` (`src/core/orchestrator/turn-prompt.ts`) adds connected-app and admin sections; `finishSystemPrompt` adds side-chat text, `user-reply-rules.md`, swarm and placement lines; and `renderSystemContext` (`src/core/orchestrator/prompt-blocks.ts`) appends the system context blocks in one fixed order: Where you are, Ephemeral session, Project home channel, Where scheduled tasks post, Who's in this conversation, Files, Sandboxes, Model access, Crons scheduled here, Personas, Credentials, Skills. A list of connector tools (`connectorToolsNote`) comes last.
6. **Skills index.** `skillsIndex` (`src/skills/materialize.ts`) renders the `## Skills` block: one line per published skill in Ada's scope and the organization scope, name and description, inside a 12,000-character budget. Descriptions are shortened evenly to fit; below 60 characters each they are dropped and only names remain. `filterConnectorSkills` first removes skills for services Acme has not connected.
7. **Snapshot.** `systemPromptSnapshot` (`src/core/orchestrator/prompt-snapshot.ts`) stores `{ epoch, frame, body }` for the session the first time, and returns the stored copy afterwards. The model is sent the stored frame and body. `promptChanges` compares the stored body with the fresh one line by line and returns `## Changed since the system prompt` with the lines added and removed; `turnFrameNote` restates the frame when this turn's differs from the stored one (an automated run in a conversation a person started).
8. **Recall.** `memoryRecallQuery` (`src/memory/semantic-recall.ts`) builds a query from the last four messages and Ada's text. `recallAcrossScopes` (`src/memory/cross-scope.ts`) asks every readable notebook and takes one fact from each source in turn until 6,000 characters are used. `memoryRecallDelta` (`src/memory/recall-delta.ts`) removes what an earlier message in the model's window already showed, so later turns add only new or changed facts.
   _Channel:_ the notebook is the channel's, and a fact from Ada's own notebook is shown there only if `disclosedMemory` allows it for everyone present. _External memory provider:_ the router calls it in parallel for the scopes routed to it; its rows appear under their own heading (see [Contracts](#contracts)).
9. **Environment note.** `segmentEnvironment` (`src/core/orchestrator/run-segment.ts`) joins, in this order and skipping what is empty: the sender line (omitted for the owner of a DM), `Local time: …`, a load line when the default sandbox is shared or strained, the attachment list, turn events ("The sender is an org admin."), the frame and prompt-change notes, a roster change, a guidance change, and `## What you remember`. `environmentNote` wraps them in `<environment>`. `userPromptText` (`src/agent/replay.ts`) appends the note to Ada's text, and it is saved in the message item's `body.environment`, so later turns replay it unchanged.
10. **Reading a skill.** The model calls the `skills` tool. `useSkill` (`createTurnSkills`, `src/skills/turn-skills.ts`) returns the skill's `SKILL.md`. Only when the skill ships files does it write them to the sandbox, under `.agent-skills/<conversation key>/<skill id and version hash>/<name>/`.
11. **Capture.** After the reply, `startMemoryCapture` (`src/core/orchestrator/settle.ts`) hands the exchange to the memory strategy. The default, `createPerTurnStrategy` (`src/memory/strategies/per-turn.ts`), buffers Ada's turns and, once the conversation is quiet for three minutes or ten turns have accumulated, sends them to a model with `MEMORY_EXTRACTION_PROMPT`. The facts returned ("Prefers board updates under one page") are written with `capture` to `memory_facts` under `personal:ada@example.com`, each with a sensitivity label and the scope it was said in. Only turns a person wrote in a top-level conversation are captured; automations, subagents, bots, ephemeral sessions and paused or cancelled turns are not.
12. **A later conversation.** Next week Ada starts a new conversation. Step 8 finds the fact (facts saved from the same session are never recalled into it) and the note shows it under a heading with her name, in an `untrusted-data` block. When that conversation's history is later compacted (see [turns](./turns.md)), the snapshot epoch advances, so a fresh system prompt replaces the stored one, and the recall is sent again in full because the message that recorded what was shown is no longer in the window.

## The nouns

| Noun                        | Plain meaning                                                                                                                                                                                        | Where it lives                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **System prompt**           | The frame followed by the body. Sent from the snapshot, not from this turn's build.                                                                                                                  | `handleTurn`; table `prompt_snapshots`                                                                              |
| **Frame**                   | The opening section saying what kind of session this is. Five files.                                                                                                                                 | `src/resolution/protocols/mode-*.md`                                                                                |
| **SOUL (guidance)**         | One text of standing instructions per scope, with a version number; past revisions are kept in the same row. "SOUL" in code, "guidance" in the tool and UI. The organization has a built-in default. | `src/resolution/config-store.ts`; table `soul_configs` (`soul_history` is the older revision table, merged on read) |
| **Channel standing orders** | A channel's instructions for when the agent speaks unprompted. Read by the ambient judge and the reply check, not placed in the system prompt. See [surfaces](./surfaces.md).                        | `src/surface-cache/channel-policy-store.ts`; table `channel_policy`                                                 |
| **System context block**    | One `##` section of per-conversation inventory, rendered in a fixed order.                                                                                                                           | `SystemContextBlocks` in `src/core/orchestrator/prompt-blocks.ts`                                                   |
| **Prompt snapshot**         | The stored frame and body for one session, replaced when the history is compacted.                                                                                                                   | `src/core/orchestrator/prompt-snapshot.ts`; `prompt_snapshots`                                                      |
| **Environment note**        | The `<environment>` block appended to a message.                                                                                                                                                     | item `body.environment` in `items`                                                                                  |
| **Notebook**                | All live facts of one scope. Facts are added, edited and soft-deleted.                                                                                                                               | `src/memory/memory-service.ts`; table `memory_facts`                                                                |
| **Fact**                    | One short text with `sensitivity` (`ordinary`, `unknown`, `sensitive`, `restricted`), `sources` (scopes it was said in), author and session.                                                         | `src/memory/facts.ts`; `memory_facts`                                                                               |
| **Recall**                  | Choosing which facts go into this turn's note.                                                                                                                                                       | `src/memory/cross-scope.ts`; item `body.memoryRecall` records what was shown                                        |
| **Capture**                 | Writing facts: automatic (after turns) or explicit (the `memory` tool, the API).                                                                                                                     | `src/memory/strategies/`, `src/memory/classification.ts`                                                            |
| **Vector**                  | An embedding of one fact, used to rank recall. The embedding model is one organization setting.                                                                                                      | `src/memory/postgres-vector-store.ts`; table `memory_fact_vectors`; the model id in `base_model_configs`            |
| **Memory provider, route**  | An external memory server, and the rule saying which scopes use it.                                                                                                                                  | `src/memory/provider-config.ts`, `provider-router.ts`; env `MEMORY_PROVIDER_CONFIG`                                 |
| **Brain, binding**          | A provider registered at runtime, and its link to personal scopes.                                                                                                                                   | `src/memory/registry.ts`; table `memory_registry`, row `org`                                                        |
| **Outcome**                 | What one provider answered for one scope: `ok`, `empty`, `denied`, …                                                                                                                                 | `src/memory/provider-outcome.ts`; item `body.memoryRecallOutcomes`                                                  |
| **Tidy**                    | A nightly cron per personal, channel, group or persona notebook in which the agent merges and deletes facts.                                                                                         | `src/memory/tidy.ts`; table `memory_tidy_profiles`                                                                  |
| **Skill**                   | A named `SKILL.md` body plus optional text files, owned by a scope, with status `draft`, `reviewed`, `published` or `archived` and an HMAC signature.                                                | `src/skills/skill-store.ts`; table `skills`                                                                         |
| **Skill pack, bundle**      | A git repository or MCP server skills are imported from, and the shared files of one pack.                                                                                                           | `src/skills/skill-pack-store.ts`, `skill-bundle-store.ts`; tables `skill_packs`, `skill_bundles`                    |
| **Persona**                 | A scope `persona:<id>` with name, instructions and icon that a conversation wears. Roles: owner, write, read.                                                                                        | `src/personas/`; tables `personas`, `persona_access`, `persona_versions`; column `sessions.persona_id`              |
| **Suggested activity**      | One of the prompts offered on the new-chat screen.                                                                                                                                                   | `src/suggestions/`; tables `suggested_activity_profiles`, `activity_seeds_configs`                                  |

## The parts

### Prompt assembly: `src/core/orchestrator.ts` and `src/core/orchestrator/`

**Job.** Build the system prompt and the environment note. `turn-prompt.ts` holds three stages of assembly, `prompt-blocks.ts` renders individual blocks, `prompt-snapshot.ts` keeps the stored copy, `run-segment.ts` builds the note.

**Key idea.** Anything that can change between turns must not change the bytes already sent, so that the provider's prompt cache holds **[interpretation]**. The system prompt is frozen per session, and time, sender, events and memory travel in the note attached to the newest message.

**Surprising.** The assembly is not in one place: most of the ordering in step 5 is inline in `handleTurn`, interleaved with credentials, sandboxes and approvals. Adding a block means adding its name to `SYSTEM_CONTEXT_ORDER`; a block not in that list is never rendered. Editing `shared-core.md` does not reach running conversations as a new prompt: each one receives the edit as a line diff in its note until its next compaction.

### Standing instructions: `src/resolution/`

**Job.** `resolution-service.ts` composes the two SOUL texts; `config-store.ts` stores them, as one of its settings tables; `turn-context.ts` decides which notebooks and skill scopes a turn reads; `protocols/` holds eight Markdown files, under 10 KB together.

**Key idea.** Instructions layer from general to specific: organization, then scope, then persona. The texts are concatenated; the only precedence is the sentence telling the model that organization instructions win.

**Surprising.** `getSoul` reads a per-tenant in-process cache that `refreshSecurity` reloads at the start of each turn. The `guidance` tool (`src/agent/agent-tools/control.ts`) has two scopes that write to two different tables: `conversation` writes the SOUL, `channel` writes the standing orders. A SOUL edit made in another conversation is announced once by `guidanceUpdateEvent` with the lines added and removed.

### Memory: `src/memory/`

**Job.** Store facts, decide who may see each one, recall them, capture new ones, and optionally route all of that to external servers. About half of the directory is external-provider machinery.

**Key idea.** One interface, `MemoryService`, wrapped in layers built in `src/wiring.ts`: `createPostgresMemoryService` (the table), `createSemanticMemory` (vector ranking), `createRegistryMemoryService` (providers and routes), `withMemoryTidy`, `classifiedMemory` (sensitivity labels), and per turn `disclosedMemory` (audience filter).

**Surprising.**

- Recall is not always vector search. With no embedding model set for the organization, `recentCandidates` returns the newest facts first. With one set, `search` in `postgres-vector-store.ts` preselects candidates by a binary sketch, ranks them by cosine similarity (at least 0.2), and lets facts not yet embedded join by recency. Any embedding or database error falls back to newest-first.
- The notebook is not append-only: `edit` rewrites a fact, `delete` sets `deleted_at`, a capture whose text matches an existing fact (ignoring case) only merges provenance, and the tidy cron merges and deletes nightly.
- The capture buffer is a `Map` in process memory. A restart during the quiet period loses the buffered turns.
- A turn in a notebook's tidy conversation, and anything it starts, reads and writes the notebook alone, never an external provider. Core recognizes it by the cron the tidy service created, not by its title.
- `memory/MEMORY.md` is not a file. `read` in `src/tools/primitives.ts` redirects that path to the notebook; nothing intercepts a write to it, so writing it does not change memory.
- `bench.ts` is a scoring harness for `scripts/memory-bench.ts`, not part of a turn.

### Skills: `src/skills/` and `skills-seed/`

**Job.** Store skills, seed the built-in ones, import packs, list skills in the prompt, and place a skill's files on a sandbox when it is read. Most of the text under `skills-seed/` is the design templates of one skill.

**Key idea.** A skill is a database row, not a file on a computer. Seeds, the deployment layer and packs all go through one function, `upsertSeedSkill` (`seed.ts`): create, review, publish. They differ only in the `createdBy` marker and where they read from. Skills saved through the API take the same three steps in `src/api/app-skills.ts`.

**Surprising.**

- Four sources feed the organization scope: `skills-seed/`, each `plugins/*/skills` directory (today only the onboarding skill), the deployment layer's `skills/` directory (see [deployments](./deployments.md)), and packs (which an admin may also import into other scopes). People and agents add skills to personal, channel, group and persona scopes through `POST /v1/skills`; a skill reaches the organization or a team scope only by promotion.
- A seed skill an admin archived stays archived (`respectArchived`). A name already owned by another source is skipped, not overwritten.
- Reading a skill with no files touches no sandbox. Skills from other scopes are named only in `Additional skill sources:` and are found with the tool.
- Skills carried in from a shared scope are sent through the security screen first (`createSkillScreen`, see [security](./security.md)).
- `normalize.ts` maps any repository's frontmatter onto the manifest; there is no per-repository code. A pack skill is excluded when its scope hint is personal, it is flagged private, its name collides, it ships a binary file, or it is malformed.

### Personas: `src/personas/`

**Job.** Store personas, roles and versions; resolve the persona for a turn; hand ownership to an admin when the last owner leaves.

**Key idea.** A conversation wears a persona; it does not live in one. The conversation still decides who is present and where files and crons land. The persona adds a `## Persona: <name>` block after the standing instructions, its scope as an extra read-only source of skills and notes, and its keychain grants.

**Surprising.** Memory is the exception: a channel or group that pins a persona saves to and recalls from the persona's notebook, shared by every conversation using it. A turn falls back to the room's own notebook when the room has anyone external or no member list. The sender needs a role on the persona on every turn; without one the persona is skipped and the block says so. A `turn_start` decision rule with the action `use_persona` can route a conversation to a persona, which the conversation then keeps; a pinned persona takes precedence. A persona may carry a default model (the runtime selection of its scope, see [models](./models.md)), applied when a conversation that has no model yet takes the persona. A sweep every five minutes gives a persona whose last active owner left to the org admin with the oldest grant. Roles are in `persona_access`, not in the general grants table; a persona needs an owner role, which grants do not have **[interpretation]**.

### Onboarding and suggestions: `src/onboarding/`, `plugins/onboarding/`, `src/suggestions/`

**Job.** Greet a first-time user and propose things to do.

**Key idea.** Neither has its own state machine. Onboarding status is a fact in the person's notebook (`Onboarding: completed v2 on <date>.`) written by the seeded `onboarding` skill. Suggestions are the last reply of a nightly managed cron that returns five JSON objects.

**Surprising.** Core does not read the onboarding fact on turns. The web client starts onboarding by sending `proactiveOpener`, which makes `PROACTIVE_OPENER_PROMPT` the turn's input; `detectOnboardingStatus` is used only by the admin users route. The suggestions cron skips a fire when the person has not asked for suggestions since the last one.

### Compaction as it affects context: `src/agent/context-compaction.ts`, `src/agent/context-snapshot.ts`

**Job.** `forModelContext` returns the latest summary plus the items after it. `retainedSnapshot` finds the last message in that window that recorded what was shown (roster, guidance version, recalled facts).

**Key idea.** "What has the model already been told" is read from the window itself. When compaction removes the recording message, the next turn sends the full version again.

**Surprising.** Compaction is the only event that replaces a session's stored system prompt.

### Routes

`src/api/routes/surface.ts` holds the member and agent routes for memory (`/v1/memory/*`) and skills (`/v1/skills*`); `memory-access.ts` builds the disclosure view for a request; `memory-brain.ts`, `admin/memory.ts`, `admin/memory-registry.ts`, `personas.ts`, `skill-packs.ts` and `suggested-activities.ts` are named for what they serve. `context-policy.ts` reads and writes channel standing orders. `context.ts` is not prompt context: it pulls message history from a surface on request (see [surfaces](./surfaces.md)).

## Optional and per-deployment

| What                                   | Turned on by                                                                                                          | Default                                       | When absent                                                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| External memory providers              | env `MEMORY_PROVIDER_CONFIG` (JSON)                                                                                   | unset                                         | Every scope kind uses the built-in notebook with automatic capture.                                                           |
| Registry brains                        | rows in `memory_registry` written by an admin, or by a member through `PUT /v1/memory/brain`                          | none; member brains allowed                   | No external call.                                                                                                             |
| Procedure provider                     | a provider of type `memorable` in `MEMORY_PROVIDER_CONFIG`, and its CLI installed on the host                         | off                                           | Not called.                                                                                                                   |
| Vector-ranked recall                   | organization setting `memory-embedding-model`, and the Postgres `vector` extension                                    | unset                                         | Newest facts first. `src/migrate-main.ts` registers the vector tables only when the database offers the extension.            |
| Recall breadth                         | env `MEMORY_RECALL`: `off`, `writable` (own notebook only), `visible`                                                 | `visible`                                     | n/a                                                                                                                           |
| Capture                                | env `MEMORY_CAPTURE`: `off`, `writable`                                                                               | `writable`                                    | n/a                                                                                                                           |
| Capture strategy                       | env `MEMORY_STRATEGY`: `per-turn`, `agent-only`                                                                       | `per-turn`                                    | `agent-only` captures nothing automatically and adds five lines telling the model it curates memory itself.                   |
| Capture timing                         | env `MEMORY_CAPTURE_QUIET_MS`, `MEMORY_CAPTURE_MAX_TURNS`                                                             | 180000, 10                                    | `0` captures after every turn.                                                                                                |
| Seed skills                            | env `SEED_SKILLS`, `SKILLS_SEED_DIR`, `PLUGIN_SKILLS_DIRS`                                                            | on, `./skills-seed`, every `plugins/*/skills` | With `SEED_SKILLS=false` nothing is installed from those directories. With no visible skill the `## Skills` block is omitted. |
| Deployment-layer skills and tool hints | env `DEPLOYMENT_LAYER` naming a directory                                                                             | unset                                         | No `## Deployment tool hints`, no layer skills.                                                                               |
| Skill packs                            | rows in `skill_packs` created by an org admin                                                                         | none                                          | Only seeded and saved skills exist.                                                                                           |
| Pack background sync                   | env `SKILL_SYNC_POLL_MS` above 0                                                                                      | 0                                             | No polling; an admin can still sync one pack by request.                                                                      |
| Skill signing key                      | env `SKILL_SIGNING_SECRET`                                                                                            | unset                                         | A random key per process, so `review` and `promote` in the skill store reject a skill signed by another process.              |
| Skills for a connected service         | a configured connector for that provider, or app connections                                                          | not configured                                | Those skills (for example `google-workspace`, `linear`, `zoom`) are left out of the index and the tool.                       |
| Personas                               | feature flag `personas`                                                                                               | off                                           | No persona applies and no hint is shown; a conversation that already has one is told personas are off.                        |
| Organization welcome seeds             | feature flag `company_welcome` and a row in `activity_seeds_configs`                                                  | off                                           | The starter activities in env `WEB_UI_SUGGESTED_ACTIVITIES` (see [web-clients](./web-clients.md)).                            |
| Generated suggestions                  | env `SUGGESTED_ACTIVITIES_ENABLED`, on an instance that runs background work; optional `SUGGESTED_ACTIVITIES_CONTEXT` | on                                            | `GET /v1/suggested-activities` answers `enabled: false`, the other two routes answer 404, and no cron is created.             |
| Names in the prompt                    | env `ORG_BRAND_SELF_LABEL`, `ORG_BRAND_ORG_NAME`, or a row in `branding_configs`                                      | "QM", "this organization"                     | The defaults.                                                                                                                 |
| Organization instructions              | a row in `soul_configs` for the organization scope                                                                    | a built-in two-sentence text                  | The built-in text.                                                                                                            |

In a [multi-tenant deployment](../SPEC.md#deployment-shapes) the SOUL cache, the registry snapshot, the seed install and the vector indexer each run per tenant; the indexer takes tenants in rotation.

## Where the complexity lives

- **Two records of what the model has seen.** The system prompt has a database row (`prompt_snapshots`). Roster, guidance version, recalled facts and app source are recorded in message item bodies and found again with `retainedSnapshot`. A SOUL edit is announced through both: once by `guidanceUpdateEvent`, and by `promptChanges` on every later turn until compaction, because nothing records that the change note was already sent. Wall of shame: Token performance ("Per-turn `<environment>` note").
- **Standing instructions from many sources.** Organization SOUL, scope SOUL, persona instructions, channel standing orders, protocol frames, `shared-core.md`, deployment-layer hints, surface-supplied instructions and style hints, and hard-coded admin sections all reach the model as instruction text, each stored and edited differently. Scope SOUL that repeats organization text is sent twice unless identical. Wall of shame: Token performance ("Redundant system prompt").
- **Memory options multiply.** Three recall modes, two capture modes, two strategies, embedding on or off, env routes with `recall`, `capture`, `manage` and `failOpen` each, registry bindings on top, and the notebook-only rule for tidy turns. Each combination is a different path through six wrappers of one interface.
- **Two ways to configure one thing.** Env providers and registry brains both end in `createRoutedMemoryService`. The registry builds its providers by rendering JSON and passing it back through `parseMemoryProviderConfig`.
- **Abstractions with one implementation.** `FactStore` has only the Postgres implementation. `BRAIN_PRESETS` has one entry. Of the two `MemoryStrategy` kinds, one is a list of prompt lines.
- **Per-fact text in recall.** Each fact carries its own `(date)`. Scope labels are printed once per block and a claim held by several sources is shown once. Wall of shame: Token performance ("Per-fact provenance in memory").
- **Transitional code still present.** The `memory_facts` migration imports the older `memory_revisions` table once. `soul_history` rows are merged into `soul_configs` on read. The persona migration moves rows out of `persona_channel_defaults`. Onboarding status is found by a regular expression over notebook text.

## Contracts

### Recalled memory in the prompt

Each turn carries at most 6,000 characters of recall across all sources (`RECALL_MAX_CHARS`). Each notebook, and each provider within it, gets a heading `### <scope label>` or `### <scope label> · <provider label>` followed by one fenced `untrusted-data` block. Inside it QM replaces triple backticks, rewrites `</` as `<\/` and prefixes heading-like lines with a backslash, so a fact cannot close its block or pose as a heading. Notebook rows read `- (YYYY-MM-DD) text`. The `memory` tool's search shows notebook facts as `#<id>` and provider facts that can be forgotten as `<provider id>:<fact id>`.

### `MEMORY_PROVIDER_CONFIG`

A JSON object `{ "providers": [...], "routes": [...] }`. The provider id `default` is reserved for the built-in notebook.

| Provider field                                                     | Meaning                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                               | Lowercase letters, digits, hyphens; starts with a letter; at most 63 characters.                                                                                                                                                                                                                                                                                  |
| `type`                                                             | `mcp` or `memorable`.                                                                                                                                                                                                                                                                                                                                             |
| `url` (mcp)                                                        | `https://`, or `http://` on `localhost`, `127.0.0.1`, `*.internal`, `*.flycast`, `*.local` or an origin in `PRIVATE_NETWORK_ALLOWED_ORIGINS`. No credentials or fragment.                                                                                                                                                                                         |
| `timeoutMs` (mcp)                                                  | Read timeout, 1 to 30000, default 3000. Writes and forgets always get 30 seconds.                                                                                                                                                                                                                                                                                 |
| `attestActor` (mcp)                                                | Boolean, default false. See below.                                                                                                                                                                                                                                                                                                                                |
| `read`, `write` (mcp)                                              | `tool`, `clientIdEnv`, `clientSecretEnv` (names of env variables holding an OAuth client-credentials pair), and optional argument names `queryArg`, `contentArg`, `factsArg`, `actorArg`, `scopeArg`, `maxCharsArg`, `inputArg`, `replyArg`, `capturedAtArg`, `sourceArg`, `idempotencyArg`. `write` is optional. `factsArg` and `contentArg` exclude each other. |
| `bin`, `passEnv`, `injectTimeoutMs`, `recordTimeoutMs` (memorable) | The CLI to run (default `memorable`), extra env names to pass, and timeouts (defaults 15000 and 120000).                                                                                                                                                                                                                                                          |

| Route field | Meaning                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider`  | A provider id or `default`.                                                                                                                                                                |
| `scopes`    | Scope kinds (`personal`, `channel`, `group`, `team`, `org`, `persona`) or exact scope ids. A kind no route serves has no memory.                                                           |
| `capture`   | `off` (default), `explicit` (deliberate writes only), `automatic` (also post-turn capture). An `mcp` provider without `write` allows only `off`; `memorable` allows `off` and `automatic`. |
| `recall`    | Boolean, default true.                                                                                                                                                                     |
| `manage`    | Whether this route supplies notebook reads, edits and deletes. Default true for `default`, false otherwise. The first managing route wins.                                                 |
| `failOpen`  | Default true for external providers, false for `default`. When false, a failure of this provider fails the whole recall or search for the scopes it serves.                                |
| `label`     | Shown in the recall heading.                                                                                                                                                               |

A `memorable` provider runs its CLI with an allow-listed environment (`BASE_ENV_ALLOWLIST` in `src/memory/memorable/config.ts`): `inject` on recall, and on automatic capture `record` with a tool-call trace of the session, secret values masked. It takes no explicit writes.

Routes run in this order: the env routes (or, with no env variable, one notebook route for every scope kind with automatic capture), then registry bindings. Only a conversation's own writes reach a provider other than the notebook: the `memory` tool's add, `POST /v1/memory/facts`, and post-turn capture. Admin writes, a member's own edits through `/v1/memory`, onboarding status and writes into another scope's notebook change the notebook alone.

### gbrain recipe

The one external provider this repository tests against is gbrain, through the vendored contract in `test/fixtures/gbrain/`. `test/gbrain-memory-provider.test.ts` loads this document as `MEMORY_PROVIDER_CONFIG` and checks the calls it produces against that contract, so change the two together.

```json
{
  "providers": [
    {
      "id": "gbrain",
      "type": "mcp",
      "url": "https://gbrain.acme.example",
      "attestActor": true,
      "timeoutMs": 3000,
      "read": {
        "tool": "memory_recall",
        "clientIdEnv": "GBRAIN_RO_CLIENT_ID",
        "clientSecretEnv": "GBRAIN_RO_CLIENT_SECRET",
        "maxCharsArg": "max_chars"
      },
      "write": {
        "tool": "memory_write",
        "clientIdEnv": "GBRAIN_RW_CLIENT_ID",
        "clientSecretEnv": "GBRAIN_RW_CLIENT_SECRET",
        "factsArg": "facts",
        "idempotencyArg": "idempotency_key"
      }
    }
  ],
  "routes": [
    {
      "provider": "default",
      "scopes": ["personal", "channel", "group", "team", "org", "persona"],
      "capture": "automatic"
    },
    {
      "provider": "gbrain",
      "scopes": ["personal"],
      "capture": "explicit",
      "manage": false,
      "failOpen": true,
      "label": "gbrain"
    }
  ]
}
```

- Every scope kind keeps the notebook as its first route, with automatic capture. Only a person's own DM also calls the provider: recall through `memory_recall`, and explicit writes through `memory_write`.
- `attestActor` sends the attested-actor headers, so the provider answers with that member's own facts and refuses a channel audience.
- `failOpen: true` keeps turns answering from the notebook when the provider is down or slow. `timeoutMs` bounds recall only; writes get 30 seconds.
- `manage: false` means forgetting or editing a fact changes the notebook alone. A provider connected through the memory registry forgets by ref instead.
- To verify against a live provider: its tool list shows `memory_recall` taking `acting_user`, `max_chars` and `query`, and `memory_write` taking `acting_user`, `facts` and `idempotency_key`; a fact stated in a DM appears in the `memory` tool result's `outcomes` as `committed`; a new DM's user entry carries `payload.memoryRecallOutcomes` with outcome `ok` for the provider; and a channel turn's has no entry for it.

### MCP provider calls

- **Read.** Arguments `query` and `acting_user` by default, plus `scopeArg` (the scope id) and `maxCharsArg` when mapped. On a turn a person wrote, the query is their message, cut to 2,000 characters; otherwise the recall query.
- **Read result.** `structuredContent.facts`, a list of `{ id, text, date?, kind? }` with non-empty string `id` without whitespace, gives one row per fact; anything else in `facts` fails the read with `malformed_fact`. Without `facts`, the text becomes one row per line. A result coded `actor_unlinked` is empty.
- **Write.** `content` (facts joined by newlines) and `acting_user` by default. With `factsArg`, a list of `{ "fact", "provenance" }` where `provenance` is the scope id the facts came from, at most 20 per call; a larger burst is sent as consecutive calls whose idempotency key gains `:1`, `:2`, … The `memory` tool and `POST /v1/memory/facts` refuse more than 20 facts.
- **Idempotency.** For explicit writes `idempotencyArg` receives a UUID derived from the organization id, the turn, the scope and the fact text, so a retry within one turn repeats the key. Automatic capture sends the run id.
- **Result status.** `structuredContent.status: "pending"` is recorded as pending, any other success as committed. Codes are read only from `structuredContent` on success, from `structuredContent` or a JSON text block on error.
- **Limits.** A response is cut off at 1 MB. A provider without `scopeArg` is refused at startup unless it serves one scope id, the organization scope, or only personal scopes on routes that do not manage a notebook.

### Attesting the member (`attestActor`)

With `attestActor: true`, every request of a call also carries the attested-actor headers ([scopes](./scopes.md#contracts)). The model cannot set these. A route to an attested provider may list only `personal` or `personal:<id>`, and the provider cannot manage a notebook; other configurations are refused at startup. QM calls an attested provider only for the scope's own member in their own private conversation. Any other read is withheld without a call; any other write is recorded `denied` with code `private_only`. An id that is not 1 to 256 visible ASCII characters is recorded `denied` with `invalid_actor`.

### Provider outcomes

Every recall, search, explicit write and forget records one outcome per provider and scope: `{ provider, scope, outcome, ms, code?, ref?, added? }`. Recall outcomes are stored on the turn's user message item as `body.memoryRecallOutcomes`.

| Outcome                | Meaning                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`, `empty`          | The provider returned rows, or none.                                                                                                                                                      |
| `committed`, `pending` | A write or forget was acknowledged; `pending` means the provider finishes it later.                                                                                                       |
| `unknown`              | A write or forget timed out, or the connection broke after the request was sent. It is not retried.                                                                                       |
| `denied`               | HTTP 401 or 403, or a code among `actor_not_attested`, `actor_unlinked`, `argument_mismatch`, `scope_denied`, `insufficient_scope`, `permission_denied`, `invalid_actor`, `private_only`. |
| `timed_out`            | A read exceeded `timeoutMs`.                                                                                                                                                              |
| `failed`               | Any other error; `code` is the provider's code, `http_<status>`, or `unreachable` when the request was never sent.                                                                        |
| `disabled`             | A registry binding exists for the scope but cannot serve.                                                                                                                                 |

Problems derived from outcomes carry `{ code, provider, detail, fix }` with `code` one of `memory_provider_denied`, `memory_provider_timeout`, `memory_provider_failed`, `memory_provider_disabled`, `memory_provider_unknown`. The `memory` tool prints each as `[code] detail Fix: …`. `POST /v1/memory/search`, `POST /v1/memory/facts` and `DELETE /v1/memory/facts` answer `502` with `application/problem+json`: `status`, `title`, `detail`, `problems`, plus the partial result (`results`, or `added`, `scopeId` and `outcomes`, or `forgotten`). A write's `502` can follow facts the notebook already stored.

### Troubleshooting

| Message or outcome                                                                                                                               | Cause                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Startup: `must not carry credentials or a #fragment`, `must use HTTPS or a recognized private HTTP host`, `is not a valid URL (value not shown)` | The provider `url` breaks the rule above. The value is never echoed.        |
| Startup: `sets attestActor, so it cannot manage a notebook`                                                                                      | Set `"manage": false` on that route.                                        |
| Startup: `may serve only personal scopes`                                                                                                        | An attested provider is routed to a shared scope.                           |
| Startup: `no scopeArg, so the server cannot tell apart the scopes it serves`                                                                     | Map `scopeArg` on `read` and `write`.                                       |
| `denied` with `http_401`, `http_403` or an OAuth code                                                                                            | The provider rejected QM's client credentials.                              |
| `denied` with `actor_not_attested`                                                                                                               | The provider has not granted QM's client the right to attest.               |
| `empty` or `denied` with `actor_unlinked`                                                                                                        | The provider has no member linked to this person id.                        |
| `timed_out`; write outcome `unknown`                                                                                                             | Latency above `timeoutMs`; a write above 30 seconds or a broken connection. |
| `failed` with `malformed_fact`                                                                                                                   | `structuredContent.facts` has the wrong shape; none of that answer is used. |

### Memory registry

One record (table `memory_registry`, row `org`) holds every brain, every binding and the member-brain switch. Each memory operation reads its version and serves from one snapshot. `schema` is `2` while the record holds a member-owned brain and `1` otherwise. A record a build cannot read leaves its last valid snapshot serving.

- **Brain.** `{ id, preset, url, auth.clientId, label, timeoutMs?, owner? }` and a write-only client secret, stored encrypted with a key derived from `CONNECTOR_SECRET_KEY`. One endpoint and one client-credentials pair for reads, writes and forgets; always attested. The only preset is `gbrain-v1`: read tool `memory_recall` (`query`, `max_chars`), write tool `memory_write` (`facts`, `idempotency_key`), forget tool `forget_fact` (`id`, `request_id`). `url` must be public `https://`; changing it clears the secret; a request that sets `clientSecret` must restate `url`.
- **Binding.** `{ id, brain, scope, capture, recall, failOpen, label }`. `scope` is the kind `personal` or one `personal:<id>`. `capture` is `off` (default) or `explicit`. A binding never manages a notebook.
- **Member brain.** A member connects their own through the agent, on a turn they sent that is still running: `GET`, `PUT` (`url`, `clientId`, `label`; never `clientSecret`) and `DELETE /v1/memory/brain`. Its id derives from the owner and it binds only to their personal scope. The secret is entered through a single-use link minted with `POST /v1/keychain/drops` and body `{ "memoryBrain": "<brain id>", "purpose": "…" }`; it never reaches the agent.
- **Admin routes** (org admin or owner, audited): `GET /v1/admin/memory-registry`; `PUT` and `DELETE /v1/admin/memory-registry/brains/:id`; `PUT` and `DELETE /v1/admin/memory-registry/bindings/:id`; `PUT /v1/admin/memory-registry/member-brains` with `{ "enabled": boolean }`. The agent cannot call the two `DELETE` routes. Provider ids from `MEMORY_PROVIDER_CONFIG` cannot be changed or reused.
- **Disabled codes** (outcome `disabled`): `secret_missing`, `preset_unknown`, `id_taken` (the env variable defines that id; the env provider keeps serving), `member_brains_off`, `invalid_config` (with a `detail`).

### Forgetting a brain fact

The `memory` tool's delete and `DELETE /v1/memory/facts` take notebook `#ids` and brain refs together, at most 20 refs. QM checks every id first; a refused call changes nothing. A ref is sent to a brain only when the person sent the turn in their own DM and the turn is still running; subagents, automations, bots, admin routes and the tidy are refused. Each ref gets its own outcome. Notebook ids are deleted unless a ref's outcome is `unknown`; sending the same delete again finishes it. The call is the preset's forget tool with `{ "id": <whole number>, "request_id": "<UUID>" }`. The answer's `structuredContent.state` decides: `committed` is done; `queued`, `running` or `recovering` is pending; `conflict`, `failed` or `cancelled` is failed; any other state is unknown. The error code `fact_already_expired` counts as done.

### Skill pack and persona routes

Skill packs (org admin, audited): `POST` and `GET /v1/admin/skill-packs`; `GET …/:id/catalog`; `POST …/:id/import` with `{ "selected": "all" | [names], "scopeIds"?: [...] }` (no scope means the organization); `POST …/:id/sync`; `PATCH …/:id` (`ref`, `url`, `subset`, `trustTier`, `syncMode`, `config`); `DELETE …/:id`, which deletes the pack, its bundle and the skills imported from it. A re-import archives skills that are gone upstream. Registration takes `{ kind?: "git" | "mcp", url, ref?, config?, authCredentialSlug?, trustTier? }`; an `mcp` pack has no `ref`, needs exactly one enabled MCP server at its `url` with shared credentials, takes as its version a hash of the listed skill URIs and digests, and fails the import when a `SKILL.md` does not match its listed digest. A fetch is limited to 5,000 files and 32 MB. `config` is `{ skillGlobs?, exclude?, fieldOverrides? }`. A `pinned` pack stays at its `ref`; a `tracked` pack is re-imported by the sync when its upstream head changes.

Personas (listed for the agent only when the flag is on): `GET` and `POST /v1/personas`; `GET`, `PATCH` and `DELETE /v1/personas/:id`; `PUT /v1/personas/:id/access`; `POST /v1/personas/:id/credentials` and `DELETE /v1/personas/:id/credentials/:grantId`; `GET /v1/personas/:id/versions` and `POST /v1/personas/:id/versions/:version/restore`; `PUT /v1/sessions/:id/persona`. Role holders are personal, team, organization, channel or group scopes; a channel or group holds read only, may pin one persona, and its grant applies only to conversations in it.
