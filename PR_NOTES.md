# WS8 PR5: message mirror keyed by surface and account (no behavior change)

PR-description content for the integrator. This branch (`regan/ws8-pr5-mirror`, base `regan/ws8-surface-contract`) is folded into #2845; delete this file when merging.

## What

- The message mirror (`src/surface-cache/surface-cache.ts`; tables `channel_messages`, `channel_state`, `channel_files`) is keyed by `(org_id, surface, account, …)` instead of `(org_id, …)`. Every read, write, join and conflict target filters on `surface`/`account`.
- `IngestEvent`, `CachedMessage`, `ReadMessagesOpts`, `SearchOpts`, the revisedSince options, `activeThreads` and `listContainers` options, plus `markHandled`/`members`/`isMember`/`containerState`, take an optional `SurfaceKey { surface?, account? }`. When it is absent, the key is `('slack', '')`, so every current caller reads and writes exactly the rows it did before.
- `CachedMessage` carries `surface`/`account` only when they differ from the default, so Slack responses are byte-identical.
- Ambient judge mention rendering no longer imports `src/slack/mrkdwn.ts` from `src/surface-cache/`. `Surface` gains `readableText(text, mentions)`, which the Slack adapter implements with the existing `resolveMentions`. `renderAmbientPrompt(batch, readable)` and `AmbientJudgeDeps.readable` take the renderer, and `app-ambient.ts` looks it up through a required `AppDeps.surfaces` registry, wired in `src/wiring.ts`.
- The Slack live-history fallback in `wiring.ts` only answers Slack keys.

## Why

WS8 moves Slack behind the Surface contract. The mirror was the last store whose identity was Slack's `(channel, ts)` model, so two surfaces with the same container id would have overwritten each other's rows. This PR changes the key first, with no caller changes, so later PRs can pass the real surface and account through.

## Schema: before → after

`channel_messages`

- Before: PK `(org_id, container, ts)`.
- After: new columns `surface TEXT NOT NULL DEFAULT 'slack'` and `account TEXT NOT NULL DEFAULT ''`. PK `(org_id, surface, account, container, ts)`, named `channel_messages_surface_key`.
- The secondary indexes `channel_messages_by_container`, `_live_by_container`, `_by_sub`, `_tsv`, `_edited_by_container` and `_deleted_by_container` are unchanged.

`channel_state`

- Before: PK `(org_id, container)`.
- After: adds `surface` and `account` with the same definitions. PK `(org_id, surface, account, container)`, named `channel_state_surface_key`.

`channel_files`

- Before: PK `(org_id, container, ts, file_id)`.
- After: adds `surface` and `account` with the same definitions. PK `(org_id, surface, account, container, ts, file_id)`, named `channel_files_surface_key`.

Representative `channel_messages` row (invented example):

|        | org_id | surface | account | container | ts                | text                | …             |
| ------ | ------ | ------- | ------- | --------- | ----------------- | ------------------- | ------------- |
| before | acme   | —       | —       | C0123     | 1793655180.116999 | planning the launch | …             |
| after  | acme   | slack   | ''      | C0123     | 1793655180.116999 | planning the launch | … (unchanged) |

Backfill: existing rows get `surface='slack'` and `account=''` through the column defaults, a catalog-only change with no table rewrite. `account` is not derivable from the mirror tables, because no team id is stored there, so legacy rows keep `''`. Slack writers also keep `''` in this PR. Writing the team id for new rows while legacy rows hold `''` would split one message's edits across two keys. Populating `account` needs a single step that rewrites legacy rows as well.

Migrations, all in `createPostgresSurfaceCache`:

- `surface-cache/store/0007`: `SET LOCAL lock_timeout = '3s'`, then `ADD COLUMN IF NOT EXISTS surface/account` on the three tables.
- `surface-cache/store/0008` (concurrent-only migration, which the runner executes outside a transaction): `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS channel_{messages,state,files}_surface_key ON …(org_id, surface, account, container[, ts[, file_id]])`.
- `surface-cache/store/0009`: `SET LOCAL lock_timeout = '3s'`, then per table `ALTER TABLE … DROP CONSTRAINT …_pkey, ADD PRIMARY KEY USING INDEX …_surface_key`.

## Online safety

- **0007:** `ADD COLUMN` with a constant default and `NOT NULL` is catalog-only (PG ≥ 11), so there is no rewrite and no scan. It holds `ACCESS EXCLUSIVE` briefly. The 3 s lock timeout makes it fail and retry at boot rather than queue all mirror traffic behind a long reader.
- **0008:** `CREATE UNIQUE INDEX CONCURRENTLY` does not block reads or writes. If a build fails partway, the runner (`pg-pool.ts`) finds the invalid index on the next boot, drops it with `DROP INDEX CONCURRENTLY` and rebuilds it. The migration is recorded only after every index is valid. While it builds, it holds the global `qm:schema-migrations` advisory lock, so other stores' boot migrations wait for it.
- **0009:** `ADD PRIMARY KEY USING INDEX` on columns that are already `NOT NULL` is a catalog swap with no scan. The adversarial review measured about 7 ms on 400k rows. It holds `ACCESS EXCLUSIVE` briefly, under the 3 s lock timeout, and it is atomic in one transaction.
- `CREATE INDEX CONCURRENTLY` cannot run inside the store's inline-DDL transaction, which is why the index build is its own concurrent-only migration and the key swap is a third migration.

## Compatibility

- Slack: no behavior change. Ingest, reads, search, activeThreads, listContainers, members, containerState, revisedSince, markHandled and the admin `slack-mirror` routes return identical data. The tests and live QA below cover this.
- **Rollback / mixed versions after 0009:** code from before this PR uses `ON CONFLICT (org_id, container, ts)` and `ON CONFLICT (org_id, container)`. Those statements fail once the old primary keys are gone. That is fine for the persistent core's single-replica `Recreate` rollout. But rolling back past this PR means every mirror write fails until a matching unique index exists again. The fix while only Slack rows exist is `CREATE UNIQUE INDEX CONCURRENTLY channel_messages_legacy_key ON channel_messages(org_id, container, ts)`, plus the same for `channel_state (org_id, container)` and `channel_files (org_id, container, ts, file_id)`. An alternative was to ship only 0007 and 0008 now and defer 0009. That would keep rollback trivial, but two surfaces sharing a container id would then still collide, which this PR exists to prevent. It is an open decision below.
- Non-Slack callers of `POST /v1/surface-cache/ingest`, if any exist, still write with the default key, as they did before. The route's `surface` body field is still not threaded into the cache. If such a surface reaches the ambient judge without being registered in the surface registry, the judge now throws and the error is logged. Before, it rendered Slack mention syntax.

## Not changed

- The `ts` column keeps its name and is still the message id. Renaming it to `message_id` is a separate later change.
- PR #2786 (`regan/mirror-raw-slack`, `channel_messages.raw` and `src/slack/message-content.ts`) has **not** merged into main, so this PR does not add `raw` and does not duplicate it. When #2786 lands, its migration needs a number after 0009.
- `sent_at` and `role` were in the original brief. They were implemented and then removed after four Wall of shame lenses (Overengineering, Duplication, Historylessness, Config-matrix) rejected them: nothing reads either column, and `role` duplicated `self`/`bot`. Add them with the first reader. For Slack, `sent_at` comes from `ts` via `slackTsToMs`.
- `src/slack/message-revisions.ts` (`slackTsToMs`, `parseSlackThreadRef`) is untouched.
- Callers do not yet pass `surface`/`account`: the ingest route, `app-messaging.ingestSurfaceEvents`, `app-ambient` read/markHandled/containerState, and agent tools. The sibling PRs (3 and 4) and later ones thread the surface through.
- No env vars, flags or config.

## English text a person or model reads

No model-facing text changed: the ambient judge prompt renders identically.

One new error message, seen in logs when the ambient judge meets an unregistered surface:

- old: (none; mentions were rendered with Slack syntax)
- new: `ambient: no registered surface ${surface}`

## Tests

- New `test/postgres-surface-cache-keys.test.ts`. Both tests fail on the base branch.
  - **Legacy upgrade:** writes mirror rows (thread, edit, delete, files, members, handled), downgrades the tables to the pre-PR schema (no `surface`/`account`, old PKs, migrations 0007–0009 unrecorded), then reopens the store so the upgrade runs. It asserts that every read is deep-equal to before the upgrade, that a post-upgrade edit updates the legacy row in place, that all rows are backfilled to `('slack', '')`, and that each table's PK is the new key.
  - **Two surfaces, same container id:** a second surface/account with container `C1` and the same `ts` keeps separate rows, reply counts, files, handled flags, search results, active threads, members and container summaries.
- Updated `test/ambient-judge.test.ts` (passes the Slack adapter's `readableText`) and `test/surface-cache.test.ts` (judge deps take `readable`).
- Run locally on Postgres 18, all green: `postgres-surface-cache-keys`, `postgres-surface-cache`, `surface-cache`, `ambient-judge`, `slack-mirror-fidelity`, `admin-slack-mirror`.
  - The adversarial reviewer also ran `slack-mirror-ingestion`, `-backfill`, `-context`, `surface-cache-ingest-mapper` and `surface-cache-ambient` (which passes when run alone).
- typecheck, eslint, oxlint and knip are clean. The only knip messages are the environment's missing `vite`/`electron` plugin binaries, which are not part of this diff.
- CI/CD, run via `workflow_dispatch` on `959b207d6`, succeeded: https://github.com/yc-software/qm/actions/runs/41527938398. An earlier dispatch on `79bede11b` failed only `test/postgres-base-schema.test.ts` with "terminating connection due to administrator command". The base branch's own CI run (`2621e471a`) fails that same file, so the failure is pre-existing and not from this diff.

## Live QA (dev instance, same database across versions)

Setup:

- `scripts/dev-instance.sh up --sandbox sprites --surface both`, slot pool2 (@rbot2) from the dev Slack pool.
- Native PostgreSQL 18 on the computer, with `DATABASE_URL=…/qa_mirror` in each worktree's `.env`.
- Sandbox egress needed QA-only shims, not part of the PR: a local HTTP CONNECT forwarder, because the sandbox's egress proxy is `https://`, which axios and `ws` don't tunnel through; and a `--require` preload that gives socket-mode's `ws` a proxy agent.

1. **Main** (`origin/main` @ b4f4b300e) booted and verified (socket exclusive, canary round trip). Over the bot token of a second pool app (rbot3), I posted in #dev-canary: a root message, two thread replies, a second channel message, a `chat.update` edit of reply two, and messages addressing rbot2.
   - The mirror held them: the thread under the root, the edit with `edited_at` set, `bot=true`.
   - I enabled ambient for the channel through `PUT /api/admin/scopes/channel:C0BFETFPUHJ/ambient-policy`. The judge ran (claude-haiku-5-5, about 0.2–0.4 s) and recorded judgments.
   - The stored prompt rendered `<@U0BD32FSCR0>` as `@rbot3`.
   - Snapshots taken: admin `GET /api/admin/slack-mirror`, `/slack-mirror/messages?container=…`, `?q=launch`, `?container=…&q=launch`; and store-level `activeThreads`, `readMessages` (thread and channel), `revisedSince`, `search`, `members`, `containerState` and `listContainers`.
2. **dev down; branch** (`959b207d6`) booted on the **same** database. The upgrade ran clean: 0007, 0008 and 0009 were recorded at boot; PKs became `(org_id, surface, account, …)`; there were no invalid indexes; all rows became `('slack', '')`.
3. **Comparison:**
   - Admin search endpoints: byte-identical.
   - Admin container list and container messages: identical except for one new row, the branch boot's own canary message (self, deleted), and the matching `lastTs`/`updatedAt`.
   - Main's store code and the branch's store code, both run against the upgraded database: byte-identical for every read above.
4. **On the branch:** an edit of a pre-upgrade message updated the legacy row in place (still one row).
   - The ambient judge ran on new overheard messages, and the prompt again rendered the mention as `@rbot3`.
   - Haiku returned `ignore` for these bot-authored test messages on both main and the branch, even with standing orders and a `user` bot policy. The act → worker path was not exercised in either version.
5. **Cleanup:** I deleted the 11 QA messages from #dev-canary, stopped both dev instances (`dev down`), and confirmed that QA created no sandbox sprites.

## Diff size (vs `regan/ws8-surface-contract`, at 959b207d6)

|                     |   added | removed |      net |
| ------------------- | ------: | ------: | -------: |
| production (`src/`) |     148 |      63 |      +85 |
| tests (`test/`)     |     201 |       1 |     +200 |
| **total**           | **349** |  **64** | **+285** |

This file (`PR_NOTES.md`) is not counted; it is notes only.

## Reviews

**Adversarial review** (fresh context, at 79bede11b). Findings and how each was handled:

- Rollback/mixed-version hazard of 0009: documented above and left as an open decision.
- No lock timeout on 0007/0009: fixed.
- Surface not threaded through ingest/ambient call sites: deferred to the sibling/later PRs. The Slack live fallback is now limited to Slack keys.
- Silent raw-text fallback when the registry is missing: fixed (registry required; unregistered surface throws).
- Write-only `sent_at`/`role`: removed.
- 0008 holds the migration lock while building: documented.
- It also checked and found fine: legacy reads and joins, conflict targets, byte-identical Slack output.

## Wall of shame review report

Reviewed commit: `959b207d6`

The triage model was claude-haiku-4-5. Always-reviewed lenses skip triage.

| Lens                           | Reviewer                                               | Verdict      | Score  | Assessment                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------ | ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overengineering                | fresh-context subagent                                 | Accept       | 88/100 | Only the minimum the surface/account key needs remains (keyOf default, three migrations, keyed filters, one-line `readableText`); write-only `sent_at`/`role` were removed. Nit: the `"slack"` literal in the wiring liveFallback. |
| Band-aid fixes                 | fresh-context subagent                                 | Accept       | 92/100 | Fixes causes (real keys, one rendering path); unregistered surfaces now fail loudly; the Slack-only live fallback fails safe until another puller exists.                                                                          |
| Duplication                    | fresh-context subagent                                 | Accept       | 88/100 | Duplicated `role` is gone; `DEFAULT_SURFACE` owns the default inside the cache; one leftover `input.surface ?? "slack"` in app-ambient predates this PR.                                                                           |
| Hand-rolling                   | fresh-context subagent (at 75e61c139, carried forward) | Accept       | 92/100 | Reuses the migration runner's concurrent-index support, `resolveMentions` and the existing registry; its only nit (role CASE) has since been removed.                                                                              |
| Non-durability                 | fresh-context subagent (at 75e61c139, carried forward) | Accept       | 94/100 | All new state is in Postgres; migrations resume after a crash (invalid index rebuilt; PK swap only after the index is valid).                                                                                                      |
| Config-matrix expansion        | fresh-context subagent                                 | Accept       | 86/100 | No env/flags; the unread columns and the second rendering path were removed; a Slack-only live fallback is acceptable while Slack is the only adapter.                                                                             |
| Provider drift                 | claude-haiku-4-5                                       | Not relevant | —      | No provider-specific deviations introduced.                                                                                                                                                                                        |
| God files                      | fresh-context subagent (at 75e61c139, carried forward) | Accept       | 88/100 | Mirror keying stays in the mirror store; mention rendering moves to the adapter. Optional: build the registry outside `wiring.ts`.                                                                                                 |
| Mismatched UI                  | claude-haiku-4-5                                       | Not relevant | —      | No UI components changed.                                                                                                                                                                                                          |
| Over-indexing on YC            | claude-haiku-4-5                                       | Not relevant | —      | No YC-specific customization.                                                                                                                                                                                                      |
| Regex                          | claude-haiku-4-5                                       | Not relevant | —      | No regex patterns added.                                                                                                                                                                                                           |
| YC info leaking into public qm | claude-haiku-4-5                                       | Not relevant | —      | No private data exposed.                                                                                                                                                                                                           |
| Discarded error evidence       | claude-haiku-4-5                                       | Not relevant | —      | No error handling changed.                                                                                                                                                                                                         |
| Arbitrary limits               | claude-haiku-4-5                                       | Not relevant | —      | No new caps introduced.                                                                                                                                                                                                            |
| Historylessness                | fresh-context subagent                                 | Accept       | 85/100 | No second copy of any fact; one migration, old PK replaced rather than kept; the column default and optional key should become required once callers pass the surface.                                                             |
| Over-testing                   | claude-haiku-4-5                                       | Not relevant | —      | No testing approach changes.                                                                                                                                                                                                       |
| Prod-like QA                   | claude-haiku-4-5                                       | Not relevant | —      | Schema/query work; live dev-instance QA was done anyway (above).                                                                                                                                                                   |
| Performance                    | fresh-context subagent (at 75e61c139, carried forward) | Accept       | 92/100 | No rewrite or blocking lock; reads keep their index paths; `channel_messages_by_container` can be dropped later.                                                                                                                   |
| Token performance              | claude-haiku-4-5                                       | Not relevant | —      | Prompt text is unchanged.                                                                                                                                                                                                          |
| Honorable mentions             | claude-haiku-4-5                                       | Not relevant | —      | No screenshots or code comments added.                                                                                                                                                                                             |

Lenses marked "carried forward" were reviewed at 75e61c139. Between that commit and `959b207d6`, the only changes were removing `sent_at`/`role`/`sentAt`, adding the `DEFAULT_SURFACE` constant, and making the registry required with a loud failure.

## Open decisions

1. Keep 0009 (no cross-surface collision; rollback past this PR needs the unique-index SQL above) or defer it to a later PR (trivial rollback; a collision would fail loudly instead of being stored separately). This branch keeps it.
2. The `account` backfill for Slack (team id) is deferred until a step can rewrite legacy rows together with new writes.
