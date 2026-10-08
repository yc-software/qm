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

- Amendments to the master spec that are way too large for the importance of what the PR actually adds [Handoff amendment](https://github.com/yc-software/qm/blob/f6329d098075fefb8b15113bb58b8a955b5c7cc7/docs/review-evidence/master-spec-handoff-amendment.md).
- The loops subsystem should have just re-used the crons machinery, but it built its own little empire for no reason [Loop store](https://github.com/yc-software/qm/blob/091d130b7c8fabba365fba30e6b019cd5696b5a1/src/loops/loop-store.ts), [loop runner](https://github.com/yc-software/qm/blob/091d130b7c8fabba365fba30e6b019cd5696b5a1/src/loops/runner.ts), [cron scheduler](https://github.com/yc-software/qm/blob/091d130b7c8fabba365fba30e6b019cd5696b5a1/src/cron/scheduler.ts).
- The artifact pages in the web UI could have all used the same group-by backbone, but each one got its own design for no reason [Files grouping](https://github.com/yc-software/qm/blob/091d130b7c8fabba365fba30e6b019cd5696b5a1/plugins/web-ui/src/files.ts#L95-L105), [skills grouping](https://github.com/yc-software/qm/blob/091d130b7c8fabba365fba30e6b019cd5696b5a1/plugins/web-ui/src/skill-registry.ts#L47-L80), [cron page](https://github.com/yc-software/qm/blob/091d130b7c8fabba365fba30e6b019cd5696b5a1/plugins/web-ui/src/crons.ts#L194-L260).
- **Delivery retries** (2026-08-30): Undeliverable Slack notices prompted a proposal for attempt counters, scheduled exponential backoff, a parked state, and admin visibility. The proposal optimized for eventually delivering messages long after they were useful; simply expiring stale deliveries addressed the actual need. [Original proposal](https://github.com/yc-software/qm/blob/dc9f3ea33248f89a60a0199ab23f410e506fd509/docs/evidence/delivery-retry-proposal.md).
- **Harness/model selection** (2026-07-17): A selector grew into a proposed "agent profile" platform with its own catalog, preference layers, upgrade acknowledgments, readiness handling, and cohort rollout. The smaller solution extended the existing scoped setting with a `{ harness, model }` pair and reused the existing configuration and picker machinery. [Original proposal](https://github.com/yc-software/qm/blob/7bcc771ec743896180a782e969980f0ff7c7323f/docs/evidence/harness-profile-proposal.md).
- **Admin tool** (2026-09-17–18): Concern about oversized responses grew into a 43-file, roughly 4,580-line patch with field limits, custom JSON validation, layered timeouts, duplicate concurrency limits, and a special handshake. Only after pushback did the agent inventory actual calls and identify large transcripts as the concrete risk. The replacement used bounded transcript pagination and a thin read-only tool: 9 files, +329/−18. _Source/status:_ original transcript and patch not yet recovered; size and rejection claims are unverified.

### Band-aid fixes (10 examples)

Hiding a symptom while leaving its true cause unfixed. Smells here are special cases (string matching and regex are especially bad), many-branched conditionals acquiring _yet another_ branch. A bug isn't a problem to fix, it is useful evidence that the system we have built is flawed.

- **Slack task completion:** A proposed acknowledgment fix reconstructed completion from descendant runs, mailbox returns, the latest conversation turn, and delivery-key prefixes. Core needed to own request completion through delegation and final delivery, then expose that state to Slack; moving the same guesses into a helper would not fix the missing ownership. [Recovered code](https://github.com/yc-software/qm/blob/3a3daa38157d20f76fca1e752cf822869379e6eb/docs/review-evidence/slack-task-completion.patch), [design review](https://github.com/yc-software/qm/blob/3a3daa38157d20f76fca1e752cf822869379e6eb/docs/review-evidence/slack-task-completion.md).
- **Transcript row grouping:** A proposed UI fix joined adjacent assistant rows only when the second contained subagent activity. Multiple commentary messages, intervening tools, and resumed turns defeated the special case. Grouping events by their actual turn/run identity would give streaming and reloaded history the same response structure. [Original code](https://github.com/yc-software/qm/blob/ff4d592fb82f73d4e12ada76d838cbbde417e37a/docs/review-evidence/transcript-row-grouping.patch).
- **Credential capture:** Indiscriminate credential collection swept up oversized browser profiles. The proposed fix recognized browser-profile marker files and skipped those directories, adding another exception to the sweep. The deeper fix was to let the agent identify which credential files to preserve, or explicitly request capture of changes from an authentication turn. [Original proposal and objection](https://github.com/yc-software/qm/blob/251c7180b0bf234f9d69022469a5875f3c88327b/docs/review-evidence/credential-capture-proposal.md).
- **[qm#1743](https://github.com/yc-software/qm/pull/1743/files)** (2026-09-30): Refusal fallback extended by regex-matching Anthropic usage-policy text and 'gateway model is unavailable' to trigger a hard-coded alternate-model ladder (claude-opus-5 / claude-sonnet-5), plus a new admin fallbackRuntime.
- **[qm#1748](https://github.com/yc-software/qm/pull/1748/files)** (2026-09-30): Every non-Modal sandbox took one exclusive sandbox-resource:<id> advisory lock around each command/file op, so sessions sharing a computer queued behind each other; replaced a backend!=='modal' special case with shared locks and a parksOnTeardown profile property. _Status:_ wound back in [qm#1748](https://github.com/yc-software/qm/pull/1748/files).
- **[qm#1432](https://github.com/yc-software/qm/pull/1432/files)** (2026-09-19): Per-turn reconciliation of a shared skills/ index under a sandbox-wide advisory lock (skill projection) stalled turns 5 minutes; replaced with an explicit skill tool and per-turn skill dirs. _Status:_ wound back in [qm#1432](https://github.com/yc-software/qm/pull/1432/files).
- **[qm#1133](https://github.com/yc-software/qm/pull/1133/files)** (2026-09-12): A factory-specific retry ladder (FACTORY_READ_RETRIES=6) was added around sandbox readProcess polling after one timeout under load. _Status:_ wound back (factory code absent on current main).
- **[qm#965](https://github.com/yc-software/qm/pull/965/files)** (2026-09-07): One legacy \u0000 payload bricked sessions; fixes proposed tolerating poisoned rows and sanitizing every Postgres text write. _Status:_ unknown.
- **[qm#394](https://github.com/yc-software/qm/pull/394/files)** (2026-08-13): Memory tool silently coerces malformed `remember` calls (content/query/bare string) into facts instead of fixing the tool schema.
- **[qm#469](https://github.com/yc-software/qm/pull/469/files)** (2026-08-13): Sandbox status collapses any unanswering shell into a 'wedged' verdict with baked-in 'restart the computer' advice.

### Duplication (8 examples)

Giving the same behavior or fact multiple independent implementations or sources of truth. These copies drift, disagree, and multiply maintenance work; reuse the existing owner or consolidate the competing paths.

- **[qm#1776](https://github.com/yc-software/qm/pull/1776/files)** (2026-09-30): Sprites cold-boot '503 Process not ready' exec re-send implemented on main after the same fix ([qm#1489](https://github.com/yc-software/qm/pull/1489/files)) had already landed only on the long-lived factory side branch.
- **[qm#1520](https://github.com/yc-software/qm/pull/1520/files)** (2026-09-22): Factory required pasted factory-anthropic/-github/-linear/-slack keychain secrets duplicating core's own model auth and connectors (two sources of truth); QM-73..76 resolve from core config/owner connectors instead. _Status:_ wound back in [qm#1520](https://github.com/yc-software/qm/pull/1520/files), [qm#1522](https://github.com/yc-software/qm/pull/1522/files), [qm#1523](https://github.com/yc-software/qm/pull/1523/files), [qm#1524](https://github.com/yc-software/qm/pull/1524/files) (on factory branch).
- **[qm#1476](https://github.com/yc-software/qm/pull/1476/files)** (2026-09-21): Context settings had its own model picker separate from the composer's; switched to reuse the composer model/preset picker. _Status:_ wound back in [qm#1476](https://github.com/yc-software/qm/pull/1476/files) (both plugins/web-ui/src/model-picker.ts and context-model.ts still exist).
- **[qm#1427](https://github.com/yc-software/qm/pull/1427/files)** (2026-09-19): The 'software factory' loop (wrapper, workflows, own Linear/GitHub/Slack/Anthropic credentials, own sizing knobs) was developed as a parallel system on side branch qm-29-port-factory-loop (~QM-29..QM-84 PRs) rather than on native Loops on main. _Status:_ unknown (factory/ absent from main; branch still receives merges).
- **[qm#1272](https://github.com/yc-software/qm/pull/1272/files)** (2026-09-16): Session transcripts are kept in both session_entries and session_tape, with SESSION_TAPE_MODE shadow/serve choosing between them.
- **[qm#1185](https://github.com/yc-software/qm/pull/1185/files)** (2026-09-15): Each subscriber held its own LISTEN connection and pg-boss kept its own pool; consolidated to one listener per process and the shared query pool. _Status:_ wound back in [qm#1185](https://github.com/yc-software/qm/pull/1185/files).
- **[qm#993](https://github.com/yc-software/qm/pull/993/files)** (2026-09-08): Chat search queried both the dedicated search index and legacy entry history for every visible conversation, causing timeouts. _Status:_ wound back in [qm#993](https://github.com/yc-software/qm/pull/993/files).
- **[qm#488](https://github.com/yc-software/qm/pull/488/files)** (2026-08-13): Web-UI /api router had ~50 hand-copied body-parse/relay/path-decode fragments that drifted (some returned 400 instead of 413). _Status:_ wound back in [qm#488](https://github.com/yc-software/qm/pull/488/files).

### Hand-rolling (2 examples)

Reimplementing a capability that an existing SDK, library, or supported API already provides. Custom protocols and plumbing make us own edge cases that the maintained integration already handles; use that integration when it meets the requirements.

- **[qm#1419](https://github.com/yc-software/qm/pull/1419/files)** (2026-09-22): Sprites backend used raw REST fetches; moved to Sprites SDK 0.2.3 (WebSocket exec, filesystem APIs, checkpoints); sibling PRs #1420-#1422 aligned Modal/E2B/Smolmachines with provider docs. _Status:_ wound back in [qm#1419](https://github.com/yc-software/qm/pull/1419/files).
- **[qm#1407](https://github.com/yc-software/qm/pull/1407/files)** (2026-09-22): Internal Fly transports piped data through `fly ssh console` (broke on Windows PTY); replaced with Machines exec API stdin. _Status:_ wound back in [qm#1407](https://github.com/yc-software/qm/pull/1407/files).

### Non-durability (4 examples)

Keeping state somewhere that cannot reliably preserve and retrieve it for as long as it is needed. Look for required data tied to a process, sandbox, browser, or unsuitable storage layout; use durable shared storage with a lifecycle and access pattern that fit the data.

- **[qm#1789](https://github.com/yc-software/qm/pull/1789/files)** (2026-09-30): Docker-published apps have no persistent /data mount, so app data is lost on redeploy.
- **[qm#1694](https://github.com/yc-software/qm/pull/1694/files)** (2026-09-28): Recurring jobs were told to keep checkpoints on sandbox workspace disk, lost when the computer is replaced; now published to durable scoped Files. _Status:_ wound back in [qm#1694](https://github.com/yc-software/qm/pull/1694/files).
- **[qm#452](https://github.com/yc-software/qm/pull/452/files)** (2026-08-13): Multiview layout lived only in localStorage and was lost on a new device or profile. _Status:_ wound back in [qm#452](https://github.com/yc-software/qm/pull/452/files).
- **[qm#64](https://github.com/yc-software/qm/pull/64/files)** (2026-08-04): Cron fire log was stored inside the cron's jsonb row, grew without bound, and every fire rewrote the whole log. _Status:_ wound back (src/cron/fire-store.ts; cron-store.ts migrates legacy fireLog out, cron_fires table).

### Config-matrix expansion (10 examples)

Adding flags, providers, modes, or overlapping settings that multiply the combinations the system must support. Each new choice needs a concrete requirement; prefer one clear behavior, automatic discovery, or a single authoritative setting over more knobs and precedence rules.

- **[qm#1784](https://github.com/yc-software/qm/pull/1784/files)** (2026-09-30): Security screening had three overlapping env knobs (SECURITY_SCREEN_BACKEND, SECURITY_SCREEN_ALL_POSTURES, SECURITY_SCREEN_PROXY_ROLLOUT) plus per-posture inboundScreening; collapsed into one SECURITY_SCREEN=off|observe|enforce. _Status:_ wound back in [qm#1784](https://github.com/yc-software/qm/pull/1784/files).
- **[qm#1747](https://github.com/yc-software/qm/pull/1747/files)** (2026-09-30): New SANDBOX_CAPABILITY_TTL_HOURS env var (48h default, or 0/none for non-expiring bearer tokens) right after #1518 hard-set 48h.
- **[qm#1619](https://github.com/yc-software/qm/pull/1619/files)** (2026-09-25): Separate org runtime defaults for conversations, crons/loops and sub-agents, then per-cron overrides (#1593) and a fallback runtime (#1743): four overlapping runtime settings with precedence rules.
- **[qm#1201](https://github.com/yc-software/qm/pull/1201/files)** (2026-09-15): Security screening gained an off/model/proxy backend plus ALL_POSTURES, four PROXY_* vars and a timeout, layered on HARNESS_SECURITY_POSTURE and the org-level Auto flagger settings from [qm#878](https://github.com/yc-software/qm/pull/878/files).
- **[qm#1208](https://github.com/yc-software/qm/pull/1208/files)** (2026-09-15): EAGER_PROVISION was an opt-in flag no deploy template set, so every deployment missed a 66s-to-3s median speedup until it defaulted on. _Status:_ partly wound back; flag remains (src/config.ts).
- **[qm#1162](https://github.com/yc-software/qm/pull/1162/files)** (2026-09-14): Gateway deployments had to maintain an environment model allowlist; replaced by discovering models from the gateway's key-scoped list. _Status:_ wound back in [qm#1162](https://github.com/yc-software/qm/pull/1162/files).
- **[qm#1044](https://github.com/yc-software/qm/pull/1044/files)** (2026-09-10): The unified `sandbox` tool shipped behind SANDBOX_RESOURCES_ENABLED alongside the legacy execute/background tools, so two tool surfaces and both flag states must be supported.
- **[qm#922](https://github.com/yc-software/qm/pull/922/files)** (2026-09-04): Another sandbox backend (agent37) was added, bringing providers to about ten (agent37, aws, e2b, modal, porter, smolmachines, sprites, superserve, local/docker); [qm#954](https://github.com/yc-software/qm/pull/954/files) proposed Kubernetes as well.
- **[qm#876](https://github.com/yc-software/qm/pull/876/files)** (2026-09-02): Porter added as yet another SANDBOX_BACKEND and DEPLOY_PROVIDER (plus a Helm chart), shortly after Modal and E2B.
- **[qm#478](https://github.com/yc-software/qm/pull/478/files)** (2026-08-13): Added smolmachines as yet another sandbox backend, then SMOLMACHINES_CPUS/MEMORY_MB/DISK_GB env knobs ([qm#507](https://github.com/yc-software/qm/pull/507/files)).

### God files (1 example)

Letting one file or module absorb unrelated responsibilities until changes require understanding the whole system. Keep responsibilities with clear owners and boundaries; splitting a file by line count alone does not untangle those responsibilities.

- **[qm#1296](https://github.com/yc-software/qm/pull/1296/files)** (2026-09-16): The AWS deploy backend keeps absorbing capacity proofs, ownership handover and candidate logic.

### Mismatched UI (3 examples)

Building interface pieces that disagree with the surrounding product in appearance, structure, or interaction. Reuse the existing components and design rules, and check the result in its containing surface so duplicated chrome and inconsistent typography do not slip through.

- **[qm#1545](https://github.com/yc-software/qm/pull/1545/files)** (2026-09-22): Transcript elements each hardcoded their own font-size, so multiview panes showed 15px/14px headers beside 12px text; unified on one --chat-font-size base. _Status:_ wound back in [qm#1545](https://github.com/yc-software/qm/pull/1545/files).
- **[qm#1053](https://github.com/yc-software/qm/pull/1053/files)** (2026-09-11): A parallel 'Beautiful UI' design system (10 stacked PRs) and an admin redesign with an Original/New toggle were built next to the existing web UI styles. _Status:_ wound back in [qm#1053](https://github.com/yc-software/qm/pull/1053/files) (closed with #1054-#1062, #992, #1215).
- **[qm#513](https://github.com/yc-software/qm/pull/513/files)** (2026-08-13): Multiview panes showed two stacked headers (pane chrome plus the hosted chat's own top bar). _Status:_ wound back in [qm#513](https://github.com/yc-software/qm/pull/513/files).

### Over-indexing on YC (3 examples)

Treating one organization’s identity or workflow as a requirement of the shared product. Keep defaults and core behavior useful across deployments, and put organization-specific names, assumptions, and workflows in that deployment’s configuration or extensions.

- **[qm#1315](https://github.com/yc-software/qm/pull/1315/files)** (2026-09-16): The generic web UI onboarding says 'the agent harness we use to run YC' and 'your YC partner in a box', and the welcome ideas cite 'YC Deal' and 'the YC investor database'.
- **[qm#1008](https://github.com/yc-software/qm/pull/1008/files)** (2026-09-09): A 29-file 'software factory' loop (Linear auto-triage, forge ship contract) built for YC's own workflow was ported into public src/loops/factory before it had ever run end to end. _Status:_ wound back in [qm#1026](https://github.com/yc-software/qm/pull/1026/files).
- **[qm#530](https://github.com/yc-software/qm/pull/530/files)** (2026-08-15): Assistant and org names were fixed across prompts, manifests, auth and UI; made deployment-configurable with neutral defaults. _Status:_ wound back in [qm#530](https://github.com/yc-software/qm/pull/530/files).

### Regex (3 examples)

Using regex to infer structure or meaning that should come from a parser, a typed error, a stored field, or a model call. These patterns become brittle substitutes for the authoritative data; use the source that actually owns the structure or decision.

Main has 1,443 production regex sites in 380 files; cleanup is the regex-removal backlog.

- **[qm#1354](https://github.com/yc-software/qm/pull/1354/files)** (2026-09-17): The web UI re-parses shell commands with a hand-written tokenizing regex (and sniffs `sed -n Np` and Markdown headings by pattern) to decide how to present tool activity, instead of using the structured call data.
- **[qm#1210](https://github.com/yc-software/qm/pull/1210/files)** (2026-09-15): Composio consent links are found by regex-scanning model text for URLs and Markdown links, then stripped with dynamically built `RegExp`s, rather than arriving as a typed connector-link field.
- **[qm#169](https://github.com/yc-software/qm/pull/169/files)** (2026-08-03): The agent self-API allowlist is a chain of path regexes (`/^\/v1\/projects\/[^/]+$/`, …) instead of matching on the router's declared routes.

### YC info leaking into public qm (1 example)

Publishing organization-specific information in the public repository through code, docs, fixtures, screenshots, or change descriptions. Inspect outgoing content for private identities, operational details, and internal references; keep private deployment material in private storage.

- **[qm#1504](https://github.com/yc-software/qm/pull/1504/files)** (2026-09-22): Public docs/test fixtures had org-specific rollout guidance and identity examples plus 92 tracked screenshots (8.1 MB); scrubbed and AGENTS.md now bans committed screenshots. _Status:_ wound back in [qm#1504](https://github.com/yc-software/qm/pull/1504/files) (partially; YC welcome copy remains).

### Discarded error evidence (1 example)

Replacing or swallowing a failure so the evidence needed to diagnose it disappears. Preserve the primary error and related cleanup failures, with secrets redacted, in access-controlled diagnostics; a concise user-facing message must not be the only surviving record.

- **Sandbox startup and cleanup** (2026-10-02): A provider authentication failure reached the tool transcript as a bare "Command execution failed." The cleanup wrappers in `src/sandbox/sandbox.ts` dropped the original causes, destruction retries in `src/core/orchestrator/sandboxes.ts` swallowed every exception, and `src/harness/agent-tools.ts` recorded only the generic status. Keep the primary failure and every cleanup failure, redacted, in access-controlled diagnostics; a short user-facing message never replaces the evidence. _Status:_ unresolved on main 5dbebac6. [Cleanup wrapper](https://github.com/yc-software/qm/blob/5dbebac68f671cf456ebd42061ff9578fa4fe138/src/sandbox/sandbox.ts#L17-L39), [destruction retries](https://github.com/yc-software/qm/blob/5dbebac68f671cf456ebd42061ff9578fa4fe138/src/core/orchestrator/sandboxes.ts#L163-L172), [tool result](https://github.com/yc-software/qm/blob/5dbebac68f671cf456ebd42061ff9578fa4fe138/src/harness/agent-tools.ts#L734-L748).
