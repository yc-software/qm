# Governed SuiteQL retrieval

## Preflight

Before preparing a retrieval:

1. State the finance question and whether it needs transactions, open items, or accounting lines.
2. Resolve every table, field, join, status, period, account, currency, subsidiary, and dimension from current governed metadata.
3. Select named columns only and minimize sensitive fields.
4. Define the expected grain and a uniqueness key before joining.
5. Define bounded pagination and stable ordering.
6. Identify the completeness check: count, control total, trial-balance tie-out, subledger tie-out, or another authoritative control.
7. Record every population exclusion and whether it changes the answer.

Do not execute when a field is guessed, a custom-field meaning is unverified, the join grain is ambiguous, or the query cannot prove complete pagination.

## Query discipline

- Use the dialect syntax supported by the governed executor; do not assume generic SQL pagination or functions.
- Use `TO_DATE` with an explicit format for date literals.
- Keep raw IDs in grouped queries and resolve display names separately when display functions alter grouping behavior.
- Avoid `SELECT *` for production retrieval. A one-row schema probe is acceptable only when governed metadata cannot resolve a table and the executor permits it.
- Do not use `DISTINCT` to hide duplicate joins. Correct the grain and join keys.
- Avoid aggregate `DISTINCT` unless the executor metadata explicitly confirms support.
- Keep dynamic account, entity, and period sets bounded. Split large sets through executor-supported batching rather than constructing an unbounded query.
- Treat numeric-looking IDs as strings at ingestion unless the evidence contract specifies another type.
- Parse returned dates according to the result metadata; do not assume ISO formatting.

## Accounting-line joins

Transaction headers, transaction lines, and accounting lines have different grains. When a result combines them:

- join accounting lines to their exact originating transaction line when a line dimension is needed;
- verify the accounting book rather than assuming a fixed book ID;
- filter posting transactions only when the question concerns GL impact;
- omit posting filters for non-posting populations such as purchase orders and sales orders;
- calculate a control total before and after adding each join;
- reject any unexplained row multiplication.

Class, department, location, and custom segments commonly live on transaction lines rather than transaction headers. Resolve their IDs through governed lookup metadata. A silent empty result after adding a dimension is evidence of a field or grain problem, not proof that the population is empty.

## Pagination and evidence

Use the executor's pagination contract. Preserve stable ordering using an immutable key or supported cursor. Do not improvise pagination from remembered client behavior.

For every retrieval retain:

- query or report identity and digest;
- execution timestamp;
- requested scope and filters;
- selected columns and grain;
- row and page counts;
- truncation or continuation status;
- evidence artifact identifier and result digest;
- population-level completeness assessment.

A zero-row result is not sufficient proof of absence when metadata, permissions, unsupported fields, or executor errors could produce the same observation. Resolve the ambiguity through the governed boundary before concluding that no records exist.
