import assert from "node:assert/strict";
import type { DeliveryStore } from "../src/delivery/delivery-store.ts";

export async function exerciseDeliveryStore(store: DeliveryStore): Promise<void> {
  const d = await store.enqueue({
    destination: { type: "slack", target: "C1" },
    text: "hello",
    idempotencyKey: "fire-1",
  });
  assert.equal(d.deliveredAt, null);

  const dup = await store.enqueue({
    destination: { type: "slack", target: "C1" },
    text: "hello again",
    idempotencyKey: "fire-1",
  });
  assert.equal(dup.id, d.id, "same idempotency key returns the original delivery");
  assert.equal(dup.text, "hello");

  const other = await store.enqueue({
    destination: { type: "principal", target: "U-alice", onBehalfOf: "U-carol" },
    text: "for alice",
    idempotencyKey: "fire-2",
  });
  await store.recordRecipientThread(other.id, "dm:D-alice", 111);
  const events = await store.listByRecipientThread("dm:D-alice");
  assert.deepEqual(
    events.map((e) => e.id),
    [other.id],
    "recipient-thread delivery events are queryable",
  );
  assert.equal(events[0]!.recipientThreadRef, "dm:D-alice");
  assert.equal(events[0]!.deliveredAt, 111);
  await store.recordRecipientThread(d.id, "dm:D-alice", 222);
  assert.deepEqual(
    (await store.listByRecipientThread("dm:D-alice")).map((e) => e.id),
    [other.id],
    "only principal deliveries become recipient events",
  );

  const sourced = await store.enqueue({
    destination: { type: "principal", target: "U-alice", onBehalfOf: "U-carol" },
    text: "from source session",
    idempotencyKey: "cron:c1:slot",
    provenance: {
      trigger: "cron",
      surface: "cron",
      fireKey: "cron:c1:slot",
      sourceScopeId: "personal:U-carol",
      sourceThreadRef: "agent:main:cron:c1",
      sourceSessionId: "source-session",
    },
  });
  assert.deepEqual(
    (await store.listBySourceSession("source-session", "agent:main:cron:c1")).map((e) => e.id),
    [sourced.id],
    "source-session delivery events are queryable",
  );
  assert.deepEqual(
    (await store.listBySourceSession("missing", "agent:main:cron:c1")).map((e) => e.id),
    [sourced.id],
    "legacy sourceThreadRef provenance is enough",
  );
  await store.ack(sourced.id, 333);

  const slackPending = await store.pending("slack");
  assert.deepEqual(
    slackPending.map((p) => p.id),
    [d.id],
    "pending filters by destination type",
  );
  assert.deepEqual(
    (await store.pending("principal")).map((p) => p.id),
    [],
  );

  assert.equal((await store.get(d.id))?.text, "hello");
  assert.equal(await store.get("nope"), null);

  await store.ack(d.id, 123, 88);
  assert.equal((await store.pending("slack")).length, 0, "acked deliveries leave the pending queue");
  const acked = await store.get(d.id);
  assert.equal(acked?.deliveredAt, 123);
  assert.equal(acked?.deliverLatencyMs, Math.max(0, 123 - acked!.createdAt), "deliver latency is delivered − created");
  assert.equal(acked?.slackApiMs, 88, "slack api round-trip recorded from the ack");

  await store.ack(d.id, 456);
  assert.equal((await store.get(d.id))?.deliveredAt, 123, "a second ack does not overwrite the first");

  const recovery = await store.enqueue({
    destination: { type: "slack", target: "C2:171.001", editRef: "171.002" },
    text: "recovered turn reply",
    attachments: [{ name: "report.csv", mimetype: "text/csv", sizeBytes: 42, blobId: "blob-1" }],
    idempotencyKey: "run:r-1",
  });
  assert.equal(recovery.destination.editRef, "171.002", "destination carries editRef through");
  assert.deepEqual(
    (await store.get(recovery.id))?.attachments,
    [{ name: "report.csv", mimetype: "text/csv", sizeBytes: 42, blobId: "blob-1" }],
    "attachments round-trip",
  );
  assert.equal(d.attachments, undefined, "attachment-less deliveries stay bare");
  await store.ackByKey("run:r-1", 200);
  assert.equal((await store.get(recovery.id))?.deliveredAt, 200);
  await store.ackByKey("run:r-1", 300);
  assert.equal((await store.get(recovery.id))?.deliveredAt, 200, "a second ackByKey does not overwrite the first");

  await store.ackByKey("run:r-2", 400);
  const suppressed = await store.enqueue({
    destination: { type: "slack", target: "C3" },
    text: "already delivered live",
    idempotencyKey: "run:r-2",
  });
  assert.notEqual(suppressed.deliveredAt, null, "live-acked recovery copy lands pre-acked");
  assert.equal((await store.pending("slack")).length, 0, "nothing new joins the pending queue");

  const late = await store.enqueue({
    destination: { type: "slack", target: "C4" },
    text: "checkpoint raced the enqueue",
    idempotencyKey: "run:r-3",
  });
  await store.setEditRefByKey("run:r-3", "171.003");
  assert.equal((await store.get(late.id))?.destination.editRef, "171.003", "late checkpoint patches the pending copy");
  assert.equal((await store.get(late.id))?.destination.target, "C4", "rest of the destination is untouched");
  await store.ack(late.id, 500);
  await store.setEditRefByKey("run:r-3", "999.999");
  assert.equal((await store.get(late.id))?.destination.editRef, "171.003", "delivered copies are not patched");

  const shadow = await store.enqueue({
    destination: { type: "principal", target: "U-shadow", onBehalfOf: "U-shadow" },
    text: "what the wake would have said",
    idempotencyKey: "cron:hb-1:1",
    provenance: {
      trigger: "cron",
      surface: "cron",
      fireKey: "cron:hb-1:1",
      sourceScopeId: "personal:U-shadow",
      sourceThreadRef: "agent:main:cron:hb-1",
    },
    shadow: true,
  });
  assert.equal(shadow.shadow, true, "the enqueued row carries the shadow flag");
  assert.equal((await store.pending("principal")).length, 0, "shadow rows never enter the drain queue");
  const shadowList = await store.listShadow();
  assert.deepEqual(
    shadowList.map((d) => d.id),
    [shadow.id],
    "listShadow surfaces the shadow row",
  );
  assert.equal(shadowList[0]!.text, "what the wake would have said");
  assert.equal(shadowList[0]!.provenance?.trigger, "cron", "shadow rows keep full provenance for admin");
  assert.equal((await store.get(shadow.id))?.shadow, true, "shadow flag round-trips through get()");

  await store.enqueue({
    destination: { type: "principal", target: "U-alice", onBehalfOf: "U-carol" },
    text: "another run on the same thread",
    idempotencyKey: "cron:c1:slot2",
    provenance: {
      trigger: "cron",
      surface: "cron",
      fireKey: "cron:c1:slot2",
      sourceScopeId: "personal:U-carol",
      sourceThreadRef: "agent:main:cron:c1",
      sourceSessionId: "off-page-session",
    },
  });
  await store.enqueue({
    destination: { type: "principal", target: "U-alice", onBehalfOf: "U-carol" },
    text: "legacy provenance without a session id",
    idempotencyKey: "cron:legacy:slot",
    provenance: {
      trigger: "cron",
      surface: "cron",
      fireKey: "cron:legacy:slot",
      sourceScopeId: "personal:U-carol",
      sourceThreadRef: "agent:main:cron:legacy",
    },
  });
  const sentCounts = await store.sentCountsBySourceSessions([
    { sessionId: "source-session", threadRef: "agent:main:cron:c1" },
    { sessionId: "shadow-session", threadRef: "agent:main:cron:hb-1" },
    { sessionId: "legacy-session", threadRef: "agent:main:cron:legacy" },
    { sessionId: "silent-session", threadRef: "agent:main:cron:c9" },
  ]);
  assert.equal(
    sentCounts.get("source-session"),
    1,
    "a row naming another session never counts for a page session sharing its thread",
  );
  assert.equal(sentCounts.get("shadow-session"), undefined, "shadow rows never count as sent");
  assert.equal(sentCounts.get("legacy-session"), 1, "rows without sourceSessionId fall back to threadRef");
  assert.equal(sentCounts.get("silent-session"), undefined, "sessions with no deliveries stay absent");
  assert.equal((await store.sentCountsBySourceSessions([])).size, 0);

  const runCounts = await store.sentRunCountsByCron(["c1", "hb-1", "legacy", "c9"]);
  assert.equal(runCounts.get("c1"), 2, "distinct delivering runs per cron (session id or legacy threadRef)");
  assert.equal(runCounts.get("legacy"), 1, "legacy provenance counts by threadRef");
  assert.equal(runCounts.get("hb-1"), undefined, "shadow rows never count as delivered runs");
  assert.equal(runCounts.get("c9"), undefined, "crons with no deliveries stay absent");
  assert.equal((await store.sentRunCountsByCron([])).size, 0);

  const contested = await store.enqueue({
    destination: { type: "group", target: "C-race" },
    text: "enqueued during the deploy overlap",
    idempotencyKey: "fire-race",
  });
  assert.deepEqual(
    (await store.claimPending("group", 60_000)).map((d) => d.id),
    [contested.id],
    "the first drainer claims the row",
  );
  assert.deepEqual(
    (await store.claimPending("group", 60_000)).map((d) => d.id),
    [],
    "a second drainer can't claim it again",
  );
  assert.deepEqual(
    (await store.pending("group")).map((d) => d.id),
    [contested.id],
    "pending() stays claim-agnostic",
  );
  await store.ack(contested.id, 600);
  assert.deepEqual(await store.claimPending("group", 60_000), [], "an acked row never re-surfaces");

  const abandoned = await store.enqueue({
    destination: { type: "group", target: "C-race" },
    text: "claimed, then the drainer died mid-post",
    idempotencyKey: "fire-race-2",
  });
  assert.equal((await store.claimPending("group", 50)).length, 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(
    (await store.claimPending("group", 60_000)).map((d) => d.id),
    [abandoned.id],
    "an expired claim re-surfaces (at-least-once)",
  );
  await store.ack(abandoned.id, 700);
}

export async function exerciseDeliveryExpiry(makeStore: (opts: { maxAgeMs: number }) => DeliveryStore): Promise<void> {
  const store = makeStore({ maxAgeMs: 300 });

  const fresh = await store.enqueue({
    destination: { type: "slack", target: "C-live" },
    text: "young enough to post",
    idempotencyKey: "ttl-fresh",
  });
  assert.deepEqual(
    (await store.claimPending("slack", 60_000)).map((d) => d.id),
    [fresh.id],
    "a row younger than the TTL is claimable",
  );
  await store.ack(fresh.id, Date.now());

  const doomed = await store.enqueue({
    destination: { type: "slack", target: "C-deleted" },
    text: "nobody will ever see this",
    idempotencyKey: "ttl-doomed",
  });
  const unpolled = await store.enqueue({
    destination: { type: "webhook", target: "https://gone.example" },
    text: "a type nothing ever drains",
    idempotencyKey: "ttl-unpolled",
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(
    (await store.pending("slack")).map((d) => d.id),
    [doomed.id],
    "pending() is a pure read — inspecting the queue never drops rows",
  );
  assert.equal((await store.get(doomed.id))?.expiredAt, undefined);
  assert.deepEqual(await store.claimPending("slack", 60_000), [], "an overaged row is never handed out");
  assert.deepEqual(await store.pending("slack"), [], "once swept, pending hides it");
  const expired = await store.get(doomed.id);
  assert.equal(expired?.deliveredAt, null, "an expired row was never delivered");
  assert.ok((expired?.expiredAt ?? 0) > 0, "the give-up is recorded durably on the row");
  assert.deepEqual(await store.claimPending("slack", 60_000), [], "expiry is terminal for that copy");
  assert.ok(
    ((await store.get(unpolled.id))?.expiredAt ?? 0) > 0,
    "draining any type expires overaged rows of every type",
  );

  const inFlight = await store.enqueue({
    destination: { type: "group", target: "C-slow" },
    text: "being posted right now",
    idempotencyKey: "ttl-in-flight",
  });
  assert.equal((await store.claimPending("group", 60_000)).length, 1);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(await store.claimPending("group", 60_000), [], "another drainer can't claim it");
  assert.equal((await store.get(inFlight.id))?.expiredAt, undefined, "a row under a live claim is never expired");
  await store.ack(inFlight.id, Date.now());

  const lateAck = await store.enqueue({
    destination: { type: "slack", target: "C-late" },
    text: "post raced the expiry",
    idempotencyKey: "ttl-late-ack",
  });
  await new Promise((r) => setTimeout(r, 400));
  await store.claimPending("slack", 60_000);
  assert.ok(((await store.get(lateAck.id))?.expiredAt ?? 0) > 0);
  await store.ack(lateAck.id, Date.now());
  const delivered = await store.get(lateAck.id);
  assert.notEqual(delivered?.deliveredAt, null, "a post that actually landed wins over the expiry");
  assert.equal(delivered?.expiredAt, undefined, "the expiry mark is cleared once delivered");
}

export async function exerciseDeliveryExpiryRevive(
  makeStore: (opts: { maxAgeMs: number }) => DeliveryStore,
): Promise<void> {
  const store = makeStore({ maxAgeMs: 300 });

  const consent = await store.enqueue({
    destination: { type: "slack", target: "C-gone" },
    text: "please approve this cron",
    idempotencyKey: "consent-notice:trigger-1",
    provenance: {
      trigger: "cron",
      surface: "cron",
      fireKey: "consent-notice:trigger-1",
      sourceScopeId: "personal:U-owner",
      sourceThreadRef: "agent:main:cron:t1",
      sourceSessionId: "consent-session",
    },
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(await store.claimPending("slack", 60_000), [], "the overaged notice is swept, not handed out");
  assert.ok(((await store.get(consent.id))?.expiredAt ?? 0) > 0);
  assert.equal(
    (await store.sentCountsBySourceSessions([{ sessionId: "consent-session", threadRef: "agent:main:cron:t1" }])).get(
      "consent-session",
    ),
    undefined,
    "dropped rows never count as sent",
  );

  const revived = await store.enqueue({
    destination: { type: "slack", target: "C-restored" },
    text: "please approve this cron (retry)",
    idempotencyKey: "consent-notice:trigger-1",
  });
  assert.equal(revived.id, consent.id, "the once-ever key still owns one row");
  assert.equal(revived.deliveredAt, null);
  assert.equal(revived.expiredAt, undefined, "a dropped once-ever notice re-enqueues instead of deadlocking");
  assert.equal(revived.destination.target, "C-restored", "the revived row carries the fresh destination");
  assert.deepEqual(
    (await store.claimPending("slack", 60_000)).map((d) => d.id),
    [revived.id],
    "the revived notice is claimable again",
  );
  await store.ack(revived.id, Date.now());

  const dedup = await store.enqueue({
    destination: { type: "slack", target: "C-x" },
    text: "same key after delivery",
    idempotencyKey: "consent-notice:trigger-1",
  });
  assert.notEqual(dedup.deliveredAt, null, "a delivered key stays a dedup hit — no re-send after success");

  const claimed = await store.enqueue({
    destination: { type: "group", target: "C-claimed" },
    text: "claimed, then aged out",
    idempotencyKey: "revive-after-claim",
  });
  assert.equal((await store.claimPending("group", 50)).length, 1);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(await store.claimPending("group", 60_000), [], "the lapsed-claim overaged row is swept");
  assert.ok(((await store.get(claimed.id))?.expiredAt ?? 0) > 0);
  const reclaimable = await store.enqueue({
    destination: { type: "group", target: "C-claimed" },
    text: "claimed, then aged out (retry)",
    idempotencyKey: "revive-after-claim",
  });
  assert.equal(reclaimable.expiredAt, undefined);
  assert.deepEqual(
    (await store.claimPending("group", 60_000)).map((d) => d.id),
    [reclaimable.id],
    "a revived row is immediately claimable — no stale claim survives the revive",
  );
  await store.ack(reclaimable.id, Date.now());

  const racers = await Promise.all(
    ["one", "two", "three"].map((text) =>
      store.enqueue({ destination: { type: "slack", target: "C-race" }, text, idempotencyKey: "race-1" }),
    ),
  );
  assert.equal(new Set(racers.map((r) => r.id)).size, 1, "racing enqueues on one key resolve to a single delivery");
  const raced = (await store.pending("slack")).filter((d) => d.idempotencyKey === "race-1");
  assert.equal(raced.length, 1, "exactly one copy joins the queue");
  await store.ack(raced[0]!.id, Date.now());
}
