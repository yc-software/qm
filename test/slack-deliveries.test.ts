import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";

const mixedFiles = [
  { name: "first.png", mimetype: "image/png", sizeBytes: 2, blobId: "B1" },
  { name: "second.jpg", mimetype: "image/jpeg", sizeBytes: 2, blobId: "B2" },
  { name: "notes.pdf", mimetype: "application/pdf", sizeBytes: 2, blobId: "B3" },
];

async function deliver(
  destination: Record<string, unknown> = {},
  deliveryFields: Record<string, unknown> = {},
  analyticsNativeCard?: (delivery: unknown) => unknown,
  priorMessages: Record<string, unknown>[] = [],
) {
  const delivery = {
    id: "D1",
    text: "two screenshots and the notes",
    destination: { type: "slack", target: "C1:100.200", ...destination },
    attachments: mixedFiles,
    createdAt: 1,
    ...deliveryFields,
  };
  const queues = new Map<string, unknown[]>([["slack", [delivery]]]);
  const acknowledgements: string[] = [];
  const uploads: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  const mirrors: Array<{ ts?: string; text: string }> = [];
  const marks: Array<{ channel: string; ts: string }> = [];
  const reads: Record<string, unknown>[] = [];
  const core = {
    claimDeliveries: async (type: string) => queues.get(type)?.splice(0) ?? [],
    ackDelivery: async (id: string) => void acknowledgements.push(id),
    ...(analyticsNativeCard ? { analyticsNativeCard } : {}),
  };
  const client = {
    conversations: {
      replies: async (args: Record<string, unknown>) => {
        reads.push(args);
        return { messages: priorMessages };
      },
      history: async (args: Record<string, unknown>) => {
        reads.push(args);
        return { messages: priorMessages };
      },
    },
    files: {
      uploadV2: async (args: Record<string, unknown>) => {
        uploads.push(args);
        return { files: [{ files: mixedFiles.map((_, index) => ({ id: `F${index + 1}` })) }] };
      },
      info: async () => ({ file: { shares: { private: { C1: [{ ts: "101.300" }] } } } }),
    },
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        return { ts: "separate-message" };
      },
    },
  };
  const poller = createDeliveryPoller({
    core: core as never,
    bridge: {
      inFlightRuns: new Set<string>(),
      fetchBlobFromCore: async (id: string) => Buffer.from(id),
      fetchFileArtifactFromCore: async () => Buffer.from("artifact"),
    } as never,
    mirror: {
      mirrorSelfPost: (_channel: string, ts: string | undefined, text: string) => void mirrors.push({ ts, text }),
    } as never,
    threads: { mark: (channel: string, ts: string) => void marks.push({ channel, ts }) } as never,
    clientForIdentity: () => client,
  });

  await poller.pollDeliveries(client);
  return { acknowledgements, uploads, posts, mirrors, marks, reads };
}

test("Slack delivery composes text and mixed attachments into one message", async () => {
  const { acknowledgements, uploads, posts, mirrors, marks } = await deliver();

  assert.equal(uploads.length, 1);
  assert.equal(posts.length, 0, "commentary must not be posted separately");
  assert.equal(uploads[0]!.channel_id, "C1");
  assert.equal(uploads[0]!.thread_ts, "100.200");
  assert.equal(uploads[0]!.initial_comment, "two screenshots and the notes");
  assert.deepEqual(
    (uploads[0]!.file_uploads as Array<{ filename: string }>).map(({ filename }) => filename),
    ["first.png", "second.jpg", "notes.pdf"],
  );
  assert.deepEqual(acknowledgements, ["D1"]);
  assert.deepEqual(mirrors, [{ ts: "101.300", text: "two screenshots and the notes" }]);
  assert.deepEqual(marks, [{ channel: "C1", ts: "100.200" }]);
});

test("Slack delivery keeps the separate-comment fallback when upload comments cannot carry post options", async () => {
  const { uploads, posts } = await deliver({ unfurlLinks: false });

  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.text, "two screenshots and the notes");
  assert.equal(posts[0]!.unfurl_links, false);
  assert.equal(uploads.length, 1, "the fallback still batches the files themselves");
  assert.equal(uploads[0]!.initial_comment, undefined);
  assert.equal((uploads[0]!.file_uploads as unknown[]).length, 3);
});

const analyticsCard = {
  version: 1,
  renderer: "qm.analytics.card.v1",
  receiptId: "a".repeat(64),
  fallbackText: "Analytics result",
  heading: "Analytics · UC Online",
  question: "How is usage?",
  findings: [{ source: "posthog", topic: "usage", text: "<@here> & 12 active", confidence: "high" }],
  confidenceNotes: [],
  nextStep: "Review the evidence.",
  proposedActions: ["Draft an email."],
};

test("Slack delivery renders only a core-verified sealed analytics card at the current destination", async () => {
  const { posts, reads } = await deliver(
    {},
    { trustedAnalyticsCard: "sealed", idempotencyKey: "mcp-card:receipt", createdAt: 10_000 },
    () => analyticsCard,
  );

  assert.equal(reads.length, 1, "native cards read before posting after a restart or lost ack");
  assert.equal(reads[0]!.oldest, "5");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.channel, "C1");
  assert.equal(posts[0]!.thread_ts, "100.200");
  assert.equal(posts[0]!.text, "Analytics result");
  const blocks = JSON.stringify(posts[0]!.blocks);
  assert.match(blocks, /Analytics · UC Online/);
  assert.doesNotMatch(blocks, /<@here>/);
  assert.match(blocks, /&lt;@here&gt; &amp; 12 active/);
});

test("a persisted native-card idempotency key converges after Slack succeeded but core ack was lost", async () => {
  const prior = {
    ts: "already-posted",
    metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: "mcp-card:receipt" } },
  };
  const result = await deliver(
    {},
    { trustedAnalyticsCard: "sealed", idempotencyKey: "mcp-card:receipt", createdAt: 10_000 },
    () => analyticsCard,
    [prior],
  );

  assert.equal(result.reads.length, 1);
  assert.equal(result.posts.length, 0);
  assert.deepEqual(result.acknowledgements, ["D1"]);
});

test("caller-authored destination cards cannot render and unverifiable persisted cards remain unacknowledged", async () => {
  const forged = await deliver({ nativeCard: analyticsCard });
  assert.equal(forged.posts.length, 0);
  assert.equal(forged.uploads[0]!.initial_comment, "two screenshots and the notes");

  const priorError = console.error;
  console.error = () => {};
  try {
    const tampered = await deliver({}, { trustedAnalyticsCard: "tampered" }, () => null);
    assert.equal(tampered.posts.length, 0);
    assert.equal(tampered.acknowledgements.length, 0);

    const missingVerifier = await deliver({}, { trustedAnalyticsCard: "sealed" });
    assert.equal(missingVerifier.posts.length, 0);
    assert.equal(missingVerifier.acknowledgements.length, 0);
  } finally {
    console.error = priorError;
  }
});
