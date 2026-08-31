# Private-turn observer

The optional private-turn observer receives digest-only metadata after a direct-message or private web-chat turn is durably accepted. The runtime persists the observation in the transactional outbox in the same database transaction as the accepted run or signal, and the observation event reference is also the outbox identity.

Configure `PRIVATE_TURN_OBSERVER_URL` and a purpose-specific `PRIVATE_TURN_OBSERVER_SIGNING_SECRET` together. Production startup rejects reuse of any configured credential-bearing secret for the observer. Delivery uses HTTPS, refuses redirects, aborts timed-out requests, and keeps retries for the same event single-flight.

Receivers must verify the `v0` HMAC over this canonical value, where the final two lines are the exact `x-idempotency-key` header and request body:

```text
POST
/path?query
<x-idempotency-key>
<body>
```

The receiver must also reject a body whose `eventRef` differs from `x-idempotency-key`, then use that value as its durable deduplication identity. HTTP `208` and `409` confirm a duplicate; `200`, `201`, `202`, and `204` confirm acceptance. Other outcomes remain retryable.

## Backlog and retention

Operators should monitor pending-row count, oldest pending age, attempt count, and observer latency before increasing traffic. Delivered rows remain in `transactional_outbox` so local event identities cannot be rebound. Automatic pruning is deliberately absent: a retention policy must preserve the receiver's deduplication horizon and operational audit needs before deleting delivered rows. Backlog alerting and a coordinated retention job are operational follow-ups rather than blockers for enabling a bounded initial observer workload.
