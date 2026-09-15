import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";
import { SLACK_POST_SPLIT_LIMIT } from "../src/slack/lib.ts";

const mixedFiles = [
  { name: "first.png", mimetype: "image/png", sizeBytes: 2, blobId: "B1" },
  { name: "second.jpg", mimetype: "image/jpeg", sizeBytes: 2, blobId: "B2" },
  { name: "notes.pdf", mimetype: "application/pdf", sizeBytes: 2, blobId: "B3" },
];

const uploadedNames = (uploads: Record<string, unknown>[]) =>
  uploads.flatMap((u) => (u.file_uploads as Array<{ filename: string }>).map(({ filename }) => filename));

async function deliver(
  destination: Record<string, unknown> = {},
  sourceThreadRef?: string,
  webUiPublicUrl?: string,
  text = "two screenshots and the notes",
  row: { createdAt?: number; history?: Record<string, unknown>[]; loseAck?: boolean } = {},
) {
  const delivery = {
    id: "D1",
    text,
    ...(sourceThreadRef
      ? { provenance: { trigger: "cron", sourceThreadRef, sourceTitle: "Weekly <project> & check-in" } }
      : {}),
    destination: { type: "slack", target: "C1:100.200", ...destination },
    attachments: mixedFiles,
    createdAt: row.createdAt ?? Date.now(),
  };
  const queues = new Map<string, unknown[]>([[String(delivery.destination.type), [delivery]]]);
  const acknowledgements: string[] = [];
  const uploads: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  const marks: Array<{ channel: string; ts: string }> = [];
  const probes: Record<string, unknown>[] = [];
  const history = row.history ?? [];
  const probe = async (args: Record<string, unknown>) => {
    probes.push(args);
    return {
      messages: history,
    };
  };
  const core = {
    holdDeliveryDispatch: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {})),
    readBlob: async (id: string) => Buffer.from(id),
    claimDeliveries: async (type: string) => queues.get(type)?.splice(0) ?? [],
    ackDelivery: async (id: string) => {
      if (row.loseAck) throw new Error("acknowledgement lost");
      acknowledgements.push(id);
    },
  };
  const client = {
    conversations: { open: async () => ({ channel: { id: "C1" } }), replies: probe, history: probe },
    files: {
      uploadV2: async (args: Record<string, unknown>) => {
        uploads.push(args);
        history.push({ ts: "101.300", text: args.initial_comment, files: mixedFiles });
        return { files: [{ files: mixedFiles.map((_, index) => ({ id: `F${index + 1}` })) }] };
      },
      info: async () => ({ file: { shares: { private: { C1: [{ ts: "101.300" }] } } } }),
    },
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        history.push({ ...args, ts: "separate-message" });
        return { ts: "separate-message" };
      },
    },
  };
  const poller = createDeliveryPoller({
    core: core as never,
    webUiPublicUrl,
    flow: {
      inFlightRuns: new Set<string>(),
      fetchBlobFromCore: async (id: string) => Buffer.from(id),
      fetchFileArtifactFromCore: async () => Buffer.from("artifact"),
    } as never,
    threads: { mark: (channel: string, ts: string) => void marks.push({ channel, ts }) } as never,
    clientForIdentity: () => client,
  });

  await poller.pollDeliveries(client);
  return { acknowledgements, uploads, posts, marks, probes };
}

for (const type of ["slack", "group", "principal"]) {
  test(`${type} cron deliveries include settings below the complete message and preserve attachments`, async () => {
    const text = "Scheduled update. ".repeat(250);
    const { posts, uploads, acknowledgements } = await deliver(
      { type },
      "cron:morning report:fire:123",
      "https://agent.example/web-ui/",
      text,
    );
    assert.equal(posts.length, 1);
    const blocks = posts[0]!.blocks as Array<{ type: string; text?: { text: string }; elements?: unknown[] }>;
    assert.equal(
      blocks
        .filter((b) => b.type === "section")
        .map((b) => b.text!.text)
        .join(""),
      text,
    );
    assert.deepEqual(blocks.at(-1), {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Weekly &lt;project&gt; &amp; check-in · <https://agent.example/web-ui/crons/morning%20report|Settings>",
          verbatim: true,
        },
      ],
    });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]!.initial_comment, undefined);
    assert.deepEqual(
      uploadedNames(uploads),
      mixedFiles.map((f) => f.name),
    );
    assert.deepEqual(acknowledgements, ["D1"]);
  });
}

test("cron deliveries omit settings when the web UI is unavailable", async () => {
  const { posts, uploads } = await deliver({}, "cron:c1:fire:123");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.blocks, undefined);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]!.initial_comment, undefined);
  assert.deepEqual(
    uploadedNames(uploads),
    mixedFiles.map((f) => f.name),
  );
});

for (const type of ["slack", "group", "principal"]) {
  test(`${type} deliveries mark text for recovery and batch mixed attachments`, async () => {
    const { acknowledgements, uploads, posts, marks } = await deliver({ type });

    assert.equal(uploads.length, 1);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]!.metadata, {
      event_type: "qm_delivery",
      event_payload: { idempotency_key: "D1" },
    });
    assert.equal(uploads[0]!.channel_id, "C1");
    assert.equal(uploads[0]!.thread_ts, type === "principal" ? undefined : "100.200");
    assert.equal(uploads[0]!.initial_comment, undefined);
    assert.deepEqual(uploadedNames(uploads), ["first.png", "second.jpg", "notes.pdf"]);
    assert.deepEqual(acknowledgements, ["D1"]);
    assert.deepEqual(marks, type === "principal" ? [] : [{ channel: "C1", ts: "100.200" }]);
  });

  test(`${type} restart after a lost acknowledgement reuses the actual posted message and files`, async () => {
    const history: Record<string, unknown>[] = [];
    const first = await deliver({ type }, undefined, undefined, undefined, { history, loseAck: true });
    assert.equal(first.posts.length, 1);
    assert.equal(first.uploads.length, 1);
    assert.deepEqual(first.acknowledgements, []);
    const { probes, posts, uploads, acknowledgements } = await deliver({ type }, undefined, undefined, undefined, {
      createdAt: Date.now() - 60_000,
      history,
    });

    assert.equal(probes.length, 1, "the recovered row probes Slack for the delivered marker");
    assert.equal(posts.length, 0, "a marker hit means the text was already posted");
    assert.equal(uploads.length, 0, "files behind a delivered marker are not replayed");
    assert.deepEqual(acknowledgements, ["D1"]);
  });

  test(`${type} long replies with attachments take the splitting path instead of one upload comment`, async () => {
    const text = "a long reply ".repeat(Math.ceil(SLACK_POST_SPLIT_LIMIT / 12) + 20);
    const { posts, uploads } = await deliver({ type }, undefined, undefined, text);

    assert.ok(posts.length > 1, `expected the text split across posts, got ${posts.length}`);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]!.initial_comment, undefined);
    assert.deepEqual(uploadedNames(uploads), ["first.png", "second.jpg", "notes.pdf"]);
  });

  test(`${type} deliveries keep the separate-comment fallback when upload comments cannot carry post options`, async () => {
    const { uploads, posts } = await deliver({ type, unfurlLinks: false });

    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.text, "two screenshots and the notes");
    assert.equal(posts[0]!.unfurl_links, false);
    assert.equal(uploads.length, 1, "the fallback still batches the files themselves");
    assert.equal(uploads[0]!.initial_comment, undefined);
    assert.deepEqual(uploadedNames(uploads), ["first.png", "second.jpg", "notes.pdf"]);
  });
}

test("ordinary deliveries omit cron settings even with a configured web UI", async () => {
  const { posts } = await deliver({ unfurlLinks: false }, "dm:D1", "https://agent.example/web-ui");
  assert.equal(posts[0]!.blocks, undefined);
});

for (const type of ["slack", "group", "principal"]) {
  test(`${type} attachment-only cron deliveries use a valid footer without an empty message section`, async () => {
    const { posts, uploads, acknowledgements } = await deliver(
      { type },
      "cron:c1:fire:123",
      "https://agent.example",
      "",
    );
    assert.equal(posts.length, 1);
    assert.deepEqual(
      (posts[0]!.blocks as Array<{ type: string }>).map((block) => block.type),
      ["context"],
    );
    assert.equal(uploads.length, 1);
    assert.deepEqual(
      uploadedNames(uploads),
      mixedFiles.map((f) => f.name),
    );
    assert.deepEqual(acknowledgements, ["D1"]);
  });
}

for (const type of ["group", "principal"]) {
  for (const sender of ["josh", "@josh", "<@U123> & <!channel>"]) {
    test(`${type} relay attribution is a plain-text footer for ${sender}`, async () => {
      const { posts } = await deliver({ type, relaySender: sender }, undefined, undefined, "Ship it");
      assert.equal(posts.length, 1);
      assert.equal(posts[0]!.text, "Ship it");
      assert.deepEqual(posts[0]!.blocks, [
        { type: "section", text: { type: "mrkdwn", text: "Ship it" } },
        {
          type: "context",
          elements: [{ type: "plain_text", text: `Sent for @${sender.replace(/^@+/, "")}`, emoji: false }],
        },
      ]);
    });
  }

  test(`${type} attachment-only relay retains its attribution alongside cron settings`, async () => {
    const { posts, uploads } = await deliver(
      { type, relaySender: "josh" },
      "cron:c1:fire:123",
      "https://agent.example/web-ui",
      "",
    );
    assert.equal(posts.length, 1);
    const blocks = posts[0]!.blocks as Array<{ type: string; elements: Array<{ type: string; text: string }> }>;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.type, "context");
    assert.deepEqual(blocks[0]!.elements[0], { type: "plain_text", text: "Sent for @josh", emoji: false });
    assert.equal(blocks[0]!.elements[1]!.type, "mrkdwn");
    assert.ok(uploads.length);
  });
}

for (const type of ["group", "principal"]) {
  test(`${type} long relays split within Slack's block limit and keep the footer last`, async () => {
    const text = "x".repeat(145_000);
    const { posts } = await deliver({ type, relaySender: "josh" }, undefined, undefined, text);
    assert.equal(posts.length, 2);
    const blocks = posts.flatMap((post) => {
      const batch = post.blocks as Array<{ type: string; text?: { text: string }; elements?: unknown[] }>;
      assert.ok(batch.length <= 50);
      return batch;
    });
    assert.equal(
      blocks
        .filter((block) => block.type === "section")
        .map((block) => block.text!.text)
        .join(""),
      text,
    );
    assert.deepEqual(blocks.at(-1), {
      type: "context",
      elements: [{ type: "plain_text", text: "Sent for @josh", emoji: false }],
    });
    assert.equal(blocks.filter((block) => block.type === "context").length, 1);
  });
}
