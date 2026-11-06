# Ambient thread-context eval (PR #3144, stacked on #3118)

This eval checks how the ambient judge and the proactive worker handle Slack threads.

- **Fixtures are fictional.** There is no production data, and no credentials appear anywhere in this directory.
- **The harness is not part of the PR.** It needs a model gateway, so it lives on its own branch.

## What it runs

Both harnesses are `node:test` files. They build the real app with `test/support/build-app.ts` and feed Slack events through the real mirror (`createMirror(...).mirrorMessageEvent`). Each message then goes through ingest, cursor, window, prompt, the judge, and the recorded `ambient_judgments` row. Nothing is stubbed between a Slack event and the judgment.

**`ambient-judge-eval.test.ts`** evaluates the judge only.
- The judge model is real.
- Workers are never claimed (`canClaimRuns: () => false`), so no worker model is called.
- Fixture `SCENARIOS` hold the history, the final message, `expect` (`act` or `ignore`) and `asked` (whether `asked_by` must equal the final message's id).
- `kind` is `h2h` (person-to-person; QM must stay quiet) or `keep` (behaviour that must be preserved).
- History messages are judged one by one, as in production. QM's own posts are scripted from user `UQM` / bot `BQM`, the assistant identity.

**`ambient-worker-eval.test.ts`** evaluates the judge and the worker together.
- Both models are real, and the worker's Slack deliveries are captured.
- History is ingested before the channel policy is set, so it advances the cursor without starting workers. The standing orders are set immediately before the final message.
- `leak` is a regex for facts from neighbouring threads that must not appear in the reply.
- `neighbour` records whether a neighbouring thread is named at all.
- `want` lists regexes that the reply must all match (`onTarget`).
- For the correction scenario, a `leak` hit is expected and correct: the worker quotes the old terms as "was $100k". `onTarget` is the check that matters there.

## Model settings

**Judge:** `claude-haiku-5-5` (`EVAL_JUDGE`).
- Called through the production `agent.judge` path: pi `oneShot`, `thinkingLevel: "low"`, the production system prompt from the checked-out commit.

**Worker:** `claude-sonnet-5` (`EVAL_WORKER`).
- This is the production agent turn with `modelId` set to that model.

**Gateway:** `modelGateway` with `apiKeyHeader: "x-api-key"` and identity model mapping.

**Other settings:** `securityScreen: "off"`. Everything else is the `testConfig` defaults.

## How to run

You need Node 24, Postgres 16 and an Anthropic-compatible model gateway (`MODEL_GATEWAY_URL`, `MODEL_GATEWAY_TOKEN`).

```sh
git clone https://github.com/yc-software/qm && cd qm
git checkout <arm commit>            # see the table below
npm ci
cp <this dir>/ambient-judge-eval.test.ts  test/zz-ambient-judge-eval.test.ts
cp <this dir>/ambient-worker-eval.test.ts test/zz-ambient-worker-eval.test.ts
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
export MODEL_GATEWAY_URL=... MODEL_GATEWAY_TOKEN=...

# judge: 3 runs of every scenario; EVAL_ONLY takes comma-separated substrings of scenario names
EVAL_LABEL=myarm EVAL_RUNS=3 EVAL_OUT=/tmp/judge.jsonl \
  node scripts/run-pg-tests.mjs --jobs 1 test/zz-ambient-judge-eval.test.ts
# worker
EVAL_LABEL=myarm EVAL_RUNS=4 EVAL_OUT=/tmp/worker.jsonl EVAL_ONLY="neighbouring alerts,keep:" \
  node scripts/run-pg-tests.mjs --jobs 1 test/zz-ambient-worker-eval.test.ts

python3 summ.py /tmp/judge.jsonl      # per-scenario correct/runs, act count, asked_by hits, mean prompt tokens
python3 wsumm.py /tmp/worker.jsonl -v # per-scenario replied/leaked/onTarget, plus reply text with -v
```

`run-pg-tests.mjs` creates an isolated database per run, so arms can run in parallel from separate worktrees. Running more than about three worker jobs at once against one gateway produced spurious `ignore` decisions; see `excluded/`.

Prompt tokens in the judge results are `countTokens(system) + countTokens(prompt)`, taken from `src/util/tokens.ts`.

## Arms (the `label` in the results)

| label | commit | what it is |
|---|---|---|
| `main` | `850599e91` | `main` at the time of the eval |
| `b3118` | `e3b7217ff` | #3118 head |
| `attr-only` | — | `e3b7217` + the `thread=` attribute only (no prompt lines) |
| `fix-v1`, `fix` | — | `557949c`'s judge (attribute + 4 judge lines); worker wording differs from the final |
| `fix-v2` … `fix-v4`, `fix-v6` | — | worker-wording variants; `fix-v6` is `557949c`'s exact wording |
| `fix-v5` | — | rejected variant that hid other threads' replies |
| `557949c` | `557949cb4` | first #3144 commit |
| `fix-b` | `3621c0ce6` | #3144 head: plus the thread's opener and the assistant's latest reply kept in view (the runs were made before a lint-only change to the sort comparator) |

## Files

- `results/*.jsonl`: one line per run. The judge rows include the full rendered prompt, the decision, the reason and `askedBy`. The worker rows include every delivered reply.
- `SUMMARY.md`: the output of `summ.py` and `wsumm.py` for each results file.
- `excluded/worker-v0-invalid.jsonl`: from the first harness version, where history workers ran and posted during the final step. Not used.
- `excluded/worker2-contended.jsonl`: run alongside three other jobs, which produced judge `ignore` decisions that didn't reproduce when rerun alone. Not used.
