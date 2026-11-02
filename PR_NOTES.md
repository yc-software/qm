# WS8 PR3: TurnRequest.surfaceOrigin and neutral Destination account replace slackSource/externalSlack/slack* (no behavior change)

Branch `regan/ws8-pr3-origin`, one commit on top of `regan/ws8-surface-contract` (PR 1). It is meant to be folded into the combined WS8 PR, so it has no PR of its own.

## What

Core stops carrying Slack-named fields on the two records that every entry point shares.

- **Turn record.** `TurnRequest.slackSource` and `TurnRequest.externalSlack` become one field, `TurnRequest.surfaceOrigin: TurnSurfaceOrigin`. The same applies to `SpawnMeta`, the persisted sub-agent spawn record. `TurnRequest.origin` was already taken by `TurnOrigin` (human / ambient / automation / direct), so the new field is called `surfaceOrigin`.
- **Delivery destination.** `Destination.slackAccountId`, `slackTeamId` and `slackPolicyNamespace` move under one field, `Destination.account: SurfaceAccount`.
- **Producer.** The Slack plugin builds the origin through a new adapter helper, `slackSurfaceOrigin()` in `src/surfaces/slack/adapter.ts`. Both producers use it: `turn-handler.ts` and `private-continuation.ts`.
- **Adapter post.** `post()` in the Slack adapter now writes `account` instead of the three `slack*` keys.

## Why

These two records reach every entry point, every persisted turn and the delivery outbox. While they are Slack-shaped, every new surface would have to pose as Slack in order to route replies or to carry an external-audience policy. After this change, core reads one neutral origin and one neutral account. The Slack plugin is the only code that knows how Slack fills them in.

## Type changes

`src/surfaces/contract.ts`, added:

```ts
export interface SurfaceAccount {
  id: string;
  workspace?: string;
  policyNamespace?: string;
}

export interface ExternalAudienceAccess {
  companyDomains: string[];
  companyTeamIds: string[];
  serviceCredentials: string[];
}

export type TurnSurfaceOrigin = {
  author: Pick<SurfaceUser, "surface" | "account" | "id">;
  workspace: string;
  policyNamespace?: string;
  replyThread?: string;
} & ({ audience: "internal" } | { audience: "external"; access: ExternalAudienceAccess });
```

`src/slack/external-access.ts`: `ExternalSlackAccess` is now `type ExternalSlackAccess = ExternalAudienceAccess`. The fields are identical.

`src/types.ts`:

```diff
 export interface SpawnMeta {
-  slackSource?: TurnRequest["slackSource"];
-  externalSlack?: TurnRequest["externalSlack"];
+  surfaceOrigin?: TurnSurfaceOrigin;
 export interface Destination {
-  slackAccountId?: string;
-  slackTeamId?: string;
-  slackPolicyNamespace?: string;
+  account?: SurfaceAccount;
 export interface TurnRequest {
-  slackSource?: { accountId: string; teamId: string; userId: string; externalPolicyNamespace?: string; replyThreadTs?: string };
-  externalSlack?: { accountId: string; teamId: string; userId: string; companyDomains: string[]; companyTeamIds: string[]; serviceCredentials: string[] };
+  surfaceOrigin?: TurnSurfaceOrigin;
```

### Field mapping (nothing dropped)

| Old                                                                   | New                                                                                                       |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `slackSource.accountId` / `externalSlack.accountId`                   | `surfaceOrigin.author.account`                                                                            |
| `slackSource.userId` / `externalSlack.userId`                         | `surfaceOrigin.author.id`, with `author.surface = "slack"`                                                |
| `slackSource.teamId` / `externalSlack.teamId`                         | `surfaceOrigin.workspace`                                                                                 |
| `slackSource.externalPolicyNamespace`                                 | `surfaceOrigin.policyNamespace`                                                                           |
| `slackSource.replyThreadTs`                                           | `surfaceOrigin.replyThread`                                                                               |
| `externalSlack` present                                               | `surfaceOrigin.audience = "external"`, plus `access {companyDomains, companyTeamIds, serviceCredentials}` |
| `externalSlack` absent                                                | `surfaceOrigin.audience = "internal"`                                                                     |
| `Destination.slackAccountId` / `slackTeamId` / `slackPolicyNamespace` | `Destination.account.id` / `.workspace` / `.policyNamespace`                                              |

### Persisted shapes (illustrative values)

These are stored in `runs.request`, `sessions.spawn_meta`, approval records (`request`), run-signal payloads and `deliveries.destination`. No table, column, index or constraint changes.

```jsonc
// runs.request before
{ "surface": "slack", "slackSource": { "accountId": "partner", "teamId": "TP", "userId": "U1", "externalPolicyNamespace": "external-slack:TP:abc", "replyThreadTs": "1700.1" },
  "externalSlack": { "accountId": "partner", "teamId": "TP", "userId": "U1", "companyDomains": ["company.example"], "companyTeamIds": ["TC"], "serviceCredentials": ["search"] }, … }
// runs.request after
{ "surface": "slack", "surfaceOrigin": { "author": { "surface": "slack", "account": "partner", "id": "U1" }, "workspace": "TP", "policyNamespace": "external-slack:TP:abc", "replyThread": "1700.1",
  "audience": "external", "access": { "companyDomains": ["company.example"], "companyTeamIds": ["TC"], "serviceCredentials": ["search"] } }, … }

// deliveries.destination before
{ "type": "slack", "target": "D1", "slackAccountId": "partner", "slackTeamId": "TP", "slackPolicyNamespace": "external-slack:TP:abc" }
// deliveries.destination after
{ "type": "slack", "target": "D1", "account": { "id": "partner", "workspace": "TP", "policyNamespace": "external-slack:TP:abc" } }
```

## Migration: one rewrite at deploy

Old stored records are rewritten once by a data migration. Nothing converts old shapes at read time; readers see only the new fields.

The migration is `surfaces/0001-neutral-origin-and-account` in `src/surfaces/origin-migration.ts`. It is registered in `wiring.ts` next to the other data migrations and runs in the normal startup migration path:

- **Where it runs:** `applyPgMigrations`, with one transaction, the schema advisory lock and a checksum row in `qm_schema_migrations`. `src/migrate-main.ts` runs the same path.
- **How it rewrites:** three `pg_temp` SQL helpers do the rewriting and are dropped at the end:
  - one for a destination;
  - one for a request or spawn record (top-level origin, plus `triggerDestination` and `origin.destination`);
  - a TEXT wrapper that parses JSON safely.
- **Missing tables:** each `UPDATE` is guarded with `to_regclass`, so a database without a given table skips that step.
- **Idempotent:** each `UPDATE` selects only rows that still contain an old key, and the helpers return a record unchanged when it has no old keys. A second run produces identical rows.

**Edge cases:**

- **Unparseable rows:** TEXT rows that Postgres cannot parse as jsonb are left exactly as they were instead of failing the migration. These are pre-#1595 rows that contain `\u0000` or a lone surrogate.
- **`null` values:** `slackSource: null` and `externalSlack: null` are dropped without inventing an origin.
- **Empty strings:** an empty `replyThreadTs`, `externalPolicyNamespace` or `slackTeamId` is omitted, as `slackSurfaceOrigin()` does.

| Store                                                                                                                           | Rows rewritten                                                                                                                                                                                    | What changes                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `runs.request` (TEXT)                                                                                                           | Rows with an old key that are any of: non-terminal; external (`externalSlack`) at any age; finished in the last 24h; the latest run of their session; the latest non-private run of their session | `slackSource`/`externalSlack` → `surfaceOrigin`. Old keys → `account` in `triggerDestination` and `origin.destination` |
| `sessions.spawn_meta` (TEXT)                                                                                                    | All rows with an old key                                                                                                                                                                          | Same as `runs.request`                                                                                                 |
| `run_signals.payload`                                                                                                           | Unconsumed rows only                                                                                                                                                                              | `payload.request` and `payload.sessionRequest`                                                                         |
| `deliveries.destination`                                                                                                        | Undelivered and unexpired rows only                                                                                                                                                               | Old keys → `account`                                                                                                   |
| `approvals.json.request`                                                                                                        | All rows with an old key                                                                                                                                                                          | Same as `runs.request`                                                                                                 |
| `crons`, `loops`, `webhooks`, `monitors`, `secret_drops` (`json.destination`) and `keychain_asks` (`json.requesterDestination`) | All rows with an old key                                                                                                                                                                          | Old keys → `account`                                                                                                   |

### Terminal runs left untouched, and why

The `runs` table is never pruned, so rewriting every Slack run would rewrite most of the table under the startup lock. I checked every place that reads a stored run's request. Old keys stay only in internal runs that are terminal, finished more than 24h ago, and not the latest run of their session; nothing reads the origin from those:

| Reader                                                                  | Which runs it reads                                             | Covered by                         |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| `wiring.ts` `runTriggered`                                              | `runs.latestForThread(threadRef)`, the latest run of the thread | Latest run per session             |
| `session-syscalls` session-message path                                 | `latestForThread(..., { excludePrivateMessages: true })`        | Latest non-private run per session |
| `currentExternalSlackRun`, and through it the external capability check | Requires `status = 'running'`                                   | Non-terminal                       |
| Session spawn binding                                                   | The caller's running run                                        | Non-terminal                       |
| `privateContinuationSource`                                             | Any run by id, but returns nothing unless the run is external   | External runs at any age           |
| Run-result recovery sweep (`run-result-delivery.ts`)                    | `terminalFinished` with a 60-minute lookback                    | Finished in the last 24h           |

**Other untouched records:**

- **Delivered or expired `deliveries` rows** are never routed again.
- **Consumed `run_signals`** are never replayed.

**Cost, measured locally:**

- **Setup:** a Postgres 18 database on the QA sprite, with 200,000 runs of about 2 KB each across 50,000 sessions, nearly all carrying `slackSource`.
- **Result:** the runs `UPDATE` took 11.2s and rewrote 50,150 rows: the latest run per session plus the pending ones.
- **What it scales with:** the number of rows (a LIKE scan) and the number of sessions (one rewrite per session, with an index lookup for each newer-run check). Production's row count is unknown to me.

**Test:** `test/surface-origin-migration.test.ts`.

- **Setup:** it migrates a fresh database, then seeds old-shape rows in every store above.
  - **Runs:** pending, latest, recently finished, an older internal run, `externalSlack`-only, external with a namespace, a private-latest run with its public predecessor, empty strings, `null`, an existing `surfaceOrigin` plus old keys, and an unparseable row.
  - **Other records:** spawn meta, a signal with both `request` and `sessionRequest`, a consumed signal, delivered and undelivered deliveries, an approval, and all six destination tables.
- **Then:** it removes the migration's checksum row and runs `migrate-main` again.
- **Assertions:** it reads through the stores (`runs.get`, `rowToSession`) and the raw rows, and compares origins against `slackSurfaceOrigin()` output. It checks that out-of-scope rows are unchanged and the unparseable row is byte-identical.
- **Idempotence:** both re-runs produce identical rows: a plain re-run, and a re-run after deleting the checksum row.

**Live check:**

- **Seeded:** an old-shape pending delivery and an old-shape latest thread run were written into the dev database.
- **Boot:** the dev instance applied the migration at startup. Both rows came out in the new shape, and the poller posted the delivery to Slack.
- **Untouched:** an already-delivered old-shape row stayed as it was.

### Blue-green overlap: one follow-up migration is needed

Core deploys blue-green (`cli/templates/fly/core.toml`). During the overlap, the old server keeps writing old shapes after the new one has migrated. Capability tokens minted before the deploy can also carry an old-shape `destination` for up to 48h, and new code copies that into keychain asks, secret drops and control-service destinations.

Recommended:

- Ship the same statements once more under `surfaces/0002-neutral-origin-and-account-sweep`, in the first release that ships at least 48h after this one. That sweeps the stragglers.
- After that, nothing old remains in any read set.

Until then, the stragglers are not lost or misrouted for default-account Slack traffic, because default is what both shapes resolve to. Non-default-account turns written by the old server during the overlap are refused by the existing `slack-account:` reference check, which fails closed.

## What is NOT changed

- **No table, column or index changes.** The only migration is the data rewrite above.
- **Capability-token claim `externalSlack: true`** keeps its name. These tokens live up to 48h. Renaming the claim fails open on rollback: an old server would not see the external flag on a new token and would skip the external-only restrictions in `server.ts`.
- **`Destination.threadTs`, `react`, `pin`, `unfurlLinks`, and `webTranscript.kind: "slack_reply"`.** `slack_reply` is also matched in SQL by the delivery store, so renaming it would widen this change.
- **External-Slack policy config:** `ExternalSlackPolicies`, `externalSlackRequestAllowed` and `externalSlackNamespace`.
- **Triggered-turn inheritance in `wiring.ts`** (`runTriggered`). It still copies only the non-external part of the latest Slack run's origin, as it did with `slackSource`, and marks the result `audience: "internal"`. So triggered resumes of external threads are still refused (covered by `triggered-slack-resume`).
- **Delivery candidates.** `orchestrator.ts` still stamps `{id, workspace}` with no policy namespace. `runResultDelivery` still includes the namespace. Approval cards still carry `{id, workspace}`.
- **Config and env.** No new env vars, settings or config.

## Rollback / mixed-version note

Old code reading new-shape rows sees no `slackSource`/`externalSlack`/`slack*`.

- **External-channel and `slack-account:` turns:** refused. External-access checks fail closed, so nothing leaks, but in-flight non-default-account runs would be refused until they age out.
- **Deliveries:** an old Slack poller routes a new-shape delivery through `clientForAccount("default", undefined)`, the default workspace's client. For a non-default account this usually means `channel_not_found`. For a channel shared across workspaces it could post from the wrong workspace. The risk lasts only while undelivered rows exist (6h TTL).

If rollback safety matters for this deploy, either write the old destination keys alongside `account` for one release or treat the deploy as no-rollback. This branch does neither.

## Known edge

Only in tests, with no production writer. A migrated destination that had `slackTeamId` but no `slackAccountId` becomes `account: { id: "default", workspace }`. Read by a poller built without `clientForAccount`, it used to get the default client and now gets none. Production always supplies `clientForAccount`, and there it maps to `clientForAccount("default", teamId)` exactly as before.

## Model- or user-facing text

No model- or user-facing text changed.

## QA performed

**Local checks:**

- `tsrs --noEmit`, `eslint`, `oxlint --deny-warnings` and `prettier --check` are clean on the changed files.
- `knip` reports nothing from this diff; locally it only complains about the missing vite/electron binaries.

**Tests** (native Postgres 18), all passing: `surface-origin-migration`, `approval-store`, `run-result-delivery`, `turns-union-guard`, `external-slack-core`, `external-slack-policy`, `triggered-slack-resume`, `surfaces-contract`, `slack-index.integration`, `session-syscalls`, `migrate-main`, `migration-policy`, `postgres-migration-startup`, `postgres-migrations`, `postgres-cron-run-as-migration`, `postgres-drop-harness-choice-migration`, `slack-deliveries`, `postgres-delivery-store`, `delivery-store`. A broader Slack and cron sweep also passed. The only failures were Postgres connection timeouts on the overloaded QA machine.

**Live dev instance:**

- **Setup:** `scripts/dev-instance.sh up --surface slack --sandbox sprites`, with native Postgres 18 (`DATABASE_URL` in the worktree `.env`). It ran on slot pool3 (@rbot3) in the Development YC Slack workspace. The model was Claude via the subscription token.
- **Driver:** Firefox driven by Playwright, using the Slack QA browser login. Results were checked through the database and Slack `conversations.history`/`replies`.

What was exercised (times Pacific):

1. **DM turn** (~12:58). DM to @rbot3, which replied "pong". `runs.request.surfaceOrigin` = `{author:{surface:"slack",account:"default",id:U…}, workspace:T…, audience:"internal"}` with no `slackSource` key. The `run:` delivery destination was `{"type":"slack","target":"D…","account":{"id":"default","workspace":"T…"}}` and was delivered.
2. **Channel thread reply** (~13:01). @-mention in #dev-canary. The bot replied "pong" in the thread. The origin carried `replyThread`. The delivery was `post:…` to `C…:<thread ts>` with `account` and `audienceScopeId`, and was delivered.
3. **Approval card round trip** (~13:03–13:05). A DM asked for `mkdir -p /tmp/ws8qa && rm -r /tmp/ws8qa && echo done`.
   - The recursive-delete rule raised a card. Its delivery `command-approval:…` was a principal destination with `account {id, workspace}`, and the card was delivered.
   - "Allow once" was clicked in Slack. The resumed run carried `approval.approved` and the same `surfaceOrigin`.
   - The first approved attempt ran into "no default sandbox" in the fresh dev DB. The agent then created a sprite and asked again, as expected for a once-approval. The second card was approved, the command ran on the sprite, and the bot replied "Output: `done` (exit 0)."
4. **Scheduled post** (~13:09–13:12). In a channel thread, the agent created a one-time cron through its native cron tool. At 13:12 the cron fired. Its `cron:…` delivery was delivered, and "WS8 PR3 scheduled ping" appeared in the thread.
5. **Startup migration, live** (~14:00, slot pool2/@rbot2, after the read-time shim was replaced by the migration).
   - Seeded in the dev database: an old-key pending delivery to the cron thread, and the old `slackSource` shape on that thread's latest run.
   - On boot, `qm_schema_migrations` recorded `surfaces/0001-neutral-origin-and-account`. The delivery came out as `{"type":"slack","target":"C…:<ts>","account":{"id":"default","workspace":"T…"}}` and was posted to the thread.
   - The run's `surfaceOrigin` was rebuilt with `replyThread`. An earlier already-delivered old-key row was left as it was.
   - A DM to @rbot2 afterwards replied "pong" through an `account` destination.

Not run: a side-by-side main instance. Each flow above produced the standard result for that flow, and only field names differ in persisted rows.

## Reviews

**Fresh-context adversarial review** (claude-opus-5-5, of an earlier commit): request changes, 78/100. Findings and how each was handled:

- `surfaces-contract` test fixture was stale: fixed.
- **Historylessness lens:** the read-time normalizer has been replaced by the one-time migration above, and no read-time shim remains.
- **Second fresh-context review, of the migration** (60/100, request changes). Changes made in response:
  - unparseable TEXT rows no longer abort startup;
  - `keychain_asks.requesterDestination` is now covered (the first draft rewrote a field that doesn't exist);
  - runs finished in the last 24h are covered for the recovery sweep;
  - the window queries use `NOT EXISTS` against the session index instead of full `DISTINCT ON` sorts;
  - `null` handling was fixed;
  - the dead `deliveryCandidates` rewrite was dropped and `triggerDestination` added;
  - the test now compares against `slackSurfaceOrigin()` and covers every store.

  The blue-green straggler point is documented above as a required follow-up migration.

- Cron-retarget normalization was untested: removed. `stripCandidate` drops account fields from capability destinations, so that comparison never sees them on either side and behaves as before.
- Duplicate external-access type: `ExternalSlackAccess` is now an alias.
- Mixed-version and rollback hazard: documented above.

Every security path traced matched the base: `externalSlackRequestAllowed`, `serviceAllowed`, the external capability check, private continuation, triggered-turn inheritance and spine routing.

**Wall of shame:** this branch has no PR, so the lens reviews and CI check run on the combined WS8 PR.

## Diff size (vs `regan/ws8-surface-contract`)

|                     | Added   | Removed | Net      |
| ------------------- | ------- | ------- | -------- |
| Production (`src/`) | 260     | 114     | +146     |
| Tests               | 351     | 45      | +306     |
| **Total**           | **611** | **159** | **+452** |

PR_NOTES.md itself is excluded.
