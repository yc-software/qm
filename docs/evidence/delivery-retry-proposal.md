# Delivery retry proposal — August 30, 2026

Historical evidence only. This draft preserves a rejected design proposal; it is not a proposal to implement or merge this design. No implementation of the proposed counters, scheduled backoff, or parked state was recovered from the source exchange or its delivery-investigation sessions.

## Original proposal excerpt

The excerpt below is copied from the original discussion. The final sentence, which named a recipient of an operational report, is omitted.

> **The fix (owed):** repoint that config line at a live channel today (or the pile regrows ~10/day); then move retry state into the table — `attempts` + `next_attempt_at` columns, exponential backoff (1m → 5m → 30m → 6h), and a `parked_at` state after ~10 attempts or 7 days that the dispatcher skips but the admin UI shows. The existing 311: **park them** — replaying 310 month-old notices into a live channel would be deluge #2, and deleting them destroys the only record those denials were never seen.

## Objection recorded in the same exchange

> the attempts/next_attempt_at/parked_at feels a bit overengineered to me. I can't imagine a scenario where the whole system is down 6 hours but we still want to post a slack message when it comes back up. What's the 80/20 here? Build that.

## Revised direction

The subsequent response proposed expiring stale deliveries rather than adding attempt counters, a backoff schedule, or a parked state. This record establishes the proposed design and the objection, not a claim that the rejected design shipped.
