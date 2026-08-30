import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";

const mixedFiles = [
  { name: "first.png", mimetype: "image/png", sizeBytes: 2, blobId: "B1" },
  { name: "second.jpg", mimetype: "image/jpeg", sizeBytes: 2, blobId: "B2" },
  { name: "notes.pdf", mimetype: "application/pdf", sizeBytes: 2, blobId: "B3" },
];

async function deliver(destination: Record<string, unknown> = {}) {
  const delivery = {
    id: "D1",
    text: "two screenshots and the notes",
    destination: { type: "slack", target: "C1:100.200", ...destination },
    attachments: mixedFiles,
    createdAt: 1,
  };
  const queues = new Map<string, unknown[]>([["slack", [delivery]]]);
  const acknowledgements: string[] = [];
  const uploads: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  const mirrors: Array<{ ts?: string; text: string }> = [];
  const marks: Array<{ channel: string; ts: string }> = [];
  const core = {
    claimDeliveries: async (type: string) => queues.get(type)?.splice(0) ?? [],
    ackDelivery: async (id: string) => void acknowledgements.push(id),
  };
  const client = {
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
    messageApprovals: {} as never,
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
  return { acknowledgements, uploads, posts, mirrors, marks };
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

async function deliverApproval(
  acknowledge: () => Promise<{
    winner: boolean;
    current?: { channel: string; ts: string };
    displaced?: { channel: string; ts: string };
  }>,
  destination: Record<string, unknown> = {
    type: "slack",
    target: "C1:100.200",
    messageApproval: { id: "approval-1", version: 2 },
  },
) {
  const delivery = {
    id: "approval-delivery",
    text: "",
    destination,
    createdAt: Date.now(),
  };
  let claimed = false;
  const deleted: any[] = [];
  const posted: any[] = [];
  const client = {
    conversations: {
      open: async () => ({ channel: { id: "D-requester" } }),
      replies: async () => ({ messages: [] }),
      history: async () => ({ messages: [] }),
    },
    chat: {
      postMessage: async (body: any) => {
        posted.push(body);
        return { channel: body.channel, ts: "candidate" };
      },
      delete: async (body: any) => void deleted.push(body),
      update: async () => ({ ok: true }),
    },
  };
  const poller = createDeliveryPoller({
    core: {
      claimDeliveries: async (type: string) => {
        if (claimed || type !== destination.type) return [];
        claimed = true;
        return [delivery];
      },
      ackDelivery: async () => {},
    } as never,
    messageApprovals: {
      get: async () => ({
        id: "approval-1",
        title: "Draft",
        recipient: "alex@example.com",
        body: "Body",
        version: 2,
        state: "enqueued",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      acknowledgeSlackMessage: acknowledge,
    } as never,
    bridge: { inFlightRuns: new Set() } as never,
    mirror: {} as never,
    threads: {} as never,
    clientForIdentity: () => client,
  });
  await poller.pollDeliveries(client);
  return { deleted, posted };
}

test("a losing equal-version approval post is deleted and fallback markdown is disabled", async () => {
  const delivered = await deliverApproval(async () => ({ winner: false, current: { channel: "C1", ts: "winner" } }));
  assert.equal(delivered.posted[0].mrkdwn, false);
  assert.deepEqual(delivered.deleted, [{ channel: "C1", ts: "candidate" }]);
});

test("a newer approval post deletes the displaced older pointer", async () => {
  const delivered = await deliverApproval(async () => ({
    winner: true,
    current: { channel: "C1", ts: "candidate" },
    displaced: { channel: "C1", ts: "older" },
  }));
  assert.deepEqual(delivered.deleted, [{ channel: "C1", ts: "older" }]);
});

test("a principal approval delivery opens the requester DM and posts the full card only there", async () => {
  const delivered = await deliverApproval(
    async () => ({ winner: true, current: { channel: "D-requester", ts: "candidate" } }),
    {
      type: "principal",
      target: "U-requester",
      messageApproval: { id: "approval-1", version: 2 },
    },
  );
  assert.equal(delivered.posted.length, 1);
  assert.equal(delivered.posted[0].channel, "D-requester");
  assert.match(JSON.stringify(delivered.posted[0].blocks), /alex@example\.com|Body/);
});

test("an unresolved requester DM never falls back to posting the draft in a shared channel", async () => {
  let claimed = false;
  const acknowledged: string[] = [];
  const posted: unknown[] = [];
  const poller = createDeliveryPoller({
    core: {
      claimDeliveries: async (type: string) => {
        if (type !== "principal" || claimed) return [];
        claimed = true;
        return [
          {
            id: "private-approval",
            text: "",
            destination: {
              type: "principal",
              target: "U-requester",
              messageApproval: { id: "approval-1", version: 1 },
            },
            createdAt: Date.now(),
          },
        ];
      },
      ackDelivery: async (id: string) => void acknowledged.push(id),
    } as never,
    messageApprovals: {
      get: async () => ({
        id: "approval-1",
        title: "Private draft",
        recipient: "alex@example.com",
        body: "Private body",
        version: 1,
        state: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    } as never,
    bridge: { inFlightRuns: new Set() } as never,
    mirror: {} as never,
    threads: {} as never,
    clientForIdentity: () => ({}),
  });
  await poller.pollDeliveries({
    conversations: { open: async () => Promise.reject(new Error("requester DM unavailable")) },
    chat: { postMessage: async (body: unknown) => void posted.push(body) },
  });
  assert.deepEqual(posted, []);
  assert.deepEqual(acknowledged, []);
});

async function deliverCommandApproval(approval: Record<string, unknown>) {
  let claimed = false;
  const posted: any[] = [];
  const acknowledged: string[] = [];
  const client = {
    conversations: {
      replies: async () => ({ messages: [] }),
      history: async () => ({ messages: [] }),
    },
    chat: {
      postMessage: async (body: any) => {
        posted.push(body);
        return { channel: "C1", ts: "approval-card" };
      },
    },
  };
  const poller = createDeliveryPoller({
    core: {
      claimDeliveries: async () => {
        if (claimed) return [];
        claimed = true;
        return [
          {
            id: "command-delivery",
            text: "",
            destination: {
              type: "slack",
              target: "C1:100.200",
              commandApproval: { requestIds: ["command-1"] },
            },
            createdAt: Date.now(),
          },
        ];
      },
      getApproval: async () => ({ requestId: "command-1", command: "mail_send", reason: "approval", ...approval }),
      ackDelivery: async (id: string) => void acknowledged.push(id),
    } as never,
    messageApprovals: {} as never,
    bridge: { inFlightRuns: new Set() } as never,
    mirror: {} as never,
    threads: {} as never,
    clientForIdentity: () => client,
  });
  await poller.pollDeliveries(client);
  return { posted, acknowledged };
}

test("durable command approval delivery preserves the normal session and always actions", async () => {
  const { posted, acknowledged } = await deliverCommandApproval({});
  const actionIds = posted[0].blocks
    .filter((block: any) => block.type === "actions")
    .flatMap((block: any) => block.elements.map((element: any) => element.action_id));
  assert.deepEqual(actionIds, ["hilo_allow_once", "hilo_allow_session", "hilo_allow_always", "hilo_deny"]);
  assert.deepEqual(acknowledged, ["command-delivery"]);
});

test("durable quarantine delivery omits disallowed session and always actions", async () => {
  const { posted } = await deliverCommandApproval({
    kind: "input",
    grantModes: { session: false, always: false },
    blocksInput: true,
    summary: "Security review",
    summaryDetail: "Untrusted instruction",
  });
  const actionIds = posted[0].blocks
    .filter((block: any) => block.type === "actions")
    .flatMap((block: any) => block.elements.map((element: any) => element.action_id));
  assert.deepEqual(actionIds, ["hilo_allow_once", "hilo_deny"]);
});
