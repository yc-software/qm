# API or message protocol: Short title

**Status: Proposed | Current | Historical**

**Owner:** [Owning module or role]

**Version:** [Version and compatibility policy]

**Related:** [Feature specification, ADR, implementation, and tests]

## Purpose and boundaries

[Describe callers, consumers, transport, trust boundary, and non-goals.]

## Authorization and audit

| Operation   | Principal   | Required scope/grant | Audit event | Denied behavior |
| ----------- | ----------- | -------------------- | ----------- | --------------- |
| [Operation] | [Principal] | [Requirement]        | [Event]     | [Response]      |

## Envelope or endpoint

```json
{
  "id": "example-id",
  "type": "example.type",
  "version": 1,
  "payload": {}
}
```

[Define fields, types, required/optional status, bounds, sensitive data, and examples.]

## State and delivery semantics

[Define ordering, idempotency key, deduplication window, concurrency control, retries,
timeouts, cancellation, retention, and acknowledgement.]

## Responses and errors

| Code or type | Meaning   | Retryable | Caller action |
| ------------ | --------- | --------- | ------------- |
| [Value]      | [Meaning] | Yes/No    | [Action]      |

## Compatibility and migration

[Define additive and breaking changes, negotiation, rollout order, old-reader behavior,
and data migration.]

## Verification

[Link contract tests, authorization-negative tests, idempotency/concurrency tests, and
live verification.]
