# NetSuite source selection

## Target

`skills/netsuite-readonly-finance/` is a concise QM-native skill for governed, read-only NetSuite finance retrieval and interpretation.

## Sources compared

1. Existing QM-native `netsuite-readonly-finance` baseline
2. `netsuite-executor/netsuite-suiteql/SKILL.md` and its reference tree
3. `finny/netsuite-suiteql/SKILL.md` and its reference tree

The two source trees contain a large overlapping operational knowledge base. The executor variant is the operational comparison baseline because it is slightly narrower and closer to the execution boundary. The Finny variant was checked for additional finance coverage and corrections. Neither source tree was copied wholesale.

## Selection

### Preserved from the QM baseline

- Strict read-only behavior
- No credential exposure
- Governed execution boundary
- Explicit scope, period, currency, book, and dimension binding
- Metadata-first retrieval
- Bounded pagination and completeness reporting
- Untrusted-data handling
- Concise body with deeper references loaded only when needed

### Curated from the executor and Finny sources

Only reusable concepts that remain valid without a profile-specific runtime were retained:

- Transaction header, transaction line, and accounting-line grain separation
- Exact line-level join requirement when attaching dimensions to accounting impacts
- Parent-account versus posting-leaf roll-up controls
- Operational open-item population versus cumulative GL-balance distinction
- AP and AR transaction-family completeness, including credits, advances, deposits, applications, and refunds
- Posting versus non-posting transaction treatment
- Metadata verification for fields, custom fields, statuses, periods, books, and dimensions
- Grouped-query display-name pitfalls and separate ID resolution
- Query dialect, date-literal, aggregate, pagination, and silent-empty-result cautions
- Transaction-currency, base-currency, and consolidated-currency separation
- Sign validation by source and transaction type rather than a universal rule
- Link-table direction, link-row fan-out, and payment/application tracing controls
- Numeric-looking identifier normalization
- Trial-balance, subledger-to-GL, page-count, and opening-plus-movement completeness checks

These ideas were rewritten as neutral controls in:

- `references/suiteql.md`
- `references/schema-and-joins.md`
- `references/finance-populations.md`
- `references/analysis.md`

## Exclusions

The following material was deliberately excluded:

- Direct Python, REST, OAuth, or local NetSuite clients
- Authorization construction, token-based authentication, credential environment variables, or secret files
- Account URLs, production endpoints, account identifiers, employee identifiers, vendor watchlists, and other deployment-specific IDs
- Fixed period IDs, subsidiary IDs, accounting-book IDs, account IDs, class IDs, approval codes, and custom-field enums
- Profile paths, virtual environments, local repositories, local schema databases, and runtime setup instructions
- Memory-service calls, session history, or recalled operational state
- Raw-response debugging that bypasses the governed executor
- Generated dashboards, reports, logs, caches, snapshots, and historical production outputs
- Backups, temporary files, binary databases, spreadsheets, images, and other binary assets
- Hard-coded current balances, vendor names, document IDs, monthly results, or dated business claims
- Saved-search execution clients and record mutation or approval workflows
- Shell quoting, subprocess, terminal, dynamic-script generation, and local-file transport guidance
- Orchestration, delegation, audit-queue, cron, and profile-routing behavior
- Large copied schema catalogs whose correctness depends on one account and point in time

## Boundary decision

All retrieval remains behind `netsuite_execute`. The skill does not tell the agent how to authenticate, sign, connect, or call an endpoint. Current governed metadata and evidence supersede remembered or copied account facts. Any retrieval that cannot prove its population, grain, pagination, and control total must stop rather than fall back to a direct client.

## Resulting bundle

The target contains one concise `SKILL.md` and four text references. It contains no scripts, executables, binaries, credentials, generated outputs, account endpoints, or copied production snapshots.

## Live-state impact

No live QM skill, credential, database record, deployment layer, or organization scope was changed. The work is confined to the migration workspace.
