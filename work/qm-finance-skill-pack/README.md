# QM finance skill pack migration workspace

This workspace curates finance-domain skills from `/Applications/hermes-finny-skills` into QM-native skill bundles.

The source repository is treated as read-only. Nothing in this workspace is imported into the live QM organization until the catalog, transformations, tests, and staging plan receive human approval.

## Principles

- Preserve finance knowledge, references, scripts, and tests that remain valid.
- Remove Hermes-specific branding, paths, tools, profiles, and runtime assumptions semantically rather than by blind text substitution.
- Use QM-native credentials, tools, scopes, artifacts, workflow evidence, and materialized skill-relative paths.
- Choose one authoritative variant for every target skill and document merges.
- Exclude secrets, mutable production snapshots, caches, binary databases, historical output files, and unrelated general-purpose skills.
- Do not overwrite live `org:acme` skills during preparation or staging.

## Layout

- `skills/` contains proposed QM-native bundles.
- `audit/` contains source selection, transformation, compatibility, and validation reports.

## Validation

Run tests with bytecode redirected outside the repository, remove the temporary cache, then validate and exercise QM's actual ingestion planner:

```bash
cache_dir="$(mktemp -d)"
PYTHONPYCACHEPREFIX="$cache_dir" python3 -m pytest -q -p no:cacheprovider skills/finance-router/tests
rm -rf "$cache_dir"
python3 validate.py
node qm-plan-smoke.mjs
```

`validate.py` intentionally fails on `__pycache__`, `.pytest_cache`, binary assets, forbidden runtime dependencies, secrets, malformed manifests, incorrect pack globs, and missing referenced assets.
