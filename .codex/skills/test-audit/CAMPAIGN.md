# Test-pruning campaign

A campaign prunes a whole suite toward a stated goal, such as "remove 20% of
the least useful test LOC while keeping line coverage within 2 points". Vague
goals like "clean up the tests" stop too early. The value bar, retention bar,
and evidence rules in [SKILL.md](SKILL.md) apply throughout.

## 1. Baseline

Pin a `main` SHA. Record test file count, test LOC per suite, per-job CI wall
time from the last few green `main` runs, and every file's pass or fail state.
Keep baseline failures in their own list.

Measure per-file line coverage from the repository root:

```sh
DATABASE_URL=postgres://… node .codex/skills/test-audit/scripts/coverage-redundancy.mjs \
  --budget 1280 --out /tmp/cov-base.json \
  $(jq -r '.scripts["test:pg"]' package.json | tr ' ' '\n' | grep '^test/' | sed 's/^/--serial /')
```

It runs every root test file in its own process under `NODE_V8_COVERAGE`,
counts covered non-blank lines in `src/`, `scripts/`, `plugins/chassis/`,
`deploy/`, and `cli/src/` (root tests exercise all of them; change with `--src`), and records for each file the lines no
other file covers. `--serial` files share one database and run one at a time.
Files that fail or exceed `--timeout` seconds contribute no coverage, so a
broken test cannot mask the loss of a working one. `--budget` greedily builds a candidate pool of the most redundant files whose
joint removal loses at most that many lines. The metric counts a line covered
when any of its characters executed; use it for before-and-after deltas.

## 2. Lanes

Split the candidate pool into lanes of similar size along production owners.
Include each candidate's covered-line count, unique lines, joint loss, runtime,
top `src/` files, and the surviving files that cover most of the same lines.

## 3. Read-only ledger per lane

Give each lane to its own read-only reviewer. It reads every candidate in full,
the production owner, and the named overlapping tests, then marks each file:

- `R`: retain, naming the contract and the regression only it catches;
- `T`: trim, naming the exact test declarations to delete;
- `D`: delete, naming the keeper test that asserts the same contract.

## 4. Cutover

Apply `D` and `T` marks in coherent batches, removing stranded helpers,
`test:pg` entries, and CI steps. Re-measure coverage after each batch and stop
before the budget.

## 5. Preservation review

Before claiming completion, independent reviewers compare deleted coverage
against the keepers, looking for contracts that lost their only proof. For
each restored contract, mutate the production owner once and confirm the
keeper goes red, then restore it exactly.

## 6. Hand off

Report baseline and final test LOC, file count, coverage, and CI wall time;
retained false positives; product bugs found; and PR links.
