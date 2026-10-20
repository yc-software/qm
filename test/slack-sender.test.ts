import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlackSender } from "../src/slack/sender.ts";
import { SLACK_POST_SPLIT_LIMIT } from "../src/slack/lib.ts";

const mixedFiles = [
  { name: "first.png", mimetype: "image/png", sizeBytes: 2, blobId: "B1" },
  { name: "second.jpg", mimetype: "image/jpeg", sizeBytes: 2, blobId: "B2" },
  { name: "notes.pdf", mimetype: "application/pdf", sizeBytes: 2, blobId: "B3" },
];

const uploadedNames = (uploads: Record<string, unknown>[]) =>
  uploads.flatMap((u) => (u.file_uploads as Array<{ filename: string }>).map(({ filename }) => filename));

async function send(
  destination: Record<string, unknown> = {},
  sourceThreadRef?: string,
  webUiPublicUrl?: string,
  text = "two screenshots and the notes",
  opts: { key?: string; createdAt?: number; history?: Record<string, unknown>[]; approval?: unknown } = {},
) {
  const post = {
    idempotencyKey:
      opts.key ?? (destination.commandApprovalId ? `command-approval:${destination.commandApprovalId}:0` : "D1"),
    text,
    ...(sourceThreadRef
      ? { provenance: { trigger: "cron", sourceThreadRef, sourceTitle: "Weekly <project> & check-in" } }
      : {}),
    destination: { type: "slack", target: "C1:100.200", ...destination },
    attachments: mixedFiles,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  };
  const uploads: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  const marks: Array<{ channel: string; ts: string }> = [];
  const probes: Record<string, unknown>[] = [];
  const history = opts.history ?? [];
  const conversationsOpened: Record<string, unknown>[] = [];
  const probe = async (args: Record<string, unknown>) => {
    probes.push(args);
    return {
      messages: history,
    };
  };
  const core = {
    getApproval: async () => opts.approval ?? null,
    readBlob: async (id: string) => Buffer.from(id),
  };
  const client = {
    conversations: {
      open: async (args: Record<string, unknown>) => {
        conversationsOpened.push(args);
        return { channel: { id: "C1" } };
      },
      replies: probe,
      history: probe,
    },
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
  const sender = createSlackSender({
    core: core as never,
    webUiPublicUrl,
    flow: {
      inFlightRuns: new Set<string>(),
      fetchBlobFromCore: async (id: string) => Buffer.from(id),
      fetchFileArtifactFromCore: async () => Buffer.from("artifact"),
    } as never,
    threads: { mark: (channel: string, ts: string) => void marks.push({ channel, ts }) } as never,
    clientForIdentity: () => client,
    defaultClient: client,
  });

  const receipt = await sender(post as never);
  return { receipt, uploads, posts, marks, probes, conversationsOpened };
}

for (const type of ["slack", "group", "principal"]) {
  test(`${type} cron posts include settings below the complete message and preserve attachments`, async () => {
    const text = "Scheduled update. ".repeat(250);
    const { posts, uploads } = await send(
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
  });
}

test("cron posts omit settings when the web UI is unavailable", async () => {
  const { posts, uploads } = await send({}, "cron:c1:fire:123");
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
  test(`${type} posts mark text for recovery and batch mixed attachments`, async () => {
    const { uploads, posts, marks } = await send({ type });

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
    assert.deepEqual(marks, type === "principal" ? [] : [{ channel: "C1", ts: "100.200" }]);
  });

  if (type !== "principal")
    test(`${type} run replies retried after posting reuse the message and files Slack already has`, async () => {
      const history: Record<string, unknown>[] = [];
      const first = await send({ type }, undefined, undefined, undefined, { key: "run:r1", history });
      assert.equal(first.posts.length, 1);
      assert.equal(first.uploads.length, 1);
      const { probes, posts, uploads } = await send({ type }, undefined, undefined, undefined, {
        key: "run:r1",
        createdAt: Date.now() - 60_000,
        history,
      });

      assert.equal(probes.length, 2, "the retry probes Slack for a status placeholder, then for the posted marker");
      assert.equal(posts.length, 0, "a marker hit means the text was already posted");
      assert.equal(uploads.length, 0, "files behind a posted marker are not replayed");
    });

  test(`${type} long replies with attachments take the splitting path instead of one upload comment`, async () => {
    const text = "a long reply ".repeat(Math.ceil(SLACK_POST_SPLIT_LIMIT / 12) + 20);
    const { posts, uploads } = await send({ type }, undefined, undefined, text);

    assert.ok(posts.length > 1, `expected the text split across posts, got ${posts.length}`);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]!.initial_comment, undefined);
    assert.deepEqual(uploadedNames(uploads), ["first.png", "second.jpg", "notes.pdf"]);
  });

  test(`${type} posts keep the separate-comment fallback when upload comments cannot carry post options`, async () => {
    const { uploads, posts } = await send({ type, unfurlLinks: false });

    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.text, "two screenshots and the notes");
    assert.equal(posts[0]!.unfurl_links, false);
    assert.equal(uploads.length, 1, "the fallback still batches the files themselves");
    assert.equal(uploads[0]!.initial_comment, undefined);
    assert.deepEqual(uploadedNames(uploads), ["first.png", "second.jpg", "notes.pdf"]);
  });
}

test("ordinary posts omit cron settings even with a configured web UI", async () => {
  const { posts } = await send({ unfurlLinks: false }, "dm:D1", "https://agent.example/web-ui");
  assert.equal(posts[0]!.blocks, undefined);
});

for (const type of ["slack", "group", "principal"]) {
  test(`${type} attachment-only cron posts use a valid footer without an empty message section`, async () => {
    const { posts, uploads } = await send({ type }, "cron:c1:fire:123", "https://agent.example", "");
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
  });
}

for (const type of ["group", "principal"]) {
  for (const sender of ["josh", "@josh", "<@U123> & <!channel>"]) {
    test(`${type} relay attribution is a plain-text footer for ${sender}`, async () => {
      const { posts } = await send({ type, relaySender: sender }, undefined, undefined, "Ship it");
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
    const { posts, uploads } = await send(
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
    const { posts } = await send({ type, relaySender: "josh" }, undefined, undefined, text);
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

test("a principal post with deployment-access details renders an actionable card", async () => {
  const request = { deploymentId: "00000000-0000-4000-8000-000000000001", requesterId: "bob@example.com" };
  const { posts } = await send(
    JSON.parse(JSON.stringify({ type: "principal", target: "U1", deploymentAccess: request })),
  );
  const blocks = posts[0]!.blocks as Array<{ type: string; elements?: Array<{ value: string }> }>;
  const actions = blocks.find((b) => b.type === "actions")!;
  assert.equal(actions.elements!.length, 2);
  assert.deepEqual(JSON.parse(actions.elements![0]!.value), request);
});
test("delegated approvals render native buttons from the durable approval record", async () => {
  const approval = {
    requestId: "A1",
    command: "publish",
    reason: "approval",
    grantModes: { session: false, always: false },
    request: { actor: { externalId: "U1" } },
  };
  const destination = { type: "principal", target: "U1", commandApprovalId: "A1" };
  const { posts } = await send(destination, undefined, undefined, "Approval needed", { approval });
  assert.equal(posts.length, 1);
  const rendered = JSON.stringify(posts[0]!.blocks);
  assert.match(rendered, /hilo_allow_once/);
  assert.doesNotMatch(rendered, /hilo_allow_always/);
});

for (const approval of [null, { requestId: "A1", command: "publish", request: { actor: { externalId: "U2" } } }]) {
  test(`delegated approvals discard ${approval ? "mismatched" : "expired"} records`, async () => {
    const out = await send(
      { type: "principal", target: "U1", commandApprovalId: "A1" },
      undefined,
      undefined,
      "Approval needed",
      { approval },
    );
    assert.equal(out.posts.length, 0);
    assert.equal(out.receipt, undefined);
  });
}

test("a stale approval post cannot render a newer request for the same command", async () => {
  const approval = { requestId: "A1", createdAt: 99, command: "publish", request: { actor: { externalId: "U1" } } };
  const out = await send(
    { type: "principal", target: "U1", commandApprovalId: "A1" },
    undefined,
    undefined,
    "approval",
    { approval },
  );
  assert.equal(out.posts.length, 0);
  assert.equal(out.receipt, undefined);
});

test("an approval notification for a system actor is dropped without opening a Slack DM", async () => {
  const actorId = "system:ambient:acme";
  const approval = { requestId: "A1", command: "publish", request: { actor: { externalId: actorId } } };
  const out = await send(
    { type: "principal", target: actorId, commandApprovalId: "A1" },
    undefined,
    undefined,
    "Approval needed",
    { approval },
  );
  assert.deepEqual(out.conversationsOpened, []);
  assert.deepEqual(out.posts, []);
  assert.deepEqual(out.uploads, []);
  assert.equal(out.receipt, undefined);
});

for (const type of ["slack", "group"]) {
  test(`${type} file-only run replies retried after posting do not repost the note or files`, async () => {
    const history: Record<string, unknown>[] = [];
    const first = await send({ type }, undefined, undefined, "", { key: "run:r1", history });
    assert.equal(first.posts.length, 1);
    assert.equal(first.posts[0]!.text, "Files attached.");
    assert.equal(first.uploads.length, 1);
    const retried = await send({ type }, undefined, undefined, "", {
      key: "run:r1",
      history,
      createdAt: Date.now() - 60_000,
    });
    assert.equal(retried.posts.length, 0);
    assert.equal(retried.uploads.length, 0);
  });
}

function bareSender(postMessage: (args: Record<string, unknown>) => Promise<unknown>, inFlight: string[] = []) {
  const client = {
    conversations: { replies: async () => ({ messages: [] }), history: async () => ({ messages: [] }) },
    chat: { postMessage },
  };
  return createSlackSender({
    core: {} as never,
    flow: { inFlightRuns: new Set(inFlight) } as never,
    threads: { mark: () => {} } as never,
    clientForIdentity: () => client,
    defaultClient: client,
  });
}

test("a run reply whose turn handler is still running is deferred without posting", async () => {
  const posts: unknown[] = [];
  const sender = bareSender(async (args) => (posts.push(args), { ts: "1.1" }), ["r1"]);
  const receipt = await sender({
    destination: { type: "slack", target: "C1:100.200" },
    text: "the answer",
    idempotencyKey: "run:r1",
  });
  assert.deepEqual(receipt, { deferred: true });
  assert.deepEqual(posts, []);
});

for (const [code, permanent] of [
  ["channel_not_found", true],
  ["ratelimited", undefined],
] as const) {
  test(`a Slack ${code} refusal rejects the post${permanent ? " as permanent" : ""}`, async () => {
    const sender = bareSender(async () => {
      throw Object.assign(new Error(code), { data: { error: code } });
    });
    await assert.rejects(
      sender({ destination: { type: "slack", target: "C1" }, text: "hello", idempotencyKey: "reach:1" }),
      (error: Error & { permanent?: boolean }) => error.message.includes(code) && error.permanent === permanent,
    );
  });
}
