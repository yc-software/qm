import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";
import { SLACK_POST_SPLIT_LIMIT } from "../src/slack/lib.ts";
import { refreshPersonas, setDefaultBotIdentity, type SlackPersona } from "../src/slack/delivery.ts";
import { deliverKeychainCard, registerKeychainApprovalActions } from "../src/slack/keychain-approvals.ts";

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
  row: {
    createdAt?: number;
    history?: Record<string, unknown>[];
    loseAck?: boolean;
    approval?: unknown;
    updateError?: string;
    personas?: Record<string, SlackPersona>;
  } = {},
) {
  const delivery = {
    id: "D1",
    idempotencyKey: destination.commandApprovalId ? `command-approval:${destination.commandApprovalId}:0` : "D1",
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
  const updates: Record<string, unknown>[] = [];
  const failures: Array<[string, string]> = [];
  const marks: Array<{ channel: string; ts: string }> = [];
  const probes: Record<string, unknown>[] = [];
  const history = row.history ?? [];
  const conversationsOpened: Record<string, unknown>[] = [];
  const probe = async (args: Record<string, unknown>) => {
    probes.push(args);
    return {
      messages: history,
    };
  };
  const core = {
    channelPersonas: async () => new Map(Object.entries(row.personas ?? {})),
    holdDeliveryDispatch: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {})),
    getApproval: async () => row.approval ?? null,
    readBlob: async (id: string) => Buffer.from(id),
    claimDeliveries: async (type: string) => queues.get(type)?.splice(0) ?? [],
    failDelivery: async (id: string, code: string) => void failures.push([id, code]),
    ackDelivery: async (id: string) => {
      if (row.loseAck) throw new Error("acknowledgement lost");
      acknowledgements.push(id);
    },
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
      update: async (args: Record<string, unknown>) => {
        updates.push(args);
        if (row.updateError) throw Object.assign(new Error(row.updateError), { data: { error: row.updateError } });
        return { ok: true };
      },
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
  return { acknowledgements, uploads, posts, updates, failures, marks, probes, conversationsOpened };
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

test("principal delivery metadata renders an actionable deployment card", async () => {
  const request = { deploymentId: "00000000-0000-4000-8000-000000000001", requesterId: "bob@example.com" };
  const { posts } = await deliver(
    JSON.parse(JSON.stringify({ type: "principal", target: "U1", deploymentAccess: request })),
  );
  const blocks = posts[0]!.blocks as Array<{ type: string; elements?: Array<{ value: string }> }>;
  const actions = blocks.find((b) => b.type === "actions")!;
  assert.equal(actions.elements!.length, 2);
  assert.deepEqual(JSON.parse(actions.elements![0]!.value), request);
});
test("delegated approvals recover native buttons from durable records", async () => {
  const approval = {
    requestId: "A1",
    command: "publish",
    reason: "approval",
    grantModes: { session: false, always: false },
    request: { actor: { externalId: "U1" } },
  };
  const history: Record<string, unknown>[] = [];
  const destination = { type: "principal", target: "U1", commandApprovalId: "A1" };
  const first = await deliver(destination, undefined, undefined, "Approval needed", {
    approval,
    history,
    loseAck: true,
  });
  assert.equal(first.posts.length, 1);
  const rendered = JSON.stringify(first.posts[0]!.blocks);
  assert.match(rendered, /hilo_allow_once/);
  assert.doesNotMatch(rendered, /hilo_allow_always/);
  const second = await deliver(destination, undefined, undefined, "Approval needed", {
    approval,
    history,
    createdAt: Date.now() - 60_000,
  });
  assert.equal(second.posts.length, 0);
  assert.deepEqual(second.acknowledgements, ["D1"]);
});

test("an approval too long for Slack links its Deny-only card to the conversation on the web", async () => {
  const approval = {
    requestId: "A1",
    sessionId: "S 1",
    command: `example_send {"a":"${"&".repeat(15_000)}","to":"attacker@example.com"}`,
    reason: "this tool asks for approval before each call",
    request: { actor: { externalId: "U1" } },
  };
  const out = await deliver(
    { type: "principal", target: "U1", commandApprovalId: "A1" },
    undefined,
    "https://qm.example.com/",
    "Approval needed",
    { approval },
  );
  const rendered = JSON.stringify(out.posts[0]!.blocks);
  assert.match(rendered, /<https:\/\/qm\.example\.com\/s\/S%201\|this conversation in QM>/);
  assert.doesNotMatch(rendered, /hilo_allow_once|attacker@example\.com/);
});

for (const approval of [null, { requestId: "A1", command: "publish", request: { actor: { externalId: "U2" } } }]) {
  test(`delegated approvals discard ${approval ? "mismatched" : "expired"} records`, async () => {
    const out = await deliver(
      { type: "principal", target: "U1", commandApprovalId: "A1" },
      undefined,
      undefined,
      "Approval needed",
      { approval },
    );
    assert.equal(out.posts.length, 0);
    assert.deepEqual(out.acknowledgements, ["D1"]);
  });
}

test("a stale queued approval cannot render a newer request for the same command", async () => {
  const approval = { requestId: "A1", createdAt: 99, command: "publish", request: { actor: { externalId: "U1" } } };
  const out = await deliver(
    { type: "principal", target: "U1", commandApprovalId: "A1" },
    undefined,
    undefined,
    "approval",
    { approval },
  );
  assert.equal(out.posts.length, 0);
  assert.deepEqual(out.acknowledgements, ["D1"]);
});

test("a queued system approval notification is retired without opening a Slack DM", async () => {
  const actorId = "system:ambient:acme";
  const approval = { requestId: "A1", command: "publish", request: { actor: { externalId: actorId } } };
  const out = await deliver(
    { type: "principal", target: actorId, commandApprovalId: "A1" },
    undefined,
    undefined,
    "Approval needed",
    { approval },
  );
  assert.deepEqual(out.conversationsOpened, []);
  assert.deepEqual(out.posts, []);
  assert.deepEqual(out.uploads, []);
  assert.deepEqual(out.acknowledgements, ["D1"]);
});

for (const type of ["slack", "group", "principal"]) {
  test(`${type} file-only deliveries survive a restart after a lost acknowledgement`, async () => {
    const history: Record<string, unknown>[] = [];
    const first = await deliver({ type }, undefined, undefined, "", { history, loseAck: true });
    assert.equal(first.posts.length, 1);
    assert.equal(first.posts[0]!.text, "Files attached.");
    assert.equal(first.uploads.length, 1);
    assert.deepEqual(first.acknowledgements, []);
    const recovered = await deliver({ type }, undefined, undefined, "", {
      history,
      createdAt: Date.now() - 60_000,
    });
    assert.equal(recovered.posts.length, 0);
    assert.equal(recovered.uploads.length, 0);
    assert.deepEqual(recovered.acknowledgements, ["D1"]);
  });
}

test("an explicit edit rewrites the target message in place and posts nothing new", async () => {
  const { updates, posts, uploads, acknowledgements } = await deliver(
    { target: "C1", edit: { messageTs: "99.100" } },
    undefined,
    undefined,
    "corrected numbers",
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.channel, "C1");
  assert.equal(updates[0]!.ts, "99.100");
  assert.equal(updates[0]!.text, "corrected numbers");
  assert.deepEqual(posts, []);
  assert.deepEqual(uploads, []);
  assert.deepEqual(acknowledgements, ["D1"]);
});

test("an edit Slack refuses fails the delivery instead of posting the text as a new message", async () => {
  const { updates, posts, failures } = await deliver(
    { target: "C1", edit: { messageTs: "99.100" } },
    undefined,
    undefined,
    "corrected numbers",
    { updateError: "cant_update_message" },
  );
  assert.equal(updates.length, 1);
  assert.deepEqual(posts, []);
  assert.deepEqual(failures, [["D1", "cant_update_message"]]);
});

test("an edit of a message that no longer exists fails the delivery instead of retrying", async () => {
  const { posts, failures } = await deliver(
    { target: "C1", edit: { messageTs: "99.100" } },
    undefined,
    undefined,
    "corrected numbers",
    { updateError: "message_not_found" },
  );
  assert.deepEqual(posts, []);
  assert.deepEqual(failures, [["D1", "edit_target_not_found"]]);
});

test("a reply revised by the reply check carries a plain-text edit note footer", async () => {
  const { posts } = await deliver(
    { type: "slack", editNote: "Edited after a reply check: em dash" },
    undefined,
    undefined,
    "Clean reply",
  );
  const blocks = posts.at(-1)!.blocks as Array<{ type: string; elements?: unknown[] }>;
  assert.deepEqual(blocks.at(-1), {
    type: "context",
    elements: [{ type: "plain_text", text: "Edited after a reply check: em dash", emoji: false }],
  });
});

const ADA: SlackPersona = { username: "Ada", icon_emoji: ":art:" };
const BOLT: SlackPersona = { username: "Bolt", icon_emoji: ":art:" };
const identityOf = (args: Record<string, unknown>) => ({
  username: args.username,
  icon_emoji: args.icon_emoji,
});

test("a queued delivery into a bound channel posts every split part as its persona, while its files stay QM's", async () => {
  const { posts, uploads } = await deliver({}, undefined, undefined, "word ".repeat(2_000), {
    personas: { C1: ADA },
  });
  assert.ok(posts.length >= 2, "the delivery split into parts");
  for (const post of posts) assert.deepEqual(identityOf(post), ADA);
  assert.equal(uploads.length, 1);
  assert.deepEqual(identityOf(uploads[0]!), { username: undefined, icon_emoji: undefined });
});

test("a queued delivery into an unbound channel keeps the default identity after a bound one", async () => {
  await deliver({}, undefined, undefined, "first", { personas: { C1: BOLT } });
  const { posts } = await deliver({}, undefined, undefined, "second", { personas: { C2: ADA } });
  assert.deepEqual(identityOf(posts[0]!), { username: undefined, icon_emoji: undefined });
});

test("edits in a bound channel carry its persona, and edits elsewhere carry the default identity", async (t) => {
  setDefaultBotIdentity({ username: "QM", icon_emoji: ":robot_face:" });
  t.after(() => setDefaultBotIdentity(undefined));
  const explicit = await deliver({ target: "C1", edit: { messageTs: "99.100" } }, undefined, undefined, "fixed", {
    personas: { C1: ADA },
  });
  const finalized = await deliver({ editRef: "99.200" }, undefined, undefined, "final reply", {
    personas: { C1: ADA },
  });
  const updates = [...explicit.updates, ...finalized.updates];
  assert.equal(updates.length, 2);
  for (const update of updates) assert.deepEqual(identityOf(update), ADA);
  assert.deepEqual([...explicit.posts, ...finalized.posts], []);
  const unbound = await deliver({ target: "C1", edit: { messageTs: "99.300" } }, undefined, undefined, "fixed again", {
    personas: { C2: ADA },
  });
  assert.equal(unbound.updates.length, 1);
  assert.deepEqual(identityOf(unbound.updates[0]!), {
    username: "QM",
    icon_emoji: ":robot_face:",
  });
});

test("a keychain approval card delivered into a bound channel carries the persona", async () => {
  await refreshPersonas({ channelPersonas: async () => new Map([["C1", BOLT]]) });
  const posts: Record<string, unknown>[] = [];
  const client = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        return { ts: "5.5", channel: args.channel };
      },
    },
    conversations: { replies: async () => ({ messages: [] }), history: async () => ({ messages: [] }) },
  };
  const core = {
    keychainApprovals: {
      card: async () => ({
        ask: {
          id: "K1",
          status: "pending",
          requestedMode: "once",
          requesterScopeId: "channel:C1",
          createdAt: Date.now(),
        },
        service: "github",
        conversation: "#design",
      }),
    },
  };
  try {
    await deliverKeychainCard(
      core as never,
      client,
      { idempotencyKey: "ask:K1:notice", destination: { keychainAskId: "K1" } },
      "C1",
      "1.1",
    );
  } finally {
    await refreshPersonas({ channelPersonas: async () => new Map() });
  }
  assert.equal(posts.length, 1);
  assert.ok(Array.isArray(posts[0]!.blocks), "the card carries its buttons");
  assert.deepEqual(identityOf(posts[0]!), { ...BOLT });
});

test("a follower that does not hold the delivery lease reads no personas, and its card click still edits as the persona", async () => {
  await refreshPersonas({ channelPersonas: async () => new Map() });
  let personaReads = 0;
  const updates: Record<string, unknown>[] = [];
  const client = {
    chat: {
      update: async (args: Record<string, unknown>) => {
        updates.push(args);
        return { ok: true };
      },
    },
  };
  const core = {
    channelPersonas: async () => {
      personaReads++;
      return new Map([["C1", ADA]]);
    },
    holdDeliveryDispatch: async () => null,
    keychainApprovals: {
      decide: async () => ({
        ask: {
          id: "K1",
          status: "approved",
          requestedMode: "once",
          requesterScopeId: "channel:C1",
          createdAt: Date.now(),
        },
        service: "github",
        conversation: "#design",
      }),
    },
  };
  let click: (args: unknown) => Promise<void> = async () => {};
  registerKeychainApprovalActions(
    {
      action: (_pattern, handler) => {
        click = handler;
      },
    },
    { core: core as never, directory: { classifyActor: async () => ({ externalId: "ada@example.com" }) } as never },
  );
  const poller = createDeliveryPoller({
    core: core as never,
    flow: {} as never,
    threads: {} as never,
    clientForIdentity: () => client,
  });
  try {
    assert.equal(await poller.pollDeliveries(client), false, "a follower runs no drain");
    assert.equal(personaReads, 0, "a follower's lease retry reads no personas");
    await click({
      ack: async () => {},
      body: { user: { id: "U1" }, channel: { id: "C1" }, message: { ts: "5.5" } },
      action: { action_id: "keychain_allow_once", value: "K1" },
      client,
    });
  } finally {
    await refreshPersonas({ channelPersonas: async () => new Map() });
  }
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.ts, "5.5");
  assert.deepEqual(identityOf(updates[0]!), ADA);
});
