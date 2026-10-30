import "./support/auto-fake-sprites.ts";

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import { createSurfaceContextFulfiller } from "../src/slack/surface-context.ts";
import { encodeTs } from "../src/slack/reactions.ts";
import { textPng } from "./live-slack/text-png.ts";
import { visionImage } from "../src/core/attachments.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function freshApp() {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-threadfiles-")) }));
}

const actor = { externalId: "U1", displayName: "Ada" };

function mention(text: string, channel: string, root: string): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor] },
    deliveryTarget: `${channel}:${root}`,
    text,
    liveActor: true,
    async: true,
  };
}

async function reply(built: any, root: string): Promise<string> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const sub = await built.sessions.getByThread(`ch:${root}`);
    if (sub) {
      const entries = await built.sessions.getEntries(sub.id);
      const hit = entries.find((e: any) => e.type === "assistant" && typeof e.payload?.text === "string");
      if (hit) return hit.payload.text as string;
    }
    await sleep(50);
  }
  throw new Error("no assistant reply");
}

function fulfill(app: any, answer: (query: any) => unknown) {
  const queries: any[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      for (const r of await app.pendingContextRequests("slack")) {
        queries.push(r.query);
        await app.fulfillContextRequest(r.id, { result: answer(r.query) });
      }
      await sleep(20);
    }
  })();
  return {
    queries,
    stop: async () => {
      running = false;
      await loop;
    },
  };
}

test("read_file opens a file on another message by its ts and returns an image the model can see", async () => {
  const built = freshApp();
  built.runtime.start();
  const png = await built.blobTransfer.put(textPng("AB"));
  const fake = await built.blobTransfer.put(Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x03, 0xff, 0x00]));
  const surface = fulfill(built.app, (q) => {
    if (!q.file) return { messages: [] };
    const blobId = q.file.ts === "1700000000.000099" ? fake.blobId : png.blobId;
    return { messages: [], file: { blobId, name: "image.png", mimetype: "image/png", sizeBytes: 1 } };
  });
  try {
    await built.app.turn(mention("!read_file 1700000000.000042 2", "C20", "2000.1"));
    assert.match(await reply(built, "C20:2000.1"), /^file-image: image\.png image\/png \d+/);
    assert.deepEqual(surface.queries[0].file, { ts: "1700000000.000042", index: 2 });
    assert.equal(surface.queries[0].conversationTarget, "C20:2000.1");

    await built.app.turn(mention(`!read_file ${encodeTs("1700000000.000042")} image.png`, "C21", "2100.1"));
    assert.match(await reply(built, "C21:2100.1"), /^file-image:/);
    assert.deepEqual(surface.queries[1].file, { ts: "1700000000.000042", name: "image.png" });

    await built.app.turn(mention("!read_file 1700000000.000099", "C26", "2600.1"));
    assert.match(
      await reply(built, "C26:2600.1"),
      /^file-pointer:.*image\/png/,
      "bytes labelled image/png that aren't an image never go to the model as one",
    );

    await built.app.turn(mention(`!read_file ${png.blobId}`, "C22", "2200.1"));
    assert.match(await reply(built, "C22:2200.1"), /couldn't read file/, "a raw blob id is not a file reference");

    await built.app.turn(mention("!read_file image.png", "C23", "2300.1"));
    assert.match(await reply(built, "C23:2300.1"), /couldn't read file\] pass the `ts`.*\/v1\/surface-file/);
  } finally {
    await surface.stop();
    await built.runtime.stop();
  }
});

test("read_file passes a surface error through instead of claiming success", async () => {
  const built = freshApp();
  built.runtime.start();
  let n = 0;
  const loop = (async () => {
    while (n < 1) {
      for (const r of await built.app.pendingContextRequests("slack")) {
        n++;
        await built.app.fulfillContextRequest(r.id, {
          error: "that message carries 2 files — pass a name or a position",
        });
      }
      await sleep(20);
    }
  })();
  try {
    await built.app.turn(mention("!read_file 1700000000.000042", "C24", "2400.1"));
    assert.match(await reply(built, "C24:2400.1"), /couldn't read file\] that message carries 2 files/);
  } finally {
    n = 1;
    await loop;
    await built.runtime.stop();
  }
});

test("read_thread tells the model how to open files it sees", async () => {
  const built = freshApp();
  built.runtime.start();
  const surface = fulfill(built.app, () => ({
    messages: [{ ts: "2500.1", author: "Ada", text: ":thinking:", files: ["image.png", "image.png"] }],
  }));
  try {
    await built.app.turn(mention("!read_thread", "C25", "2500.1"));
    assert.match(await reply(built, "C25:2500.1"), /read 1 message\(s\) — .*read_file: ref = that message's ts/);
  } finally {
    await surface.stop();
    await built.runtime.stop();
  }
});

test("the slack tool returns an image block for an image file and forwards name", async () => {
  const calls: unknown[][] = [];
  const tc = {
    readFile: async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true, name: "image.png", sizeBytes: 10, image: { data: "AAAA", mimeType: "image/png" } };
    },
  };
  const ref = { current: tc } as unknown as ToolContextRef;
  const tool: any = createAgentTools(ref, { surfaceTools: true }).find((t) => t.name === "slack");
  const out = await tool.execute("c1", { action: "read_file", ref: "1700000000.000042", index: 2 });
  assert.deepEqual(calls, [["1700000000.000042", { index: 2 }]]);
  assert.deepEqual(out.content[1], { type: "image", data: "AAAA", mimeType: "image/png" });
});

describe("the Slack surface fetching a file from a message", () => {
  function fulfiller(files: unknown[]) {
    const fulfilled: Array<{ id: string; outcome: any }> = [];
    const fetched: string[] = [];
    const core = {
      fulfillContextRequest: async (id: string, outcome: unknown) => void fulfilled.push({ id, outcome }),
      stageBlob: async (bytes: Uint8Array) => ({ blobId: `blob-${bytes.length}` }),
    };
    const client = {
      conversations: {
        replies: async () => ({ messages: [{ ts: "100.000001", files }] }),
        history: async () => ({ messages: [] }),
      },
    };
    const f = createSurfaceContextFulfiller({
      core: core as never,
      directory: {} as never,
      serializer: {} as never,
      botToken: "xoxb-test",
      clientOptions: {},
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      fetched.push(url);
      return new Response(new Uint8Array(url.endsWith("/b") ? 7 : 3), { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const run = (file: Record<string, unknown>) =>
      f.fulfillSurfaceContext(client, {
        id: "r",
        source: "slack",
        createdAt: Date.now(),
        status: "pending",
        query: { count: 1, conversationTarget: "C1:100.000001", file: { ts: "100.000001", ...file } },
      } as never);
    return { run, fulfilled, fetched, restore: () => void (globalThis.fetch = realFetch) };
  }
  const twins = [
    { id: "F1", name: "image.png", mimetype: "image/png", url_private: "https://files.slack.com/a" },
    { id: "F2", name: "image.png", mimetype: "image/png", url_private: "https://files.slack.com/b" },
  ];

  it("picks a same-named file by position", async () => {
    const t = fulfiller(twins);
    try {
      await t.run({ index: 2 });
      assert.deepEqual(t.fetched, ["https://files.slack.com/b"]);
      assert.equal(t.fulfilled[0]!.outcome.result.file.blobId, "blob-7");
    } finally {
      t.restore();
    }
  });

  it("lists files with positions when it can't tell which one is meant", async () => {
    const t = fulfiller(twins);
    try {
      await t.run({});
      assert.match(
        t.fulfilled[0]!.outcome.error,
        /carries 2 files — pass a name or a position: 1\. image\.png, 2\. image\.png/,
      );
      await t.run({ index: 3 });
      assert.match(t.fulfilled[1]!.outcome.error, /pick one by position/);
      assert.deepEqual(t.fetched, []);
    } finally {
      t.restore();
    }
  });
});

test("a file on a reply in a neighbouring thread is found by asking Slack for the thread around it", async () => {
  const fulfilled: Array<{ outcome: any }> = [];
  const repliesAsked: string[] = [];
  const core = {
    fulfillContextRequest: async (_id: string, outcome: unknown) => void fulfilled.push({ outcome }),
    stageBlob: async () => ({ blobId: "blob-x" }),
  };
  const client = {
    conversations: {
      replies: async ({ ts }: { ts: string }) => {
        repliesAsked.push(ts);
        return ts === "200.000002"
          ? {
              messages: [
                { ts: "200.000001" },
                {
                  ts: "200.000002",
                  files: [
                    { id: "F9", name: "shot.png", mimetype: "image/png", url_private: "https://files.slack.com/n" },
                  ],
                },
              ],
            }
          : { messages: [{ ts }] };
      },
      history: async () => ({ messages: [] }),
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array(4))) as unknown as typeof fetch;
  try {
    await createSurfaceContextFulfiller({
      core: core as never,
      directory: {} as never,
      serializer: {} as never,
      botToken: "xoxb-test",
      clientOptions: {},
    }).fulfillSurfaceContext(client, {
      id: "r",
      source: "slack",
      createdAt: Date.now(),
      status: "pending",
      query: { count: 1, conversationTarget: "C1:100.000001", file: { ts: "200.000002" } },
    } as never);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(repliesAsked, ["100.000001", "200.000002"]);
  assert.equal(fulfilled[0]!.outcome.result.file.name, "shot.png");
});

test("only whole images in a supported format are shown to the model", async () => {
  const png = textPng("AB");
  assert.equal((await visionImage(png))?.mimeType, "image/png");
  assert.equal(await visionImage(png.subarray(0, 33)), undefined, "a truncated png");
  assert.equal(await visionImage(Buffer.from("<svg/>")), undefined);
  assert.equal(await visionImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), undefined);
});
