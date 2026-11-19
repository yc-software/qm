# Tenant tokens

Tenant separation is moving from an implicit binding to an explicit argument. Postgres row security stays as a backstop; application code becomes the primary enforcement.

## Today

`withTenant(id, fn)` binds a tenant id in `AsyncLocalStorage` for the duration of `fn`. `PgPool.q` and `PgPool.query` read that binding and set `qm.tenant_id` on each transaction, and every tenanted table's `tenant_isolation` policy filters on `qm_bound_tenant()`. Nothing in a function signature says that it needs a tenant, and a query that runs with the wrong binding is caught only by row security.

## Target

- `Tenant` is a token minted only by `withTenant`, which hands it to its callback: `withTenant(id, (tenant) => …)`. Its constructor is private and refuses any caller but the tenant module, so a token in hand was produced by a `withTenant` call. `withTenant` checks only that the id is well formed. The ratchet counts its direct call sites; helpers that wrap it, such as `inTenant` and `inBootTenant`, count once, so reviewers check what reaches them.
- Stores take the token as their first argument and query through `pool.forTenant(tenant)`. Every tenant-scoped statement carries an explicit `tenant_id = $n` predicate or insert value, so the store is correct even for a login that bypasses row security.
- `forTenant` still sets `qm.tenant_id`, from the token rather than the ambient binding, so row security keeps checking.

## Transition rules

- While both paths exist, `forTenant` refuses a token for a tenant other than the one bound to the work. A half-converted codebase is never less safe than the implicit path alone. Work with no ambient binding, including work inside `withoutTenant`, may use any token.
- `ambientTenant()` returns the token minted by the enclosing `withTenant`. It is the bridge from converted stores to callers that do not yet carry a token, and it disappears with the binding.
- `scripts/tenant-ratchet.ts` (CI step `Tenant ratchet`) uses the type checker to count call sites in the program rooted at `src/` (core code and the `plugins/chassis` code it imports), excluding tests:
  - `mintSites`: `withTenant`.
  - `implicitQueries`: `PgPool.q`, `PgPool.query`, `withPgTransaction`, which take their tenant from the binding, and `PgPool.pool` and `PgPool.sessionPool`, which hand out raw connections with no tenant at all.
  - `ambientReads`: `boundTenant`, `currentTenant` and `ambientTenant`.
  - `ambientCaches`: `perTenant`, `tenantListeners` and `onTenantLoad`, which key state by the binding.

  CI fails when a count rises above `scripts/tenant-ratchet.json`, when one falls without the baseline being lowered, or when the baseline and the metrics disagree. `node scripts/tenant-ratchet.ts --update` only lowers the baseline; raising it is a deliberate edit to the JSON. `--list` prints the per-file breakdown. Only calls are counted: a function passed by reference, such as `{ q: pg.q }`, is not.

## Slices

1. Foundation: the token, `forTenant`, the ratchet, and the admin grant stores as the first converted store. `AdminService` bridges with `ambientTenant()`.
2. Boundaries carry the token: request routing puts the request's token on the route context (`ctx.tenant`, read with `tenantOf(ctx)`); `inTenant`, `inBootTenant`, `claimThenBind` and `claimThenLoad` hand it to their callbacks; the wake sweep and monitor poller pass it on; and the Slack plugin is told its tenant instead of reading the binding. Work that takes no token yet ignores it until its store converts. `AdminService` takes the token as its first argument: admin and auth routes pass the request's token, and the grant store decides whether to seed a tenant from its token (`seedsTenant(tenant)`). `AdminService` callers that sit outside a boundary (turn capability minting, skill promotion, and the membership and persona-handover closures in `wiring.ts`) pass `ambientTenant()` at the call site until later slices thread the token through those paths.
3. Access and audit stores, starting with a token form of `withPgTransaction` that takes the `PgPool` and the token rather than a raw pool, which the ACL grant store needs: ACL grants, audit log, scoped event and credential usage sinks, decisions, rate-limit budgets, teams. The token form is `pool.forTenant(t).transaction(fn)`. The first part converts ACL grants, decisions, budgets and teams. Routes pass `tenantOf(ctx)`, and the app methods that open, upload, list and share files or grant and revoke access take the token as their first argument. A turn reads the token once at the start of `handleTurn` and hands it to resolution, turn context, the credential catalog, team scoping, the budget check and spend records, compaction, security screening, file registration and artifact access, and the decision hooks. These sites still pass `ambientTenant()`: `handleTurn` itself until the run worker hands over its token; the deployment environment closure in `wiring.ts`; team membership in scope membership checks; persona grantee scopes; artifact and deployment grant permissions in the app helpers; file search; skill visibility; the control service's artifact share; the Slack core client's file read and app access decision; and in the deploy service the reach, manage and grantee checks, the grant made at publish, sharing and owner transfer. The second part converts the audit log and the Postgres event sinks built on `createPostgresEventSink` (error log, egress audit, credential usage). Routes pass `tenantOf(ctx)`, including through the route `audit(ctx, e)` helper and the credential and git brokers. The egress audit relay records each batch with the token `inTenant` hands it, and the egress authorizer's direct Postgres sink mints the token from the capability's tenant claim. The run worker hands its token to the turn's failure record, and the reaper and the keychain ask expiry sweep record with the token their claim hands them. Within a turn, the token reaches approval summaries, security steering, the spend limit check, compaction, broker usage in the credential catalog, sandboxes, skills, surface tools, the tool context and memory capture. Writers that receive no token yet go through two bridges: `recordAuditInBinding` (`src/audit/audit-log.ts`) and `recordErrorInBinding` (`src/admin/error-log.ts`). Each reads `ambientTenant()` when a tenant is bound. When none is bound, the audit bridge reports the lost event as a persist failure and the error bridge still reports the error, which matches what the store write did before. The audit bridge serves the deploy service (which live edits reuse), the app helpers (shared by the session, messaging, skill, deployment, turn and ambient app methods), keychain approval decisions, the MCP tool service and persona owner handover. The error bridge serves the app helpers, the Slack core client's delivery error reports, session title and next prompt suggestion failures, inbox pass errors, and the sandbox, memory capture and job computer error reports in `wiring.ts`. The deployment layer's audit record in `wiring.ts` still passes `ambientTenant()` directly.
4. Identity and directory: directory store and sync, user store, broker sessions.
5. Sessions: session store, participants, items, spend, search, admin reads, LLM captures, tool output.
6. Runs and processes: run store, reads, returns, signals, activity, process registry, swarm store.
7. Delivery, surfaces and schedules: delivery store, surface caches and policies, cron fire store, personas, environments.
8. Files, memory, deploy and search: file artifacts and uploads, vector store and memory service, deploy store and page views, resource search.
9. Shared persistence primitives: `createPostgresMap` and the stores built on it, advisory locks, the notify bus, the cron job queue and the leader lease, which own the remaining raw `pool` and `sessionPool` sites. The map's six query sites stand for every map-backed store, so this slice is wider than its count suggests.
10. Tables that are not per tenant (the tenant registry, migrations ledger, instance heartbeats and the other tables `test/tenant-tables.test.ts` lists as untenanted) move to an explicit untenanted handle, so the remaining implicit queries are all genuinely tenanted.
11. Ambient reads and caches: replace the remaining `boundTenant` and `currentTenant` reads and the binding-keyed caches with token-keyed state.
12. Remove the implicit path: `PgPool.q` and `PgPool.query` stop reading the binding, `withPgTransaction` loses its binding form, and `AsyncLocalStorage`, `boundTenant`, `currentTenant`, `ambientTenant` and `pinTenant` are deleted. `withTenant` remains only as the mint at boundaries, and the ratchet is retired once the query, read and cache counts reach zero; `mintSites` stays above zero by design.

## Document-context inheritance slice

Unreleased internal session APIs now carry the existing request/turn token:

| Before                                                        | After                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| `SessionStore.inheritContextFrom(sessionId, sourceSessionId)` | `inheritContextFrom(tenant, sessionId, sourceSessionId)` |
| `SessionStore.setParentSession(sessionId, parentSessionId)`   | `setParentSession(tenant, sessionId, parentSessionId)`   |
| `App.detachSession(sessionId, principalId)`                   | `detachSession(tenant, sessionId, principalId)`          |
| `App.forkSession(sessionId, principalId, options?)`           | `forkSession(tenant, sessionId, principalId, options?)`  |
| `startSession(app, sessions, actorId, input)`                 | `startSession(tenant, app, sessions, actorId, input)`    |
| `SessionSyscallsFactory.forTurn(binding)`                     | `forTurn(tenant, binding)`                               |
| `conversations.start(actorId, input)`                         | `start(tenant, actorId, input)`                          |

All remaining arguments and return types are retained. The request route or turn
supplies `Tenant`; it is separate from `SessionSyscallBinding` and saved requests.
The source lookup and parent update carry explicit SQL tenant predicates. The
provenance target writer is still part of the pending conversion; this slice does
not claim complete session tenant isolation.

`PgPool` additionally exposes its existing `ready(): Promise<void>` initializer.
Its old methods retain their signatures and behavior. Transactional session batch
reads await this initializer and continue reading through the supplied client,
without retaining an unused raw query pool. `ready` checks only that pool's own
migrations and closed-store state; it adds no tenant authorization or new state.

No HTTP or stored JSON fields, tables, columns, keys, indexes, constraints,
settings, providers, or backfills change. Internal source callers must supply the
token in the same core build; existing HTTP clients remain compatible. The real
Postgres foreign-parent regression exercises a database owner and verifies that a
foreign source cannot set a parent or propagate private context. Ancestry/fork/
syscall checks and the affected persistence initialization checks pass. Focused
independent review accepted the implemented slice95/100; it excludes the pending
provenance writer and transactional-reader authorization conversion.

The related skill-audience entry points also retain all old arguments and gain
leading `Tenant`: `App.moveArtifactHome(type, id, toScope, movedBy)` becomes
`moveArtifactHome(tenant, type, id, toScope, movedBy)`, and
`App.updateOwnedSkill(id, principalId, patch, options?)` becomes
`updateOwnedSkill(tenant, id, principalId, patch, options?)`. The HTTP skill editor
supplies its request token; the move controller reuses its existing token. Their
ACL audience queries use that token without another ambient read. Return types,
patch/options fields, authorization, locks, revisions, and stored/HTTP JSON remain
unchanged. Existing deployment/provenance operations called by these methods are
still legacy paths. Five affected authorization/release/control files pass;
focused independent review accepted this slice96/100.

## Schedule-edit token forwarding

These internal methods gain a leading `tenant: Tenant`; all previously listed
arguments and return types remain unchanged:

| Owner            | Before                                     | After                                              |
| ---------------- | ------------------------------------------ | -------------------------------------------------- |
| `App`            | `updateCron(id, patch, by, trial?)`        | `updateCron(tenant, id, patch, by, trial?)`        |
| `App`            | `setCronEnabled(id, enabled, by?)`         | `setCronEnabled(tenant, id, enabled, by?)`         |
| `App`            | `setCronFireNote(id, note, by)`            | `setCronFireNote(tenant, id, note, by)`            |
| `App`            | `setCronRuntime(id, runtime, by?)`         | `setCronRuntime(tenant, id, runtime, by?)`         |
| `App`            | `setCronDestination(id, destination, by)`  | `setCronDestination(tenant, id, destination, by)`  |
| `ControlService` | `patchCron(id, req, claims, trial?)`       | `patchCron(tenant, id, req, claims, trial?)`       |
| `ControlService` | `noteCron(id, text, claims)`               | `noteCron(tenant, id, text, claims)`               |
| `ControlService` | `setCronEnabled(id, enabled, claims)`      | `setCronEnabled(tenant, id, enabled, claims)`      |
| `ControlService` | `retargetCron(id, destinationKey, claims)` | `retargetCron(tenant, id, destinationKey, claims)` |

HTTP routes forward `tenantOf(ctx)` and turn tools forward `deps.tenant`. The
locked schedule privacy check uses that token for its ACL audience query. No
additional ambient read or tenant mint is introduced. Existing locks, privacy
refreshes, linked-copy checks, trial checks, revisions and audit behavior remain.
No tenant token enters tool inputs, HTTP bodies, saved claims or stored records.
There are no table, column, key, index, constraint, JSON, setting, provider,
migration or backfill changes. Core source callers must update together; HTTP
clients need no changes. Other schedule stores remain on their legacy tenant APIs.

## App grant token forwarding

`DeployService.grantAppAccess(grant)` becomes
`grantAppAccess(tenant: Tenant, grant)`, and
`DeployService.releasePrivateApp(grant, revision, context)` becomes
`releasePrivateApp(tenant: Tenant, grant, revision, context)`. All other argument
and return types remain unchanged. `App.grant` already receives the request/turn
token and forwards it to both paths. Existing locked ACL queries and writes use
that token; no tenant mint or ambient bridge is added. Revision, disclosure,
owner and current-session checks retain their behavior. Other deployment and
session operations remain on legacy tenant APIs.

No table, column, key, index, constraint, stored JSON, HTTP/tool/job payload,
setting, provider, migration or backfill changes. Core callers update in the same
build; HTTP clients are unchanged. The token remains a separate argument and is
never added to grants or private context.

`publishDocumentLearning(documents, memory, auditLog, input)` similarly becomes
`publishDocumentLearning(tenant: Tenant, documents, memory, auditLog, input)`.
The orchestrator supplies its existing turn token for the publication audit.
All input fields, publication checks, return types and stored/HTTP/tool payloads
are unchanged. No configuration, schema, migration or backfill changes. Automatic
memory capture remains a separate legacy tenant path.

## Deployment write token forwarding

Each listed internal signature gains a leading `tenant: Tenant`; all previous
arguments and return types remain unchanged:

| Owner              | Before                                               | After                                                        |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------ |
| DeployService, App | `redeploy(id, input)`                                | `redeploy(tenant, id, input)`                                |
| DeployService      | `rollbackApp(id, version, options?)`                 | `rollbackApp(tenant, id, version, options?)`                 |
| App                | `rollbackApp(id, version, actor?)`                   | `rollbackApp(tenant, id, version, actor?)`                   |
| DeployService, App | `archiveApp(id, context?)`                           | `archiveApp(tenant, id, context?)`                           |
| DeployService, App | `restoreApp(id, actorId?, context?)`                 | `restoreApp(tenant, id, actorId?, context?)`                 |
| DeployService, App | `renameApp(id, name, context?)`                      | `renameApp(tenant, id, name, context?)`                      |
| DeployService, App | `setAppDisplayName(id, displayName, context?)`       | `setAppDisplayName(tenant, id, displayName, context?)`       |
| DeployService, App | `setAppAlwaysOn(id, alwaysOn, context?)`             | `setAppAlwaysOn(tenant, id, alwaysOn, context?)`             |
| DeployService, App | `setAppEmbedAncestors(id, embedAncestors, context?)` | `setAppEmbedAncestors(tenant, id, embedAncestors, context?)` |
| DeployService, App | `setAppConnectors(idOrName, connectors, actor)`      | `setAppConnectors(tenant, idOrName, connectors, actor)`      |
| DeployService      | `pushGit(id, runReceivePack, actor?)`                | `pushGit(tenant, id, runReceivePack, actor?)`                |
| App                | `runAppGitPush(id, actor, runReceivePack)`           | `runAppGitPush(tenant, id, actor, runReceivePack)`           |
| DeployService      | `editSource(idOrName, actor, edit)`                  | `editSource(tenant, idOrName, actor, edit)`                  |
| DeployService      | `deployOrUpdate(input)`                              | `deployOrUpdate(tenant, input)`                              |
| Function           | `createAppFiles(deps)`                               | `createAppFiles(tenant, deps)`                               |

Request routes supply `tenantOf(ctx)` and turn tools supply their existing
`deps.tenant`. `createAppFiles` retains that token in the per-turn file helper;
it is not a globally shared service. Deployment methods forward it through the
existing locked output-context checks and internal deployment calls. The two
ACL audience queries use it without a new ambient bridge. No token enters
private context, Git claims, deployment inputs or saved files. Existing locks,
source checks, approvals, revisions, provider operations and return values remain.
Other deployment authorization/store operations still use legacy tenant APIs.

No table, column, key, index, constraint, stored JSON, HTTP/tool/job payload,
setting, provider, migration or backfill changes. Core source callers update
together; HTTP clients remain compatible.

## Memory capture token forwarding

These internal signatures prepend `tenant: Tenant`; every previous argument and
return type remains unchanged:

| Owner                | Before                                                            | After                                                                     |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| MemoryService        | `capture(scopeId, facts, at, by?, context?)`                      | `capture(tenant, scopeId, facts, at, by?, context?)`                      |
| MemoryStrategy       | `onTurnEnd?(ctx)`                                                 | `onTurnEnd?(tenant, ctx)`                                                 |
| Queue input callback | `capture(turns, id, signal)`                                      | `capture(tenant, turns, id, signal)`                                      |
| Function             | `captureMemoryTurns(deps, turns, id?, signal?)`                   | `captureMemoryTurns(tenant, deps, turns, id?, signal?)`                   |
| Function             | `writeFacts(memory, scope, facts, by, context, turn)`             | `writeFacts(tenant, memory, scope, facts, by, context, turn)`             |
| Function             | `replayConversation(strategy, scopeId, conversation)`             | `replayConversation(tenant, strategy, scopeId, conversation)`             |
| Function             | `setOnboardingStatus(memory, scope, status, today, by, version?)` | `setOnboardingStatus(tenant, memory, scope, status, today, by, version?)` |
| SlackCoreClient      | `noteSurfaceHistoryGap?(container, note)`                         | `noteSurfaceHistoryGap?(tenant, container, note)`                         |
| Function             | `createSlackHistoryReader(deps)`                                  | `createSlackHistoryReader(tenant, deps)`                                  |

`startSlackPlugin(cfg, core, tenantId: string)` becomes
`startSlackPlugin(cfg, core, tenant: Tenant)`. Its middleware and delivery lane
continue using `tenant.id` where the existing boundary takes an ID.
`createTenantSlackRuntimes`'s `runtimeFor(tenantId)` callback becomes
`runtimeFor(tenantId, token: Tenant)`; the existing `withTenant` callback supplies
that token. The environment-account starter's internal `startPlugin(config,
tenantId)` callback likewise becomes `startPlugin(config, token: Tenant)`, bound
from its existing authoritative single-tenant ID through `inBootTenant`.

Request routes and turn tools supply their existing token. The durable capture
worker forwards the token from its existing `inTenant(job.data.tenantId, …)`
boundary. It is never saved in the job or capture metadata. Classification,
provider routing, registry, tidy and disclosure wrappers preserve the argument.
The document capture audit uses it; audit destination/count/session/private
fields retain their shapes and still contain no fact text. Notebook stores and
provider protocols remain unchanged; this is not full memory-store conversion.

The standalone memory benchmark now reads the database's boot tenant and runs
inside that tenant binding, refusing a database without a single boot tenant.
It adds no environment variable; the existing DATABASE_URL selects the database.
The local live-provider qualification forwards its existing boot callback token.

No table, column, key, index, constraint, stored row/JSON, HTTP/tool/job/provider
payload, setting, provider selection, migration or backfill changes. Tokens stay
separate from scopes, grants, capture data and external calls. Core source callers
and typed integrations update together; HTTP/provider clients remain compatible.
