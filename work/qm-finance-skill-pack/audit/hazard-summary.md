# Source hazard summary

Read-only audit of the Finny source tree identified 131 finance-relevant skills under the focused heuristic.

## Prevalence

- Hermes branding: 63 skills
- Hermes/Finny absolute profile paths: 28
- Hindsight dependencies: 23
- Direct NetSuite client or API access: 11
- Hermes-only tool syntax: 17
- Cross-skill filesystem dependencies: 26
- Credential or `.env` assumptions: 18
- Destructive shell guidance: 6

## Highest-risk sources

- `netsuite-suiteql`: 337 assets, including 62 binary files; direct client access, production identifiers, TBA environment assumptions, Hermes paths, Hindsight subprocesses, backups, and generated outputs. Do not import wholesale.
- `finny-brain-ops`: deeply coupled to Hindsight, Hermes tools, logs, profiles, environment-file key extraction, and mutable resolver state. Decompose domain knowledge only.
- `sharechat-pl-mis`: direct NetSuite client, fixed profile imports, close scripts, and Hindsight assumptions. Redesign before migration.
- `sharechat-ar-collection`: useful domain rules but Hermes profile, resolver, atomic-fetch, and Hindsight dependencies. Prefer the existing QM-neutral derivative as the baseline.
- `hindsight-brain` and `finny-path-corrections`: runtime-specific. Exclude.
- `sharechat-ap-msme-compliance`: direct SuiteQL/REST/TBA access, production identifiers, binary stores, and scripts needing broker refactoring.
- `sharechat-ap-ops`: direct live access, fixed URLs, binaries, and mutation-looking approval links. High operational risk.
- `sharechat-ar-collection-tracker`: direct live access, generated logs/output, credential variable names, and persistent local-store assumptions.
- `sharechat-monthly-mis`: direct client, fixed profile paths, and cross-skill preflight imports.
- `sharechat-gst-audit`: direct SuiteQL, executable reconciliation logic, and binary assets.
- Hermes orchestration and sync skills: translate concepts where useful; do not import implementation.

## Security finding

No convincing live secret values were detected in the focused Finny tree. Placeholder tokens exist. Production account identifiers and endpoints occur broadly and must be treated as deployment-specific configuration rather than reusable skill content.

## Required control

No source skill with direct NetSuite/Hindsight access, environment-file sourcing, a binary database/cache, generated output, or a Hermes-only runtime dependency may enter the target pack without explicit redesign and independent review.
