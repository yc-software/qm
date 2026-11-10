# Tenant tokens

Tenant separation is moving from an implicit binding to an explicit argument. Postgres row security stays as a backstop; application code becomes the primary enforcement.

## Today

`withTenant(id, fn)` binds a tenant id in `AsyncLocalStorage` for the duration of `fn`. `PgPool.q` and `PgPool.query` read that binding and set `qm.tenant_id` on each transaction, and every tenanted table's `tenant_isolation` policy filters on `qm_bound_tenant()`. Nothing in a function signature says that it needs a tenant, and a query that runs with the wrong binding is caught only by row security.

## Target

- `Tenant` is a token minted only by `withTenant`, which hands it to its callback: `withTenant(id, (tenant) => …)`. Its constructor is private and refuses any caller but the tenant module, so a token in hand proves that a tenant boundary vouched for it.
- Stores take the token as their first argument and query through `pool.forTenant(tenant)`. Every tenant-scoped statement carries an explicit `tenant_id = $n` predicate or insert value, so the store is correct even for a login that bypasses row security.
- `forTenant` still sets `qm.tenant_id`, from the token rather than the ambient binding, so row security keeps checking.

## Transition rules

- While both paths exist, `forTenant` refuses a token for a tenant other than the one bound to the work. A half-converted codebase is never less safe than the implicit path alone. Work with no ambient binding may use any token.
- `ambientTenant()` returns the token minted by the enclosing `withTenant`. It is the bridge from converted stores to callers that do not yet carry a token, and it disappears with the binding.
- `scripts/tenant-ratchet.ts` (CI step `Tenant ratchet`) counts, with the type checker, three kinds of call sites in `src/` and `plugins/`:
  - `implicitQueries`: `PgPool.q`, `PgPool.query` and `withPgTransaction`, which take their tenant from the binding.
  - `ambientReads`: `boundTenant`, `currentTenant` and `ambientTenant`.
  - `ambientCaches`: `perTenant`, `tenantListeners` and `onTenantLoad`, which key state by the binding.

  CI fails when any count rises above `scripts/tenant-ratchet.json`, and when one falls without the baseline being lowered (`node scripts/tenant-ratchet.ts --update`). `--list` prints the per-file breakdown.

## Slices

1. Foundation: the token, `forTenant`, the ratchet, and the admin grant stores as the first converted store. `AdminService` bridges with `ambientTenant()`.
2. Boundaries carry the token: inbound HTTP routes, Slack middleware and the background claimers (cron scheduler, run worker, delivery relay, monitor poller, loop ingress, wake sweep, swarm reconcile, `claimThenLoad`) pass the token from `withTenant` into the work they start. Admin routes then pass it to `AdminService`, removing that bridge.
3. Access and audit stores: ACL grants, audit log, scoped event and credential usage sinks, decisions, rate-limit budgets, teams.
4. Identity and directory: directory store and sync, user store, broker sessions.
5. Sessions: session store, participants, items, spend, search, admin reads, LLM captures, tool output.
6. Runs and processes: run store, reads, returns, signals, activity, process registry, swarm store.
7. Delivery, surfaces and schedules: delivery store, surface caches and policies, cron fire store, personas, environments.
8. Files, memory, deploy and search: file artifacts and uploads, vector store and memory service, deploy store and page views, resource search.
9. Shared persistence primitives: `createPostgresMap` and the stores built on it, advisory locks and the notify bus. The map's six query sites stand for every map-backed store, so this slice is wider than its count suggests.
10. Tables that are not per tenant (the tenant registry, migrations ledger, instance heartbeats and the other tables `test/tenant-tables.test.ts` lists as untenanted) move to an explicit untenanted handle, so the remaining implicit queries are all genuinely tenanted.
11. Ambient reads and caches: replace the remaining `boundTenant` and `currentTenant` reads and the binding-keyed caches with token-keyed state.
12. Remove the implicit path: `PgPool.q` and `PgPool.query` stop reading the binding, `withPgTransaction` takes a token, and `AsyncLocalStorage`, `boundTenant`, `currentTenant`, `ambientTenant` and `pinTenant` are deleted. `withTenant` remains only as the mint at boundaries, and the ratchet, at zero, is retired.
