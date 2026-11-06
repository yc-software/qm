# Migration policy

## In scope

Finance-domain instructions and executable bundles that support NetSuite read-only retrieval, AR, AP, close, financial analysis, MIS, reconciliation, audit, statutory review, and controlled report generation.

## Out of scope

- Hermes agent operation, configuration, desktop, TUI, gateway, profile management, and skill-authoring instructions
- Entertainment, gaming, media, generic creative, generic MLOps, and unrelated productivity skills
- Credentials, tokens, profile state, caches, database snapshots, generated reports, and mutable production extracts
- Skills whose behavior depends on a Hermes-only tool or service unless an equivalent QM-owned path is explicitly designed and tested

## Required transformations

Each migrated skill must:

1. Have one canonical lowercase-hyphen name and a trigger-oriented description.
2. Use only QM-supported frontmatter fields.
3. Contain no Hermes branding or runtime references.
4. Contain no `.hermes`, `HERMES_HOME`, Hermes profile, or Hermes CLI paths.
5. Replace Hermes tool calls with actual QM tools or remove the unsupported workflow.
6. Resolve credentials through QM keychain/broker boundaries without exposing secrets.
7. Use materialized skill-relative files rather than fixed installation paths.
8. Declare required capabilities based on behavior.
9. Preserve only current, reusable knowledge; historical point-in-time figures must become examples or be removed.
10. Include every referenced file and pass reference-integrity checks.
11. Pass secret, sensitive-data, binary, executable, and unsafe-operation review.
12. Be tested through the observable QM path before staging publication.

## Publication gates

- Source selection recorded
- Transformation diff reviewed
- Scripts independently reviewed
- Tests pass
- No live organization mutation
- Human approval of the catalog
- Staging import and runtime exercise
- Human approval before any replacement or publication to `org:acme`
