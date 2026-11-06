# Finance router source selection

## Target

`skills/finance-router/` remains a QM-native routing and source-planning skill. The migration uses the existing QM manifest, workflow transition, artifact publication, `finance_skill_run`, and `netsuite_execute` boundaries as the authoritative runtime contract.

## Sources compared

### QM baseline: `finance-router`

Selected as the implementation baseline because it already:

- runs the bundled resolver through `finance_skill_run`;
- treats routing output as evidence rather than finance data;
- requires explicit unresolved-item handling;
- publishes durable routing evidence;
- advances the controlled `KNOWLEDGE_READY` workflow step;
- defers source execution until the approved plan exposes the next stage.

This behavior was retained. The short body was expanded with domain taxonomy and source-plan requirements without changing the QM tool sequence.

### `sharechat-finance-routing`

Selected concepts:

- route by finance lens rather than by presentation layer;
- distinguish AP/P2P, AR/O2C, FP&A/MIS, treasury, consolidated finance, tax, and independent review;
- ask for a specifically named artifact and a complete population;
- state the purpose or hypothesis so an incorrectly requested artifact can be rejected;
- require query/population lineage, row counts, timestamps, control totals, and data-quality limitations;
- ask for the smallest artifact that answers the question;
- name inaccessible or human-gated evidence rather than inventing a substitute;
- keep source access read-only and avoid placing secrets in messages or artifacts.

Excluded:

- named Hermes/Finny profiles and agent-to-agent assignment rules;
- historical card IDs, proving pulls, row counts, monetary totals, latency claims, and named people;
- the claim that NetSuite is the only reachable source in every deployment;
- fixed assertions that SAP or tax portals are permanently unreachable;
- credential-path assumptions and workspace-specific card/Q&A mechanics;
- background-agent and weekly-digest behavior.

QM replacement: finance lenses become intent classes; availability is resolved from the current QM source plan and grants. Presentation layers, prior reports, memory, and synthetic data cannot replace authoritative evidence.

### `finny-domain-links`

Selected concepts:

- classify AP, AR, GL, P&L, balance sheet, receipt/payment, and reconciliation intent before execution;
- recognize useful cross-domain analogies without copying field, sign, status, account, or date rules blindly;
- require explicit subledger-to-GL tie-outs;
- keep tax withholding, GST holdback, and RCM concepts separate even when their workflows look similar.

Excluded:

- integration with the Hermes execution protocol;
- fixed NetSuite field/status/account claims in the router body;
- company-specific examples presented as universal accounting rules;
- instructions to infer an unknown domain rule from an opposite-domain analogy.

QM replacement: the router identifies populations and applicable domain skills. Source-specific field logic remains in the approved producer skill and pinned source plan.

### `netsuite-data-delegation`

Selected concepts:

- requester defines the complete population before a source read;
- raw evidence production, raw-evidence review, calculation, calculation review, and report review are distinct responsibilities;
- raw-evidence approval does not certify downstream derived figures;
- a source request must state artifact, population, purpose, query lineage, row count, as-of timestamp, controls, and limitations;
- portal-only facts cannot be asserted from book-side records;
- read-only source access and precise blockers are mandatory.

Excluded:

- the premise that credentials belong to one named executor profile;
- delegation syntax, card promotion, mentions, and named agents;
- direct SuiteQL, REST, OAuth, environment, repository-venv, or credential instructions;
- historical incident IDs, fixtures, production account identifiers, named employees, and mutable period mappings;
- detailed query-field rules, which belong in source-specific producer skills rather than the router;
- advice to run saved-search scripts directly.

QM replacement: the approved source plan selects the producer skill and review roles. NetSuite reads occur only after plan approval through the QM-owned `netsuite_execute` boundary. Credentials remain brokered and are never part of router output.

## Trigger migration

Hermes trigger lists and descriptions are not persisted by QM. Finance discovery language was incorporated into the QM description:

- AP, AR, collections, receipts, vendor payments
- GL, trial balance, P&L, balance sheet, MIS, EBITDA, close
- treasury, tax, GST, TDS, payroll
- reconciliation, audit, forecast, valuation

The description states that the skill creates a source plan and does not fetch or analyze data, reducing overlap with producer skills.

## Curated assets

The legacy schema catalog, universal rules, hard-coded defaults, memory integrations, direct-source helpers, production observations, and unsupported routes were removed. The remaining resolver is a neutral source-plan contract. The route registry and runbook cover only the implemented AR workflow, require explicit scope slots, validate referenced assets, and fail closed for unsupported intents.

## Result

The merged router is provider- and profile-neutral. It preserves QM's durable workflow and broker boundaries while exposing only the AR route implemented and tested by this pack.
