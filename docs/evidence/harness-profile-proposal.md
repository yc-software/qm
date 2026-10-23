# Harness/model selection proposal — July 17, 2026

Historical evidence only. This draft preserves excerpts of a rejected design proposal; it is not a proposal to implement or merge this design. No implementation of the proposed profile platform was recovered from the source exchange.

## Original proposal excerpts

The following excerpts preserve the original wording and show the proposed profile abstraction, configuration state, runtime management, and rollout. Omitted passages are marked.

> The core concept should be an “agent profile”: an atomic `{ harness, model }` pair. That avoids invalid combinations and gives web, Slack, admin, and the runtime one shared contract.

[Intervening text omitted.]

> ## Product contract
>
> - Org admins approve harnesses and models, organized as compatible pairs.
> - The org chooses one default profile.
> - Each scope either inherits the org default or pins its own profile.
> - Each conversation may temporarily choose another approved profile without changing the scope default.
> - Web exposes conversation selection plus an explicit “Make default for this scope.”
> - Slack users can ask the agent to inspect or change the conversation/scope profile through the self-API.
> - When the org default changes:
>
>   - Inheriting scopes move automatically.
>   - Pinned scopes receive a durable, one-time upgrade suggestion.
>   - Users can upgrade, keep their override, or return to inheritance.
>   - The prompt includes the admin-provided reason when available.

[Intervening text omitted.]

> ### 2. Add durable configuration
>
> - [ ] Add an org-approved profile catalog: harness, allowed models, availability, display metadata.
> - [ ] Add the org default profile and an optional change reason.
> - [ ] Add sparse per-scope profile overrides.
> - [ ] Add durable per-session/conversation overrides.
> - [ ] Store an org-default revision with each pinned scope so stale overrides can be detected.
> - [ ] Record upgrade-prompt acknowledgement per scope and org-default revision.
> - [ ] Audit every catalog, default, scope, and conversation change.
> - [ ] Migrate existing `base_model_configs` and web picker configuration without losing current selections.
>
> ### 3. Replace the boot-selected harness with routing
>
> - [ ] Introduce a harness registry containing Pi, OpenCode, Codex, and Claude.
> - [ ] Start native runtimes lazily and expose readiness failures without advertising unusable choices.
> - [ ] Resolve the effective profile before each turn.
> - [ ] Route `runTurn()` to the selected harness.
> - [ ] Ensure all replicas make the same decision from durable configuration.
> - [ ] On a conversation harness change, reset warm provider state and reconstruct from the common durable log.
> - [ ] Keep `HARNESS` as a migration/deployment fallback, not the primary selector.
> - [ ] Separate system utilities—ambient judgment, acknowledgment selection, titles, compaction—from the conversation harness, or make their routing rules explicit.

[Intervening text omitted.]

> ### 8. Roll out safely
>
> - [ ] Deploy with only Pi approved so behavior initially remains unchanged.
> - [ ] Approve Codex and Claude for a small internal cohort.
> - [ ] Observe failures, latency, cost, task behavior, and replay fallback rates by harness.
> - [ ] Enable conversation switching for internal users.
> - [ ] Enable per-scope defaults after canary validation.
> - [ ] Finally allow org admins to change the central default.
> - [ ] Keep a one-click rollback to Pi that preserves all stored scope and conversation preferences.

## Objection recorded in the same exchange

> I smell a little bit of overengineering, keep things simple

## Revised direction

The subsequent proposal extended the existing scoped setting with a `{ harness, model }` pair. It explicitly removed named profiles, a separate profile catalog, a readiness service, a lazy-runtime manager, a health catalog, automatic failover, a cohort framework, and a separate upgrade-notification table. This record establishes the proposed design and the objection, not a claim that the rejected design shipped.
