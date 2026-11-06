# Migrated Invoice Detection and Settlement Validation

## Governed population contract

Do not hard-code a migration cutover, transaction type, account number, field ID, or invoice prefix in the skill pack. The accepted, versioned source-plan/config artifact must define for the requested entity, book, currency, and cutoff:

- every migrated-population leg;
- source transaction and accounting-line types;
- canonical migration reference and document-date fields;
- account scope;
- cutover boundary and its approval provenance;
- native-versus-migrated discriminator;
- supported settlement types and links;
- excluded reclassification or revaluation populations.

Treat each discriminator as a hypothesis until current source metadata and population evidence confirm it. If a leg lacks a dependable marker, a date boundary may be used only when the approved artifact documents the migration wave and current evidence validates both sides of the boundary. Block the combined report when the applicable artifact is missing, stale, or does not cover the requested scope.

## Canonical evidence

A published migrated row must preserve:

- immutable source transaction identity;
- canonical migrated invoice reference when the leg supplies one;
- original source document date;
- entity, account, book, currency, and signed base-accounting amount;
- migration leg and discriminator version;
- query and result digests;
- inclusion or exclusion reason.

Memo text, invoice prefixes, line references, and current open status are diagnostic unless the approved configuration explicitly elevates them with supporting evidence.

## Outstanding at cutoff

Clearing flags and application links are candidate evidence, not proof that an invoice was open or settled at the cutoff.

For each candidate movement:

1. require a supported movement type under the approved configuration;
2. require an effective date on or before the requested cutoff;
3. validate entity, invoice identity, currency, sign, and amount;
4. exclude reclassification and revaluation movements unless the approved algebra treats them as separately named control components;
5. prefer the source-provided base-accounting amount;
6. reconstruct a base amount from a booked rate only when approved accounting policy and evidence establish the applicable rate;
7. isolate FX differences rather than folding them into settlement;
8. apply the source-specific debit/credit algebra defined before results are observed.

If settlement identity, basis, sign, or conversion cannot be proven, record a field gap and block the affected combined total.

## Retrieval safety

Use bounded, non-overlapping slices when a population exceeds the source limit. Record every slice boundary, query digest, result digest, row count, and unique transaction identity. Prove the union has no gaps or overlaps before raw-evidence review can pass.
