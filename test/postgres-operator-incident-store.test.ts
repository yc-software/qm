import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresOperatorIncidentStore } from "../src/incidents/postgres-incident-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL to run the Postgres operator incident tests";

test(
  "pg store: incidents dedupe, paginate, and preserve notification receipts across instances",
  { skip },
  async () => {
    const writer = createPostgresOperatorIncidentStore(URL!);
    const reader = createPostgresOperatorIncidentStore(URL!);
    const key = `operator-incident-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const first = await writer.record({
        idempotencyKey: key,
        source: "run",
        severity: "error",
        status: "open",
        category: "test",
        code: "failed",
        intentional: false,
        discrepancy: false,
        occurredAt: Date.now(),
        scopeLabel: "org:test",
        backendMessage: "redacted failure",
        notificationRequested: true,
      });
      const duplicate = await reader.record({
        idempotencyKey: key,
        source: "run",
        severity: "error",
        status: "open",
        category: "test",
        code: "failed",
        intentional: false,
        discrepancy: false,
        occurredAt: first.occurredAt,
        scopeLabel: "org:test",
        backendMessage: "must not overwrite the first record",
        notificationRequested: true,
      });
      assert.equal(duplicate.id, first.id);
      assert.equal(duplicate.backendMessage, "redacted failure");
      assert.equal(
        (await reader.list({ scopeId: "org:test", limit: 10 })).some((row) => row.id === first.id),
        true,
      );

      const queuedAt = Date.now();
      await writer.markNotificationQueued(first.id, "delivery-test", queuedAt);
      assert.equal(
        (await reader.pendingReceipts()).some((row) => row.id === first.id),
        true,
      );
      const deliveredAt = queuedAt + 10;
      await reader.markNotificationDelivered(first.id, deliveredAt);
      assert.equal((await writer.get(first.id))?.notificationDeliveredAt, deliveredAt);
    } finally {
      await writer.close?.();
      await reader.close?.();
    }
  },
);
