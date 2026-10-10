# QM spec

> Human-written. Agents must not edit this file, except to add entries to the Wall of shame.

## North stars

1. **Unhobble.** Frontier models are smarter than we usually allow them to be. What scaffolds and supports the model today will restrain it tomorrow; keep the harness as thin as possible.
2. **Free the brain.** State lives in Postgres and the agent can query it. Unhobbling also implies freeing the agent from dependency on any specific provider: sandboxes, models, and harnesses are just swappable resources for the agent.
3. **Fast is the best feature.** Every bit of overhead above base inference time should be measured and driven down.
4. **Agent UX = human UX.** Tools, errors, hints and prompts are the agent's interface, so they get the same care as the web UI. Spend every context token on purpose.
5. **Delete before you add.** Via negativa. This codebase is already way too flabby. Always try the solution that simplifies or removes code before adding anything.

## Subsystems, most central first

**Agent turns.** The system revolves around durable execution against a central writeahead log: the session tape. To execute an agent turn, a session offers up a write lease, at which point a worker claims it from the run queue. The _orchestrator_ assembles context and drives a harness, which fulfills tool calls, and the result is committed to the session tape. The system should be robust to interruption at any time, end to end, and scale to swarms that are millions of agents strong.

**Swappable harnesses and models.** Agents have a single tool catalog; their turns can be fulfilled by Pi, Codex, Claude Code or OpenCode, which call into the model catalog, the canonical source for model varieties, effort levels, speed multipliers, and their prices. A particular selection of those variables fulfilling a turn is called the _runtime_.

**Scopes.** The original model was one OpenClaw per-person or per-channel. That means isolated compute, memory, files, crons, and apps. Breaking through that isolation requires an explicit and auditable _grant_.

**Sandboxes.** In OpenClaw and similar systems – the agent’s computer is home, but also a prison. In QM, no sandbox is precious. Parallel computation is encouraged, and durable state should be written in either Postgres or object storage wherever possible to enable that. Management and provisioning of compute is generally left to the model. This allows it to use its intelligence in the deployment of resources as it deems necessary.

**Credentials.** The most secure configuration is a secret that the agent never sees. Unfortunately, the world was not designed with agents in mind. Certain operations become awkward or impossible under this rule. So, in keeping with our capabilities-first north star – we allow escape hatches that trade off some level of security (for example, on-disk credentials that could in principle be lost to a prompt injected agent) to be used at the operators’ discretion.

**Context.** Primarily, this is system prompt, memory, guidance, and skills. Current model rule following is weak and prone to fail. System prompt is used for general orientation of the agent to the QM harness environment, not strict instructions or checks – these belong _locally_ – closer in context-distance to where the agent’s attention actually is. By default, memory is an append-only per-scope notebook recalled with vector search matching on every turn. Given that org memory is an unsolved problem, we allow hooks for swappable implementations of this. Guidance is intended for a per-scope's standing orders; and skills are implemented typically.

**Background work.** Crons, loops, and webhooks run with their owners permissions, but unattended work is generally considered more of a prompt injection risk. Therefore, explicit grants are required before credentials can be used for it.

**Surfaces.** There is one source of truth, which are the tokens sent to the model provider’s GPUs for inference. Everything else is a projection of that: Slack and the web UI read the same sessions and present them the way each host expects.

**Artifacts.** Apps, files, skills, crons, etc should all be shareable with a familiar Google-Docs style interface, be versioned, and tracked in Postgres or object storage.

## Wall of shame

Patterns from this repo's history, with the PRs that introduced or removed them.

### Overengineering (6 examples)

Let sLOC +/- be your guide here. Small and net-negative LOC fixes will be rewarded. This codebase at baseline is flabby -- many bugs can be fixed by _deleting_, _removing_, _simplifying_. For features: use restraint when adding new subsystems that increase surface area and widen the config matrix we will have to support.

Past mistakes and examples:

- Amendments to the master spec that are way too large for the importance of what the PR actually adds [qm#2138](https://github.com/yc-software/qm/pull/2138).
- The loops subsystem should have just re-used the crons machinery, but it built its own little empire for no reason [qm#963](https://github.com/yc-software/qm/pull/963).
- The artifact pages in the web UI could have all used the same group-by backbone, but each one got its own design for no reason [qm#963](https://github.com/yc-software/qm/pull/963).
- **Delivery retries** (2026-08-30): Undeliverable Slack notices prompted a proposal for attempt counters, scheduled exponential backoff, a parked state, and admin visibility. The proposal optimized for eventually delivering messages long after they were useful; simply expiring stale deliveries addressed the actual need. [qm#2133](https://github.com/yc-software/qm/pull/2133).
- **Harness/model selection** (2026-07-17): A selector grew into a proposed "agent profile" platform with its own catalog, preference layers, upgrade acknowledgments, readiness handling, and cohort rollout. The smaller solution extended the existing scoped setting with a `{ harness, model }` pair and reused the existing configuration and picker machinery. [qm#2134](https://github.com/yc-software/qm/pull/2134).
- **Admin tool** (2026-09-17–18): Concern about oversized responses grew into a 43-file, roughly 4,580-line patch with field limits, custom JSON validation, layered timeouts, duplicate concurrency limits, and a special handshake. Only after pushback did the agent inventory actual calls and identify large transcripts as the concrete risk. The replacement used bounded transcript pagination and a thin read-only tool: 9 files, +329/−18. _Source/status:_ original transcript and patch not yet recovered; size and rejection claims are unverified.

### Band-aid fixes (10 examples)

Hiding a symptom while leaving its true cause unfixed. Smells here are special cases (string matching and regex are especially bad), many-branched conditionals acquiring _yet another_ branch. A bug isn't a problem to fix, it is useful evidence that the system we have built is flawed.

- **Slack task completion:** A proposed acknowledgment fix reconstructed completion from descendant runs, mailbox returns, the latest conversation turn, and delivery-key prefixes. Core needed to own request completion through delegation and final delivery, then expose that state to Slack; moving the same guesses into a helper would not fix the missing ownership. [qm#2135](https://github.com/yc-software/qm/pull/2135).
- **Transcript row grouping:** A proposed UI fix joined adjacent assistant rows only when the second contained subagent activity. Multiple commentary messages, intervening tools, and resumed turns defeated the special case. Grouping events by their actual turn/run identity would give streaming and reloaded history the same response structure. [qm#2136](https://github.com/yc-software/qm/pull/2136).
- **Credential capture:** Indiscriminate credential collection swept up oversized browser profiles. The proposed fix recognized browser-profile marker files and skipped those directories, adding another exception to the sweep. The deeper fix was to let the agent identify which credential files to preserve, or explicitly request capture of changes from an authentication turn. [qm#2137](https://github.com/yc-software/qm/pull/2137).
- **[qm#1743](https://github.com/yc-software/qm/pull/1743)** (2026-09-30): Refusal fallback extended by regex-matching Anthropic usage-policy text and 'gateway model is unavailable' to trigger a hard-coded alternate-model ladder (claude-opus-5 / claude-sonnet-5), plus a new admin fallbackRuntime.
- **[qm#1748](https://github.com/yc-software/qm/pull/1748)** (2026-09-30): Every non-Modal sandbox took one exclusive sandbox-resource:<id> advisory lock around each command/file op, so sessions sharing a computer queued behind each other; replaced a backend!=='modal' special case with shared locks and a parksOnTeardown profile property. _Status:_ wound back in [qm#1748](https://github.com/yc-software/qm/pull/1748).
- **[qm#1432](https://github.com/yc-software/qm/pull/1432)** (2026-09-19): Per-turn reconciliation of a shared skills/ index under a sandbox-wide advisory lock (skill projection) stalled turns 5 minutes; replaced with an explicit skill tool and per-turn skill dirs. _Status:_ wound back in [qm#1432](https://github.com/yc-software/qm/pull/1432).
- **[qm#1133](https://github.com/yc-software/qm/pull/1133)** (2026-09-12): A factory-specific retry ladder (FACTORY_READ_RETRIES=6) was added around sandbox readProcess polling after one timeout under load. _Status:_ wound back (factory code absent on current main).
- **[qm#965](https://github.com/yc-software/qm/pull/965)** (2026-09-07): One legacy \u0000 payload bricked sessions; fixes proposed tolerating poisoned rows and sanitizing every Postgres text write. _Status:_ unknown.
- **[qm#394](https://github.com/yc-software/qm/pull/394)** (2026-08-13): Memory tool silently coerces malformed `remember` calls (content/query/bare string) into facts instead of fixing the tool schema.
- **[qm#469](https://github.com/yc-software/qm/pull/469)** (2026-08-13): Sandbox status collapses any unanswering shell into a 'wedged' verdict with baked-in 'restart the computer' advice.

### Duplication (7 examples)

Giving the same behavior or fact multiple independent implementations or sources of truth. These copies drift, disagree, and multiply maintenance work; reuse the existing owner or consolidate the competing paths.

- **[qm#1776](https://github.com/yc-software/qm/pull/1776)** (2026-09-30): Sprites cold-boot '503 Process not ready' exec re-send implemented on main after the same fix ([qm#1489](https://github.com/yc-software/qm/pull/1489)) had already landed only on the long-lived factory side branch.
- **[qm#1520](https://github.com/yc-software/qm/pull/1520)** (2026-09-22): Factory required pasted factory-anthropic/-github/-linear/-slack keychain secrets duplicating core's own model auth and connectors (two sources of truth); QM-73..76 resolve from core config/owner connectors instead. _Status:_ wound back in [qm#1520](https://github.com/yc-software/qm/pull/1520), [qm#1522](https://github.com/yc-software/qm/pull/1522), [qm#1523](https://github.com/yc-software/qm/pull/1523), [qm#1524](https://github.com/yc-software/qm/pull/1524) (on factory branch).
- **[qm#1476](https://github.com/yc-software/qm/pull/1476)** (2026-09-21): Context settings had its own model picker separate from the composer's; switched to reuse the composer model/preset picker. _Status:_ wound back in [qm#1476](https://github.com/yc-software/qm/pull/1476) (both plugins/web-ui/src/model-picker.ts and context-model.ts still exist).
- **[qm#1272](https://github.com/yc-software/qm/pull/1272)** (2026-09-16): Session transcripts are kept in both session_entries and session_tape, with SESSION_TAPE_MODE shadow/serve choosing between them.
- **[qm#1185](https://github.com/yc-software/qm/pull/1185)** (2026-09-15): Each subscriber held its own LISTEN connection and pg-boss kept its own pool; consolidated to one listener per process and the shared query pool. _Status:_ wound back in [qm#1185](https://github.com/yc-software/qm/pull/1185).
- **[qm#993](https://github.com/yc-software/qm/pull/993)** (2026-09-08): Chat search queried both the dedicated search index and legacy entry history for every visible conversation, causing timeouts. _Status:_ wound back in [qm#993](https://github.com/yc-software/qm/pull/993).
- **[qm#488](https://github.com/yc-software/qm/pull/488)** (2026-08-13): Web-UI /api router had ~50 hand-copied body-parse/relay/path-decode fragments that drifted (some returned 400 instead of 413). _Status:_ wound back in [qm#488](https://github.com/yc-software/qm/pull/488).

### Hand-rolling (5 examples)

Reimplementing a capability that an existing SDK, library, or supported API already provides. Custom protocols and plumbing make us own edge cases that the maintained integration already handles; use that integration when it meets the requirements.

- **[qm#1005](https://github.com/yc-software/qm/pull/1005): Run-queue retries.** Added a `retry_after` column, a matching in-memory deadline map, a custom exponential-backoff-with-jitter function, delayed-claim predicates, and an inline polling loop to keep delayed retries moving. pg-boss already provides durable deferred jobs, retry limits, and backoff; we implemented those mechanics again beside the pg-boss cron queue. _Status:_ custom retry scheduling remains in `src/runs/`.
- **[qm#1255](https://github.com/yc-software/qm/pull/1255): Run-queue worker wakeups.** Sixteen idle workers issued about 64 claim UPDATEs per second. The fix built a `qm_run_available` notification channel, worker generation counters, reconnect rescans, recovery timers, and a shared availability probe. This is another layer of queue infrastructure to maintain when pg-boss provides worker polling and notification-based wakeups. _Status:_ the custom notification and worker machinery remains.
- **[qm#963](https://github.com/yc-software/qm/pull/963): Delivery-queue claims and recovery.** The imported implementation has its own `claim_expires_at`, `FOR UPDATE SKIP LOCKED` claims, expired-row sweep, and Slack poller with per-row expiry tracking and a three-attempt `reclaimOwnership` loop. pg-boss can own job claiming, expiry, and retries instead of making the delivery subsystem implement another queue. Delivery records, Slack idempotency, and session ordering still belong to the application; they are not reasons to rebuild the queue mechanics. _Status:_ the custom delivery queue remains.
- **[qm#1419](https://github.com/yc-software/qm/pull/1419)** (2026-09-22): Sprites backend used raw REST fetches; moved to Sprites SDK 0.2.3 (WebSocket exec, filesystem APIs, checkpoints); sibling PRs #1420-#1422 aligned Modal/E2B/Smolmachines with provider docs. _Status:_ wound back in [qm#1419](https://github.com/yc-software/qm/pull/1419).
- **[qm#1407](https://github.com/yc-software/qm/pull/1407)** (2026-09-22): Internal Fly transports piped data through `fly ssh console` (broke on Windows PTY); replaced with Machines exec API stdin. _Status:_ wound back in [qm#1407](https://github.com/yc-software/qm/pull/1407).

### Non-durability (5 examples)

This is a distributed system that needs work to endure through deploys and crashes without hiccups. A common agent mistake has been to store data in process memory. Postgres is effectively the core's filesystem -- think of core memory as a cache at best.

- **Operational error history:** `createErrorLog()` kept the admin Errors history in a 5,000-event process-local ring buffer, even with a production database configured. A deploy erased the history; a request routed to another instance could not see it. The fix added Postgres `error_events` and wired production reads and writes to it. _Status:_ fixed; original code and fix preserved in [qm#2140](https://github.com/yc-software/qm/pull/2140).
- **Scoped configuration:** Soul overrides, command policies, egress rules, and publishing flags lived in process-local `Map`s. Restarting core discarded the overrides and restored defaults. The fix added Postgres backing and hydrated the read cache before serving. _Status:_ fixed; original code and fix preserved in [qm#2140](https://github.com/yc-software/qm/pull/2140).
- **Pending Slack approvals:** Run/Deny cards depended on `pendingSlackAgentRequests`, a `Map` in the Slack process. Deploys erased outstanding requests; clicks routed to another instance could report that the request had expired and leave the originating status stuck. The fix persisted the requests and approval linkage in Postgres with atomic claims. _Status:_ fixed; the Map removal and durable replacement are in [qm#963](https://github.com/yc-software/qm/pull/963).
- **Completed runs with missing replies:** A run was durably marked complete, but enqueueing its delivery depended on an in-process `onTerminal` callback. A crash between completion and enqueue left finished work with no delivery. The fix scans persisted terminal runs and reconstructs missing deliveries. _Status:_ fixed in [qm#2053](https://github.com/yc-software/qm/pull/2053).
- **Webhook work already in flight:** `runOnce` guarded running webhook work with a process-local `inflight` Set, while the receiver's durable idempotency check recognized only committed fires. A retry routed to another instance during a long turn could start the same work again. _Status:_ still present on main; [qm#1943](https://github.com/yc-software/qm/pull/1943) proposes shared Postgres claims and includes a two-instance regression test.

### Config-matrix expansion (11 examples)

Helpful KPIs here are: how many env vars do we have? how large is the database schema? Implicit modes in the form of conditionals, text matching or hard-coded flags also count. The combined footprint of this config matrix is currently enormous and makes our task much more difficult. Driving this down is critical and PRs that reduce the size of these will be rewarded.

- **Adding a provider that subtly deviates from the general sandbox contract (this has been done several times).** For example, ordinary teardown parks E2B, AWS, and local Docker computers, while Modal needs different handling. [qm#1748](https://github.com/yc-software/qm/pull/1748) removes a `backend !== "modal"` locking exception and introduces a `parksOnTeardown` profile property; the distinct lifecycle behaviors remain part of the matrix.
- **[qm#1784](https://github.com/yc-software/qm/pull/1784)** (2026-09-30): Security screening had three overlapping env knobs (SECURITY_SCREEN_BACKEND, SECURITY_SCREEN_ALL_POSTURES, SECURITY_SCREEN_PROXY_ROLLOUT) plus per-posture inboundScreening; collapsed into one SECURITY_SCREEN=off|observe|enforce. _Status:_ wound back in [qm#1784](https://github.com/yc-software/qm/pull/1784).
- **[qm#1747](https://github.com/yc-software/qm/pull/1747)** (2026-09-30): New SANDBOX_CAPABILITY_TTL_HOURS env var (48h default, or 0/none for non-expiring bearer tokens) right after #1518 hard-set 48h.
- **[qm#1619](https://github.com/yc-software/qm/pull/1619)** (2026-09-25): Separate org runtime defaults for conversations, crons/loops and sub-agents, then per-cron overrides (#1593) and a fallback runtime (#1743): four overlapping runtime settings with precedence rules.
- **[qm#1201](https://github.com/yc-software/qm/pull/1201)** (2026-09-15): Security screening gained an off/model/proxy backend plus ALL_POSTURES, four PROXY_* vars and a timeout, layered on HARNESS_SECURITY_POSTURE and the org-level Auto flagger settings from [qm#878](https://github.com/yc-software/qm/pull/878).
- **[qm#1208](https://github.com/yc-software/qm/pull/1208)** (2026-09-15): EAGER_PROVISION was an opt-in flag no deploy template set, so every deployment missed a 66s-to-3s median speedup until it defaulted on. _Status:_ partly wound back; flag remains (src/config.ts).
- **[qm#1162](https://github.com/yc-software/qm/pull/1162)** (2026-09-14): Gateway deployments had to maintain an environment model allowlist; replaced by discovering models from the gateway's key-scoped list. _Status:_ wound back in [qm#1162](https://github.com/yc-software/qm/pull/1162).
- **[qm#1044](https://github.com/yc-software/qm/pull/1044)** (2026-09-10): The unified `sandbox` tool shipped behind SANDBOX_RESOURCES_ENABLED alongside the legacy execute/background tools, so two tool surfaces and both flag states must be supported.
- **[qm#922](https://github.com/yc-software/qm/pull/922)** (2026-09-04): Another sandbox backend (agent37) was added, bringing providers to about ten (agent37, aws, e2b, modal, porter, smolmachines, sprites, superserve, local/docker); [qm#954](https://github.com/yc-software/qm/pull/954) proposed Kubernetes as well.
- **[qm#876](https://github.com/yc-software/qm/pull/876)** (2026-09-02): Porter added as yet another SANDBOX_BACKEND and DEPLOY_PROVIDER (plus a Helm chart), shortly after Modal and E2B.
- **[qm#478](https://github.com/yc-software/qm/pull/478)** (2026-08-13): Added smolmachines as yet another sandbox backend, then SMOLMACHINES_CPUS/MEMORY_MB/DISK_GB env knobs ([qm#507](https://github.com/yc-software/qm/pull/507)).

### Provider drift (1 example)

Every sandbox provider should give the agent the same machine. When one provider's image or behavior quietly differs, the agent hits failures that only reproduce there.

- **AWS CLI v1 on E2B and Modal** (2026-10-09): The E2B and Modal sandbox images came with no AWS CLI at all. When the agent needed `aws`, it ran `pip install awscli`, and pip only has version 1. Version 1 can't do device-code sign-in. The Fly, Porter and Superserve images already included version 2, so only these two were missing it.

### God files (4 examples)

Letting one file or module absorb unrelated responsibilities until changes require understanding the whole system. Keep responsibilities with clear owners and boundaries; splitting a file by line count alone does not untangle those responsibilities.

- **[qm#1296](https://github.com/yc-software/qm/pull/1296)** (2026-09-16): The AWS deploy backend keeps absorbing capacity proofs, ownership handover and candidate logic.
- **[qm#1636](https://github.com/yc-software/qm/pull/1636): Core orchestrator.** `src/core/orchestrator.ts` absorbed memory-audience changes, transcript cutoffs, provenance dependency capture, harness resets, and approval invalidation inside the same turn-execution closure. The diff shows memory-disclosure policy reaching into retry replay and pending approvals; those responsibilities remain embedded in the orchestrator despite separate memory helpers.
- **[qm#175](https://github.com/yc-software/qm/pull/175): Chat surface.** `plugins/web-ui/src/chat.ts` combines transcript rendering and pagination, pane lifecycle and URL state, command-approval submission, active-run recovery, session forking, and connector-auth widgets inside `createChatSurface`. The multiview change rewrites that shared closure, so changing how a pane mounts also means navigating approval and execution-recovery state. _Status:_ these responsibilities still share `chat.ts`.
- **[qm#488](https://github.com/yc-software/qm/pull/488): Web server entrypoint.** `plugins/web-ui/server/index.ts` combines session cookies and sign-in, OAuth callback forwarding, core API transport, request-body handling, and route handlers for sessions, files, projects, and crons. The PR extracts a shared router and relay helpers, but keeps the product domains and authentication flows in the same server module. _Status:_ partial cleanup; the shared entrypoint still owns those domains.

### Mismatched UI (4 examples)

Building interface pieces that disagree with the surrounding product in appearance, structure, or interaction. Reuse the existing components and design rules, and check the result in its containing surface so duplicated chrome and inconsistent typography do not slip through.

- **Admin UI versus web UI:** The same product has separate admin and web interfaces with different layouts, styling, and controls. Moving between them should not feel like switching products. [qm#1441](https://github.com/yc-software/qm/pull/1441) migrated admin views to Lit while explicitly retaining the existing admin CSS and layout; sharing a rendering library did not unify the UI.
- **Artifact pages under Browse:** Skills, crons, webhooks, apps, and files each developed their own search, filters, and toggles when they could use more or less the same controls. Skills has its own scope/source/status filters; crons has ownership tabs and a disabled toggle; apps has another tab implementation; files renders its own search and ownership/type filters. The implementations are visible together in [qm#963](https://github.com/yc-software/qm/pull/963). Artifact-specific options can vary, but the common search, filtering, and toggle interactions should be shared across Browse.
- **[qm#1545](https://github.com/yc-software/qm/pull/1545)** (2026-09-22): Transcript elements each hardcoded their own font-size, so multiview panes showed 15px/14px headers beside 12px text; unified on one --chat-font-size base. _Status:_ wound back in [qm#1545](https://github.com/yc-software/qm/pull/1545).
- **[qm#513](https://github.com/yc-software/qm/pull/513)** (2026-08-13): Multiview panes showed two stacked headers (pane chrome plus the hosted chat's own top bar). _Status:_ wound back in [qm#513](https://github.com/yc-software/qm/pull/513).

### Over-indexing on YC (3 examples)

QM is for organizations in general. YC's usage guides development but architecture should not be _warped_ to fit our purposes and customizations. Leaking YC _data_ is a separate concern.

- **Dedicated people-directory configuration:** Role lookup from a people website became its own People directory admin card, org-wide URL setting, and save path in the generic product. This could have been ordinary organization knowledge or a deployment tool. _Status:_ [qm#1441](https://github.com/yc-software/qm/pull/1441) removes the dedicated admin card.
- **[qm#1008](https://github.com/yc-software/qm/pull/1008)** (2026-09-09): A 29-file 'software factory' loop (Linear auto-triage, forge ship contract) built for YC's own workflow was ported into public src/loops/factory before it had ever run end to end. _Status:_ wound back in [qm#1026](https://github.com/yc-software/qm/pull/1026).
- **[qm#530](https://github.com/yc-software/qm/pull/530)** (2026-08-15): Assistant and org names were fixed across prompts, manifests, auth and UI; made deployment-configurable with neutral defaults. _Status:_ wound back in [qm#530](https://github.com/yc-software/qm/pull/530).

### Regex (3 examples)

Some people, when confronted with a _**problem**_, think “I know, I'll use _**regular expressions**_.” Now they have _**two problems**_.

Main has 1,443 production regex sites in 380 files; cleanup is the regex-removal backlog.

- **[qm#1354](https://github.com/yc-software/qm/pull/1354)** (2026-09-17): The web UI re-parses shell commands with a hand-written tokenizing regex (and sniffs `sed -n Np` and Markdown headings by pattern) to decide how to present tool activity, instead of using the structured call data.
- **[qm#1210](https://github.com/yc-software/qm/pull/1210)** (2026-09-15): Composio consent links are found by regex-scanning model text for URLs and Markdown links, then stripped with dynamically built `RegExp`s, rather than arriving as a typed connector-link field.
- **[qm#169](https://github.com/yc-software/qm/pull/169)** (2026-08-03): The agent self-API allowlist is a chain of path regexes (`/^\/v1\/projects\/[^/]+$/`, …) instead of matching on the router's declared routes.

### YC info leaking into public qm (2 examples)

Publishing organization-specific information in the public repository through code, docs, fixtures, screenshots, or change descriptions. Inspect outgoing content for private identities, operational details, and internal references; keep private deployment material in private storage.

- **[qm#1315](https://github.com/yc-software/qm/pull/1315)** (2026-09-16): The generic web UI onboarding says 'the agent harness we use to run YC' and 'your YC partner in a box', and the welcome ideas cite 'YC Deal' and 'the YC investor database'.
- **[qm#1504](https://github.com/yc-software/qm/pull/1504)** (2026-09-22): Public docs/test fixtures had org-specific rollout guidance and identity examples plus 92 tracked screenshots (8.1 MB); scrubbed and AGENTS.md now bans committed screenshots. _Status:_ wound back in [qm#1504](https://github.com/yc-software/qm/pull/1504) (partially; YC welcome copy remains).

### Discarded error evidence (3 examples)

Replacing or swallowing a failure so the evidence needed to diagnose it disappears.

- **Sandbox startup and cleanup** (2026-10-02): A provider authentication failure reached the tool transcript as a bare "Command execution failed." The cleanup wrappers in `src/sandbox/sandbox.ts` dropped the original causes, destruction retries in `src/core/orchestrator/sandboxes.ts` swallowed every exception, and `src/harness/agent-tools.ts` recorded only the generic status. _Status:_ wound back in [qm#2018](https://github.com/yc-software/qm/pull/2018).
- **Rejected session titles:** `sanitizeTitle` returned `undefined` for rejected model output. The fallback title made the request look successful, while neither the rejected text nor the rule that rejected it reached the error log. _Status:_ [qm#1303](https://github.com/yc-software/qm/pull/1303) records the rejection rule and a bounded sample in the durable error log.
- **Failed transaction rollback:** `withPgTransaction` and copied transaction handlers awaited `ROLLBACK` before rethrowing the original error. If rollback also failed, its exception replaced the actual transaction failure. _Status:_ still present on main; [qm#1834](https://github.com/yc-software/qm/pull/1834) proposes preserving the original error and discarding the broken connection.

### Legacy preservation (4 examples)

Keeping old endpoints, data shapes, and code paths alive next to their replacement. Our priority is future users, not seamless continuity for past ones. Do the bare minimum for history: a DB migration or a one-off migration script, then make the breaking change and let people adapt; agents can usually smooth over the breakage for existing users. Only preserve the old way when removing it would leave the system in an unrecoverable state. In general the codebase should be historyless: it represents the system at its current best, without sedimentary layers of how it got there.

- **Credential capture redesign** (2026-10-08): The login-as-a-skill handoff planned that "a stale skill calling /v1/keychain/use gets a clear refusal" and that "logins saved under the old capture system still load." Both keep the old system on life support. Remove the endpoint and the old capture system outright; stale skills fail and get fixed. _Status:_ [qm#2146](https://github.com/yc-software/qm/pull/2146) deletes `/v1/keychain/use` (open).
- **Sandbox routing retirement** (2026-10-02): Retiring `sandbox_routing` came with a locked, marker-guarded one-time upgrade import that preserved legacy IDs, explicit nulls, and machine IDs, kept the old table as rollback input, and told operators to keep credentials for legacy-mapped providers. A plain migration would have done. _Status:_ merged in [qm#2019](https://github.com/yc-software/qm/pull/2019).
- **Session tape beside session entries** (2026-09-16): The tape was meant to replace `session_entries`, but caution kept both. `SESSION_TAPE_MODE` shadow/serve chose between them, exact-transcript annotations were added so the tape could reproduce every historical field, and a verifying, lease-aware operator backfill with dry runs and partial-scan statuses guarded the cutover. We got stuck here for weeks; one migration and a hard cutover would have left one system instead of two. _Status:_ both stores and the mode flag remain on main ([qm#1272](https://github.com/yc-software/qm/pull/1272)).
- **Legacy Inbox loop:** `src/loops/inbox-migration.ts` migrates each owner's legacy Inbox loop at runtime, with its own phase record in UI-state preferences, a pause-and-disable sequence, and a repair path for half-finished runs. _Status:_ still on main; deletion approved for the loops rebuild.

### Over-testing

Description and examples pending human input.

### Performance (3 examples)

Doing unnecessary work, repeating expensive work, or making independent work wait. Watch for hot polling loops, unbounded database reads, and locks that serialize unrelated operations. Token costs belong under Token performance.

- **Polling that writes even when nothing is due:** The cron scheduler sent a synthetic tick job every second and repeatedly submitted cron jobs. Idle scheduling still generated database writes and queue churn. _Status:_ [qm#2007](https://github.com/yc-software/qm/pull/2007) removes the per-second tick job; mutation and completion hooks keep jobs current, with periodic repair on the scheduler lease holder.
- **Unbounded admin list queries:** The session list combined per-row JSON subqueries with full-history sorting and OFFSET pagination. A routine admin page could saturate Postgres and starve the shared connection pool used by actual turns. _Status:_ [qm#2076](https://github.com/yc-software/qm/pull/2076) makes the list query bounded and removes repeated work from each row.
- **Serializing independent sandbox operations:** A single exclusive machine lock covered commands, file operations, and status checks. One long-running command blocked unrelated sessions using the same computer. _Status:_ [qm#1748](https://github.com/yc-software/qm/pull/1748) lets ordinary operations share the lock while keeping destructive lifecycle operations exclusive.

### Token performance (4 examples)

Tokens are the hot path. Anything sent to the model on every turn is paid for on every turn, in money, latency, and attention. Keep prompt prefixes stable so the KV cache holds, and make every token in the system prompt and per-turn context earn its place: no duplicates, no inventories the request doesn't need, no boilerplate repeated per item. Default to small and let the agent fetch the rest on demand.

- **Defeating prompt caching with incidental changes:** Changing countdowns, fresh sandbox/job snapshots, and inventories rendered in discovery order kept changing otherwise reusable prompt prefixes. _Status:_ [qm#1618](https://github.com/yc-software/qm/pull/1618) stabilizes snapshots and timestamps; [qm#1690](https://github.com/yc-software/qm/pull/1690) fixes the remaining inventory-order churn.
- **Per-turn `<environment>` note:** Memory, scheduled-work snapshots, and time blocks ride along with every turn whether or not the request needs them. The whole memory notebook is sent at session start and after compaction, then as deltas; on a long-lived DM that is hundreds of bullets. The spec describes vector recall, but the whole notebook is sent. _Status:_ still present on main.
- **Redundant system prompt:** The same instructions appear more than once: scope guidance that copies the org block and adds to it is re-sent in full (only exact matches are skipped), and every credential is listed twice (as execute handles and again as keychains), on top of a full skills index and a shared-file listing. Caching softens the price, not the attention cost. _Status:_ still present on main.
- **Per-fact provenance in memory:** Each remembered fact carries its own date and scope tag, and the same fact recalled from two scopes is printed twice, so the boilerplate grows linearly with the notebook. Dedupe across scopes when rendering, save each fact once, and state provenance once per group. _Status:_ still present on main.

### Honorable mentions

These can be addressed by a single combined reviewer.

- **Screenshots:** The repo is not to be cluttered with screenshots or images of any kind that aren't actually used in UI.
- **Code comments:** Not allowed -- these historically have reinforced drift and reward-hacky agent decisions, providing air cover for future agents to do the same.
