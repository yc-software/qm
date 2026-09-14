# Send timing

Web sends carry a fresh `traceId` for each submission attempt, separate from the idempotency key. Search web/core stdout for JSON records with `event: "send_timing"` and that ID. The browser also prints these records and reports them to its authenticated `/api/send-timing` endpoint. No message text, file names, credentials, principal IDs, or idempotency keys are included.

Stages:

- **browser:** `send_start`, `uploads_complete`, `request_start`, `response_received`, `queue_rendered`, or `error`.
- **web:** `received` (after body parsing), `forward_start`, `response_received`, `response_sent`, or `closed`/`error`.
- **core:** `received` (after HTTP authentication), `models_ready`, `identity_ready`, `validation_complete`, `approvals_checked`, `enqueue_start`, `enqueued`, `complete`, or `error`.

Use elapsed-time differences within a layer to find the wait. For example, a large core `enqueue_start` → `enqueued` gap implicates queue admission/storage; a fast core `complete` but slow web `response_received` implicates the return path. A fast browser `response_received` but late `queue_rendered` implicates UI scheduling. `queue_rendered` is emitted on an animation frame when the card is attached and has layout, not a guarantee that it is in the viewport.

`elapsedMs` uses the local monotonic clock; `at` is that process/browser's wall-clock timestamp. Do not subtract timestamps across machines without accounting for clock skew. Browser records are client-reported diagnostics, not authoritative server audit events. Authentication/body-read time before the first server marker is part of the unmeasured hop, not validation time.

Client reporting is best-effort, has a two-second deadline, and never blocks sending. The collector accepts at most 512 bytes per report and 120 reports per authenticated user per minute. Reports contain only validated UUIDs, enumerated stages/layers, and bounded numeric timings. A missing client marker can mean the tab closed, reporting failed, a card was hidden/unmounted, or rate limiting occurred; it does not prove a send failed. Retrying a send continues to use its existing idempotency key.

This instrumentation does not change queueing, retry, or timeout behavior, and does not record agent execution latency. Normal first sends have no queue card, so they end their send trace at response receipt. Approval replay routes are not instrumented by this change.
