# Finance populations and controls

## Choose the population that answers the question

| Question                                 | Population                                                                  | Primary measure                                   |
| ---------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- |
| What remains unpaid to vendors?          | Open vendor bills plus relevant credits, prepayments, and applications      | Residual open amount by document and currency     |
| What is the AP balance-sheet balance?    | Posting accounting lines on the complete AP account tree through the cutoff | Accounting balance by book and reporting currency |
| What remains collectible from customers? | Open customer invoices plus credits, receipts, deposits, and applications   | Residual open amount by invoice and currency      |
| What is the AR balance-sheet balance?    | Posting accounting lines on the complete AR account tree through the cutoff | Accounting balance by book and reporting currency |
| What moved in the P&L?                   | Posting accounting lines for the requested periods and account population   | Period activity, not cumulative balance           |
| What is the trial balance?               | Posting accounting lines over all posting leaf accounts                     | Closing debit/credit or signed balance by account |
| What is awaiting approval?               | Current transaction population plus the verified approval-workflow fields   | Documents at each approval state, not GL postings |

Do not describe an open-item report as a GL balance or a cumulative GL roll-up as current unpaid exposure.

## Cutoff discipline

For every as-of result:

- distinguish transaction date, posting period, due date, payment/application date, and system modification time;
- include documents outstanding at the cutoff, not merely documents currently open;
- exclude settlements after the cutoff from the historical open amount only when the source supports application timing;
- state whether late postings or reopened periods can change the result;
- use the correct accounting book and consolidated or standalone currency basis.

For period activity, define the posting-period range and independently reconcile transaction dates around period boundaries.

## AP and AR open items

Open-item retrieval must account for the transaction families that can change residual exposure:

- invoices or bills;
- credit memos or vendor credits;
- customer deposits or vendor prepayments;
- receipts or payments;
- applications, refunds, write-offs, and journals when they affect the subledger;
- migrated legacy balances when the governed source identifies them separately.

A positive residual on one document does not prove net exposure if unapplied credits or advances exist. Present gross documents, available credits or advances, and net exposure separately unless the application linkage is authoritative.

## Trial balance and GL

For GL-based results:

1. Resolve all posting leaf accounts beneath the requested account nodes.
2. Filter the requested accounting book and entity scope.
3. Include only posting impacts appropriate to the question.
4. Reconcile debit and credit presentation to the signed source amount.
5. Check that opening balance plus period movement equals closing balance when the evidence supports all three.
6. Tie subledger control accounts to the relevant open-item populations and explain timing, currency, journal, and migration differences.

## Currency

Keep these measures distinct:

- transaction currency and foreign amount;
- transaction exchange rate;
- base accounting currency amount;
- consolidated reporting currency amount and rate type.

Do not convert an already-accounted base amount again. For consolidated reporting, use the governed consolidation-rate source appropriate to balance-sheet, income-statement, and historical-rate accounts. Flag non-unity rates on same-currency transactions and other rate anomalies before totaling.

## Completeness checks

Use at least one independent control:

- document count and amount by transaction type;
- account control total;
- debit/credit balance;
- subledger-to-GL tie-out;
- source report tie-out;
- page and row-count reconciliation;
- beginning balance plus movement equals ending balance.

A material unexplained difference blocks publication. Preserve the difference and the compared source digests rather than forcing a match.
