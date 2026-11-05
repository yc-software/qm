# Migrated population reconciliation

Use this reference when a control includes balances carried from a retired system or migration wave.

## Validate population membership

A documented type, custom field, date boundary, or numbering pattern is a hypothesis until current evidence proves it identifies the intended population without omission or over-capture.

Migration waves may use different discriminators. Probe each wave separately across header fields, line fields, memos, native application links, transaction types, and dates. Prefer a stable reference key where one exists. If a wave has no reliable marker, establish any date boundary empirically from known legacy and native documents and disclose the limitation.

Do not use a document-number prefix as the sole discriminator unless evidence proves it is unique to the migrated population.

Compare identifiers both ways when an expected list exists:

```text
missing = expected_ids - derived_ids
extra = derived_ids - expected_ids
```

Trace each missing and extra row. Equal totals can hide offsetting membership errors.

## Validate settlements

A payment-like link does not prove settlement. Inspect the applying document and its counterparty posting:

- cash, bank, or a genuine contra supports relief;
- another receivable or payable may be a reclass, transfer, or elimination rather than settlement.

Use the applying document's effective date for cutoff testing. Measure link-type and applying-document distributions before adding restrictive filters.

## Preserve currency dimensions

Reduce a balance using an amount on the same currency basis. If an application carries transaction currency while the control is base currency, use an available base amount or convert at the document's booked rate. Flag missing or zero rates; never substitute a hardcoded rate.

## Handle disagreement with workpapers

If source-backed extra documents are absent from a manual workpaper, report them for confirmation rather than deleting them to force agreement. Classify residuals by cause, such as tax basis, rounding, whole-document omission, migration wave, or settlement treatment.

Keep every population rule, exclusion, and uncertainty visible in the basis and disclosures. Current evidence, not a stored total, determines the result.
