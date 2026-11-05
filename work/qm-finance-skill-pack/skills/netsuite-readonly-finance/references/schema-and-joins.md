# Schema, joins, and signs

## Metadata over memory

NetSuite field availability varies by account, role, record type, feature configuration, and query surface. Treat every fixed ID, custom field, status code, and table limitation as unverified until current governed metadata or a bounded probe confirms it.

Use the canonical SuiteQL field names exposed by metadata. Commonly useful patterns include:

- GL account number from the account record's account-number field;
- transaction currency and foreign totals from the transaction header;
- class, department, location, expense account, and custom segments from transaction lines when the header field is absent or unreliable;
- accounting amount and accounting book from transaction accounting lines;
- entity names through an explicit entity-table join rather than display functions inside grouped queries.

Do not carry account-specific custom-field names or enum values into a query merely because they worked in an earlier period. Verify both the storage type and business meaning.

## Grain map

| Source                      | Typical grain                                   | Primary use                                               |
| --------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| Transaction                 | One transaction header                          | Type, date, status, entity, currency, document totals     |
| Transaction line            | One source line                                 | Dimensions, items, line accounts, line linkage            |
| Transaction accounting line | One accounting impact line per book             | GL balances, debit/credit impact, accounting currency     |
| Account                     | One chart-of-accounts node                      | Account number, type, hierarchy, rate behavior            |
| Entity tables               | One customer, vendor, employee, or other entity | Names and entity attributes                               |
| Transaction links           | One predecessor-successor line relationship     | Order, invoice, receipt, payment, and application tracing |

Never join header totals to multiple accounting or source lines and then sum the repeated header amount. Aggregate each source at its native grain first or prove a one-to-one join.

## Sign controls

Do not impose one universal sign rule. Determine the sign convention for the selected source and reporting purpose:

- accounting-line amounts follow the accounting impact and may require presentation inversion by account type;
- document totals can use different signs by transaction type;
- unpaid amounts represent an open-item balance, not necessarily the document's accounting sign;
- credits, prepayments, deposits, applications, and refunds require separate populations;
- foreign amount multiplied by transaction exchange rate is not automatically the correct consolidated reporting amount.

Validate signs with a small set of source records and a control total before scaling the query.

## Relationship controls

For order-to-bill, bill-to-payment, invoice-to-receipt, and advance-application work:

1. Confirm the link table direction and link type from metadata.
2. Count distinct predecessor and successor documents separately from link rows.
3. Avoid selecting unstable or unsupported link fields.
4. Reconcile linked amounts to document totals and residual open amounts.
5. Treat an absent link as inconclusive until alternate application records and credits are checked.

## Parent and summary accounts

Chart-of-accounts parent nodes may be non-posting hierarchy nodes. A zero balance on a parent does not mean its descendants are zero. Resolve active posting descendants and aggregate the leaves for a roll-up. Preserve the hierarchy used and disclose any excluded descendants.
