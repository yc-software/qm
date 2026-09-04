import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOversize,
  attachmentFromBytes,
  isTrustedSlackHost,
  downloadSlackFile,
  processInboundFiles,
  collectEarlierThreadFiles,
  uploadAttachments,
  uploadFailureNote,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TURN,
  type SlackFile,
} from "../src/slack/lib.ts";

function fakeFetch(opts: {
  ok?: boolean;
  status?: number;
  contentType?: string;
  contentLength?: number;
  bytes?: Uint8Array;
}): typeof fetch {
  return (async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: {
      get: (n: string) => {
        if (n.toLowerCase() === "content-type") return opts.contentType ?? "application/octet-stream";
        if (n.toLowerCase() === "content-length") return String(opts.contentLength ?? opts.bytes?.length ?? 0);
        return null;
      },
    },
    arrayBuffer: async () => (opts.bytes ?? new Uint8Array()).buffer,
  })) as unknown as typeof fetch;
}

const SLACK_URL = "https://files.slack.com/files-pri/T1-F1/x";

test("isOversize trips above the cap; attachmentFromBytes references the staged blob", () => {
  assert.equal(isOversize({ size: MAX_ATTACHMENT_BYTES + 1 }), true);
  assert.equal(isOversize({ size: 10 }), false);
  const a = attachmentFromBytes(
    { id: "F1", name: "n.txt", mimetype: "text/plain" },
    new Uint8Array(Buffer.from("hi")),
    "blob123",
  );
  assert.equal(a.name, "n.txt");
  assert.equal(a.sizeBytes, 2);
  assert.equal(a.blobId, "blob123");
  assert.equal(a.sourceId, "F1");
  assert.equal(a.author, undefined);
});

test("attachmentFromBytes carries the author when one is provided", () => {
  const a = attachmentFromBytes({ name: "n.txt" }, new Uint8Array(Buffer.from("hi")), "blob1", "eve");
  assert.equal(a.author, "eve");
});

test("isTrustedSlackHost only trusts slack.com hosts (token-leak guard)", () => {
  assert.equal(isTrustedSlackHost("https://files.slack.com/files-pri/abc"), true);
  assert.equal(isTrustedSlackHost("https://slack.com/x"), true);
  assert.equal(isTrustedSlackHost("https://evil.example.com/x"), false);
  assert.equal(isTrustedSlackHost("https://slack.com.evil.com/x"), false);
  assert.equal(isTrustedSlackHost("not a url"), false);
  assert.equal(isTrustedSlackHost("https://twin.example.com/files/F1", "twin.example.com"), true);
  assert.equal(isTrustedSlackHost("https://sub.twin.example.com/files/F1", "twin.example.com"), false);
  assert.equal(isTrustedSlackHost("https://evil.example.com/x", "twin.example.com"), false);
});

test("downloadSlackFile refuses a non-Slack host without fetching (SSRF/token-leak guard)", async () => {
  let fetched = false;
  const fetchImpl = (async () => {
    fetched = true;
    return {} as Response;
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => downloadSlackFile({ url_private: "https://evil.example.com/x" }, { token: "tok", fetchImpl }),
    /not Slack-hosted/,
  );
  assert.equal(fetched, false);
});

test("downloadSlackFile rejects an HTML sign-in page (files:read missing)", async () => {
  await assert.rejects(
    () =>
      downloadSlackFile(
        { url_private: SLACK_URL },
        { token: "t", fetchImpl: fakeFetch({ contentType: "text/html; charset=utf-8" }) },
      ),
    /HTML page/,
  );
});

test("downloadSlackFile rejects a non-2xx response", async () => {
  await assert.rejects(
    () =>
      downloadSlackFile({ url_private: SLACK_URL }, { token: "t", fetchImpl: fakeFetch({ ok: false, status: 403 }) }),
    /HTTP 403/,
  );
});

test("downloadSlackFile rejects by Content-Length before buffering", async () => {
  await assert.rejects(
    () =>
      downloadSlackFile(
        { url_private: SLACK_URL },
        { token: "t", fetchImpl: fakeFetch({ contentLength: MAX_ATTACHMENT_BYTES + 1 }) },
      ),
    /too large/,
  );
});

test("downloadSlackFile returns bytes on success", async () => {
  const bytes = new Uint8Array(Buffer.from("hello"));
  const out = await downloadSlackFile({ url_private: SLACK_URL }, { token: "t", fetchImpl: fakeFetch({ bytes }) });
  assert.equal(Buffer.from(out).toString("utf8"), "hello");
});

test("downloadSlackFile throws when the file has no url", async () => {
  await assert.rejects(() => downloadSlackFile({}, { token: "t", fetchImpl: fakeFetch({}) }), /no url_private/);
});

test("downloadSlackFile refuses external/remote-mode files", async () => {
  await assert.rejects(
    () => downloadSlackFile({ url_private: SLACK_URL, mode: "external" }, { token: "t", fetchImpl: fakeFetch({}) }),
    /external\/remote/,
  );
});

test("downloadSlackFile refuses a redirect instead of following it off-Slack", async () => {
  await assert.rejects(
    () =>
      downloadSlackFile({ url_private: SLACK_URL }, { token: "t", fetchImpl: fakeFetch({ ok: false, status: 302 }) }),
    /HTTP 302/,
  );
});

const fakeStage = (() => {
  let n = 0;
  return async (_bytes: Uint8Array) => ({ blobId: `blob${++n}` });
})();

test("processInboundFiles forwards good files (staging each) and notes the failed ones", async () => {
  const download = async (f: SlackFile) => {
    if (f.name === "bad.txt") throw new Error("boom");
    return new Uint8Array(Buffer.from("ok"));
  };
  const r = await processInboundFiles([{ name: "good.txt" }, { name: "bad.txt" }], download, fakeStage);
  assert.equal(r.attachments.length, 1);
  assert.equal(r.attachments[0]!.name, "good.txt");
  assert.ok(r.attachments[0]!.blobId);
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0]!, /couldn't read "bad\.txt"/);
});

test("processInboundFiles skips an oversize file by declared size WITHOUT downloading", async () => {
  let called = false;
  const r = await processInboundFiles(
    [{ name: "big.bin", size: MAX_ATTACHMENT_BYTES + 1 }],
    async () => {
      called = true;
      return new Uint8Array();
    },
    fakeStage,
  );
  assert.equal(called, false);
  assert.equal(r.attachments.length, 0);
  assert.match(r.issues[0]!, /too large/);
});

test("processInboundFiles caps the number of files per turn", async () => {
  const files = Array.from({ length: MAX_ATTACHMENTS_PER_TURN + 3 }, (_, i) => ({ name: `f${i}.txt` }));
  const r = await processInboundFiles(files, async () => new Uint8Array(Buffer.from("x")), fakeStage);
  assert.equal(r.attachments.length, MAX_ATTACHMENTS_PER_TURN);
  assert.ok(r.issues.some((i) => /too many files/.test(i)));
});

test("collectEarlierThreadFiles returns earlier files, recent-first, deduped and filtered", () => {
  const messages = [
    { ts: "1", user: "U1", files: [{ id: "Fa", name: "old.png" }] },
    { ts: "2", user: "BOT", bot_id: "B1", files: [{ id: "Fbot", name: "bot-made.png" }] },
    {
      ts: "3",
      user: "U2",
      files: [
        { id: "Fb", name: "graph.png" },
        { id: "Fdup", name: "dup.png" },
      ],
    },
    { ts: "4", user: "U1", files: [{ id: "Fdup", name: "dup.png" }] },
    { ts: "5", user: "U1", files: [{ id: "Ftrigger", name: "current.png" }] },
  ];
  const out = collectEarlierThreadFiles(messages, {
    triggerTs: "5",
    botUserId: "BOT",
    ownBotId: "B1",
    have: [{ id: "Ftrigger", name: "current.png" }],
    inThread: true,
  });
  assert.deepEqual(
    out.map((f) => f.id),
    ["Fdup", "Fb", "Fa"],
  );
});

test("collectEarlierThreadFiles stamps each file with its poster, preserving an explicit file.user", () => {
  const messages = [
    { ts: "1", user: "U1", files: [{ id: "Fa", name: "a.png" }] },
    { ts: "2", user: "U2", files: [{ id: "Fb", name: "b.png", user: "Uexplicit" }] },
  ];
  const out = collectEarlierThreadFiles(messages, {
    triggerTs: "9",
    botUserId: "BOT",
    ownBotId: "",
    have: [],
    inThread: true,
  });
  const userById = Object.fromEntries(out.map((f) => [f.id, f.user]));
  assert.equal(userById["Fa"], "U1");
  assert.equal(userById["Fb"], "Uexplicit");
});

test("processInboundFiles attributes each file via resolveAuthor(file.user)", async () => {
  const r = await processInboundFiles(
    [{ name: "x.png", user: "Utay" }],
    async () => new Uint8Array(Buffer.from("x")),
    fakeStage,
    (uid) => (uid === "Utay" ? "taylor" : undefined),
  );
  assert.equal(r.attachments.length, 1);
  assert.equal(r.attachments[0]!.author, "taylor");
});

test("collectEarlierThreadFiles returns nothing when only the trigger has files", () => {
  const messages = [{ ts: "9", user: "U1", files: [{ id: "Fx", name: "x.png" }] }];
  const out = collectEarlierThreadFiles(messages, {
    triggerTs: "9",
    botUserId: "BOT",
    ownBotId: "",
    have: [{ id: "Fx" }],
    inThread: true,
  });
  assert.equal(out.length, 0);
});

test("collectEarlierThreadFiles ignores channel backscroll for a top-level trigger", () => {
  const messages = [
    { ts: "1", user: "U1", files: [{ id: "Fold1", name: "screenshot1.png" }] },
    { ts: "2", user: "U2", files: [{ id: "Fold2", name: "logo.png" }] },
    { ts: "3", user: "U3", files: [{ id: "Ftrigger", name: "trigger.png" }] },
  ];
  const out = collectEarlierThreadFiles(messages, {
    triggerTs: "3",
    botUserId: "BOT",
    ownBotId: "",
    have: [],
    inThread: false,
  });
  assert.equal(out.length, 0);
});

test("uploadAttachments fetches each blob and calls files.uploadV2 with the right args", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    files: {
      uploadV2: async (a: Record<string, unknown>) => void calls.push(a),
      info: async () => ({ file: { shares: {} } }),
    },
  };
  const fetchBlob = async (id: string) => Buffer.from(`bytes-for-${id}`);
  await uploadAttachments(
    client,
    "C1",
    "123.45",
    [{ name: "x.txt", mimetype: "text/plain", sizeBytes: 2, blobId: "B1" }],
    fetchBlob,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.channel_id, "C1");
  assert.equal(calls[0]!.thread_ts, "123.45");
  assert.deepEqual(
    (calls[0]!.file_uploads as Array<{ filename: string; file: Buffer }>).map(({ filename, file }) => [
      filename,
      file.toString(),
    ]),
    [["x.txt", "bytes-for-B1"]],
  );
});

test("uploadAttachments batches mixed files with commentary into one Slack message", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    files: {
      uploadV2: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { files: [{ files: [{ id: "F1" }, { id: "F2" }, { id: "F3" }] }] };
      },
      info: async () => ({ file: { shares: { private: { C1: [{ ts: "123.456" }] } } } }),
    },
  };
  const attachments = [
    { name: "first.png", mimetype: "image/png", sizeBytes: 3, blobId: "B1" },
    { name: "second.jpg", mimetype: "image/jpeg", sizeBytes: 3, blobId: "B2" },
    { name: "notes.pdf", mimetype: "application/pdf", sizeBytes: 3, blobId: "B3" },
  ];

  await uploadAttachments(client, "C1", "123.45", attachments, async (id) => Buffer.from(id), undefined, {
    initialComment: "two screenshots and the notes",
  });

  assert.equal(calls.length, 1, "one composed post should make one Slack upload call");
  assert.equal(calls[0]!.channel_id, "C1");
  assert.equal(calls[0]!.thread_ts, "123.45");
  assert.equal(calls[0]!.initial_comment, "two screenshots and the notes");
  assert.deepEqual(
    (calls[0]!.file_uploads as Array<{ filename: string; file: Buffer }>).map(({ filename, file }) => [
      filename,
      file.toString(),
    ]),
    [
      ["first.png", "B1"],
      ["second.jpg", "B2"],
      ["notes.pdf", "B3"],
    ],
  );
  assert.equal(calls[0]!.filename, undefined);
  assert.equal(calls[0]!.file, undefined);
});

test("uploadAttachments falls back to durable file artifacts when the transient blob is gone", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    files: {
      uploadV2: async (a: Record<string, unknown>) => void calls.push(a),
      info: async () => ({ file: { shares: {} } }),
    },
  };
  const fetchBlob = async () => {
    throw new Error("blob download failed: HTTP 404");
  };
  const fetchArtifact = async (artifactId: string, viewerId: string) =>
    Buffer.from(`artifact:${artifactId}:${viewerId}`);
  await uploadAttachments(
    client,
    "C1",
    undefined,
    [{ name: "x.gif", mimetype: "image/gif", sizeBytes: 2, blobId: "B1", artifactId: "A1", artifactViewerId: "U1" }],
    fetchBlob,
    fetchArtifact,
  );
  assert.equal(calls.length, 1);
  const [uploaded] = calls[0]!.file_uploads as Array<{ filename: string; file: Buffer }>;
  assert.equal(uploaded!.file.toString(), "artifact:A1:U1");
});

test("uploadAttachments propagates an upload failure (so the caller can report it)", async () => {
  const client = {
    files: {
      uploadV2: async () => {
        throw new Error("missing_scope");
      },
      info: async () => ({ file: { shares: {} } }),
    },
  };
  const fetchBlob = async () => Buffer.from("data");
  await assert.rejects(
    () =>
      uploadAttachments(client, "C1", undefined, [{ name: "y", mimetype: "x", sizeBytes: 4, blobId: "B" }], fetchBlob),
    /missing_scope/,
  );
});

test("uploadAttachments skips a 0-byte blob (Slack rejects a zero-length upload)", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    files: {
      uploadV2: async (a: Record<string, unknown>) => void calls.push(a),
      info: async () => ({ file: { shares: {} } }),
    },
  };
  const fetchBlob = async () => Buffer.alloc(0);
  await uploadAttachments(
    client,
    "C1",
    undefined,
    [{ name: "empty.png", mimetype: "image/png", sizeBytes: 0, blobId: "B" }],
    fetchBlob,
  );
  assert.equal(calls.length, 0);
});

test("uploadAttachments waits for the file's channel share to commit before resolving", async () => {
  let infoCalls = 0;
  const client = {
    files: {
      uploadV2: async () => ({ files: [{ files: [{ id: "F1" }] }] }),
      info: async () => {
        infoCalls++;
        return infoCalls >= 3
          ? { file: { shares: { private: { C1: [{ ts: "123.456" }] } } } }
          : { file: { shares: {} } };
      },
    },
  };
  const fetchBlob = async () => Buffer.from("data");
  await uploadAttachments(
    client,
    "C1",
    undefined,
    [{ name: "f.txt", mimetype: "text/plain", sizeBytes: 4, blobId: "B" }],
    fetchBlob,
  );
  assert.ok(infoCalls >= 3, `expected polling until the share committed, got ${infoCalls}`);
});

test("uploadFailureNote blames files:write only for permission-class errors", () => {
  assert.match(uploadFailureNote({ data: { error: "missing_scope", needed: "files:write" } }), /files:write/);
  assert.match(uploadFailureNote({ data: { error: "not_allowed_token_type" } }), /files:write/);
  const note = uploadFailureNote({
    data: { error: "invalid_arguments" },
    message: "An API error occurred: invalid_arguments",
  });
  assert.doesNotMatch(note, /files:write/);
  assert.match(note, /invalid_arguments/);
});
