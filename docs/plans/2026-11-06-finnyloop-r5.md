# FinnyLoop r5 Trust and Harness Implementation Plan

**Goal:** Move FinnyLoop authority into QM while keeping finance procedure and orchestration in a Pi package.

**Architecture:** QM owns durable policy, approvals, role-bound worker grants, immutable artifact identity, attestation state and finalization. Pi runs producer and Auditor sessions through QM tools and skills but cannot choose the required checks, issuer identity or evidence snapshot. Spreadsheet recalculation is a later deterministic worker behind the same evidence contract.

**Tech stack:** TypeScript, QM Postgres stores and migrations, existing signed-token helper, existing Slack approvals and session syscalls, Pi 0.82 skills/extensions/SDK, Node test runner.

## Constraints

- No vendored Pi changes.
- No polling cron.
- No caller-provided issuer registry, required checks, attestation set, approval receipt or delivery revision.
- No legacy dual reads or compatibility shim.
- No live deployment or promotion in this work.
- No comments in source files.
- Every behavior starts with a failing caller-visible test.

## Phase 1: Trust kernel

### Persisted shapes

`finny_jobs`

| Column                       | Type            | Rule                                                         |
| ---------------------------- | --------------- | ------------------------------------------------------------ |
| `id`                         | text            | primary key                                                  |
| `scope_id`                   | text            | authorization boundary                                       |
| `plan_digest`                | text            | exact approved plan bytes                                    |
| `artifact_digest`            | text            | exact immutable artifact bytes                               |
| `policy_version`             | text            | Core-owned policy version                                    |
| `required_generations`       | jsonb           | object mapping every required check ID to a positive integer |
| `origin_thread_ref`          | text            | delivery/approval binding                                    |
| `provisional_revision`       | text            | actual Core provisional-delivery revision                    |
| `approval_request_id`        | text nullable   | durable Slack request ID                                     |
| `approval_actor_id`          | text nullable   | resolved Core principal                                      |
| `approval_action`            | text nullable   | `approve`, `reject`, or `request_change`                     |
| `approval_plan_digest`       | text nullable   | must equal job plan digest to finalize                       |
| `approval_origin_thread_ref` | text nullable   | must equal job origin thread to finalize                     |
| `approval_decided_at`        | bigint nullable | decision time                                                |
| `approval_consumed_at`       | bigint nullable | one-use consume marker                                       |
| `ledger_head`                | bigint          | last accepted attestation sequence                           |
| `finalization_key`           | text nullable   | unique finalization idempotency key                          |
| `final_receipt`              | jsonb nullable  | signed receipt token plus payload                            |
| `finalized_at`               | bigint nullable | finalization time                                            |
| `created_at`                 | bigint          | creation time                                                |
| `updated_at`                 | bigint          | latest mutation time                                         |

Indexes and constraints:

- primary key on `id`;
- unique partial index on `finalization_key` when non-null;
- index on `(scope_id, created_at)`;
- checks for non-empty digests/version/thread/revision;
- check `approval_action` in the three allowed values;
- check `ledger_head >= 0`.

`finny_attestations`

| Column                | Type      | Rule                                                |
| --------------------- | --------- | --------------------------------------------------- |
| `seq`                 | bigserial | primary key and monotonic ledger position           |
| `id`                  | text      | unique attestation ID                               |
| `job_id`              | text      | foreign key to `finny_jobs`, cascade delete         |
| `check_id`            | text      | typed policy check                                  |
| `generation`          | bigint    | must equal current required generation when written |
| `verdict`             | text      | `pass` or `block`                                   |
| `evidence_digest`     | text      | exact evidence bytes                                |
| `issuer_principal_id` | text      | authenticated principal from Core                   |
| `issuer_run_id`       | text      | role-bound run grant                                |
| `idempotency_key`     | text      | unique submission key                               |
| `created_at`          | bigint    | server time                                         |

Indexes and constraints:

- unique on `id` and `idempotency_key`;
- index on `(job_id, check_id, generation, seq desc)`;
- index on `(job_id, seq)`;
- checks for positive generation, allowed verdict and non-empty digest/issuer/run.

No prior shape exists, so no backfill or compatibility path is added.

### Task 1.1: Define policy contracts

Files:

- Create `src/finny/types.ts`
- Create `src/finny/policy.ts`
- Create `test/finny-policy.test.ts`

Behavior:

- fixed check ID union;
- fixed policy version;
- change kinds map to required checks;
- multiple change kinds union their checks;
- only invalidated check generations increment;
- full source/logic changes invalidate all applicable checks;
- unknown inputs fail rather than weakening policy.

Verification:

```bash
node --test test/finny-policy.test.ts
npm run typecheck
```

### Task 1.2: Add Postgres trust store

Files:

- Create `src/finny/store.ts`
- Create `src/finny/postgres-store.ts`
- Create `test/finny-store.test.ts`

Behavior:

- create a job from a Core-generated policy snapshot;
- record a plan-bound approval;
- record an attestation only for a required check at its exact current generation;
- deduplicate evidence by idempotency key;
- update ledger head from the inserted sequence;
- never accept caller-selected required checks in mutation methods.

Verification:

```bash
DATABASE_URL=postgres://postgres:qmtest@127.0.0.1:5433/postgres \
  node scripts/run-pg-tests.mjs test/finny-store.test.ts
```

### Task 1.3: Add authoritative finalizer

Files:

- Create `src/finny/finalizer.ts`
- Create `test/finny-finalizer.test.ts`

Input:

```ts
{
  (scopeId, jobId, idempotencyKey);
}
```

Transaction:

1. lock the job row;
2. return the existing receipt for the same finalization key;
3. reject scope mismatch or a different key on an already finalized job;
4. require unconsumed `approve` bound to exact plan digest and origin thread;
5. select the latest attestation for each required check at the exact generation;
6. reject missing checks and any latest `block`;
7. bind the current ledger head and actual provisional revision;
8. construct and Core-sign the receipt while the transaction lock is held;
9. consume approval and persist receipt atomically.

Tests:

- one-check certificate cannot finalize;
- stale generation cannot satisfy policy;
- later BLOCK invalidates earlier PASS;
- approval replay fails;
- wrong scope, plan, thread, artifact or revision fails;
- same idempotency key returns identical receipt;
- different key after finalization conflicts;
- crash before commit leaves approval unconsumed and no receipt.

## Phase 2: Role-bound coordinator and APIs

### Task 2.1: Add Finny worker grants

Files likely to change:

- `src/auth/capability-token.ts`
- `src/sessions/session-syscalls.ts`
- `src/types.ts`
- Create `src/finny/coordinator.ts`
- Create `test/finny-worker-grants.test.ts`

Core creates producer and Auditor sessions. Their grants bind role, job ID, run ID, artifact digest and allowed operations/check IDs. The generic subagent tool cannot self-assign a Finny role.

### Task 2.2: Add narrow routes and tools

Files:

- Create `src/api/routes/finny.ts`
- Modify `src/api/routes/index.ts`
- Modify `src/api/deps.ts`
- Modify `src/wiring.ts`
- Add route and capability tests

Routes expose plan creation, artifact readiness, evidence submission, job status and finalization request. Evidence and finalization inputs do not accept authority-bearing fields.

### Task 2.3: Event-driven rework

Core records `artifact_ready`, `audit_blocked`, `audit_passed` and `rework_requested` job events. A BLOCK wakes the producer session with bounded findings and queues an independent Auditor run. Retry count is policy/config backed by a named human-approved external limit before implementation; until then escalation is explicit, not silently capped.

## Phase 3: Slack plan decisions

Files likely to change:

- `src/slack/approval-cards.ts`
- `src/slack/approvals.ts`
- `src/slack/approval-store.ts`
- `src/types.ts`
- Slack approval/card tests

Design:

- reuse the existing Slack Bolt verification and durable approval request;
- button values carry only opaque request ID;
- Core-loaded approval record carries job ID, plan digest, origin thread and allowed decisions;
- add Finny action IDs for approve, reject and request change;
- identity, plan and thread bindings are compared against Core state;
- settle is atomic and one-use;
- clarification cards store the selected option or bounded free-text answer as a job event.

## Phase 4: Pi package and deterministic workers

Files:

- Create `skills-seed/finnyloop/SKILL.md`
- Create `skills-seed/finnyloop/references/protocol.md`
- Create project extension/package only if lifecycle interception cannot be expressed through existing QM tools
- Add skill validation and orchestration tests

Allocation:

- Skill: finance request classification, plan presentation, check procedures, rework instructions and compact evidence selection.
- QM tools: create job, spawn role-bound runs, upload artifact, submit evidence, read status and request finalization.
- Pi/extension: JobBook read-before-action/write-after-step middleware and compact session entries if an existing hook is insufficient.
- Core: policy, identity, grants, durable events, evidence freshness, BLOCK handling and finalization.

The deterministic spreadsheet worker is isolated and receives immutable bytes plus an evidence grant. It never receives signing material. Core signs accepted evidence.

## Independent gates

- Preflight: clean base, policy and schema reviewed, no live data.
- Revision: every task has failing-then-passing tests and independent spec review.
- Escalation: unresolved BLOCK/rework limit or unavailable deterministic runner stops delivery and asks a human.
- Abort: scope mismatch, replay, stale generation, later BLOCK, mutable artifact or invalid worker grant fail closed.

## Promotion

Out of scope for this branch. Promotion requires independent candidate verification, affected-agent regression, Slack dev-instance QA, rollback proof, and explicit human approval naming the commit and bindings.
