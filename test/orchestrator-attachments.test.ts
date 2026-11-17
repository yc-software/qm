import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../src/types.ts";
import { selectComputer, freshApp, spyProvisioning, internalActor, dm } from "./support/orchestrator-app.ts";
import { settle } from "./support/settle.ts";
import { TURN_FILES_DIR, turnFileId } from "../src/core/attachments.ts";
import { hashId } from "../src/util/crypto.ts";
import type { SecurityScreener } from "../src/security/security-screener.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

test("an attached file rides out once, and is not re-attached to every later turn", async () => {
  const { app } = freshApp();
  const t1 = await app.turn(dm("!writeattach one.txt one"));
  assert.equal(t1.status, "ok");
  assert.deepEqual(
    (t1.attachments ?? []).map((a) => a.name),
    ["one.txt"],
  );

  const t2 = await app.turn(dm("!writeattach two.txt two"));
  assert.equal(t2.status, "ok");
  assert.deepEqual(
    (t2.attachments ?? []).map((a) => a.name),
    ["two.txt"],
  );

  const t3 = await app.turn(dm("!attach one.txt"));
  assert.deepEqual(
    (t3.attachments ?? []).map((a) => a.name),
    ["one.txt"],
    "a still-present workspace file only rides out when it is attached again",
  );
});

test("attaching a path that is not there is an in-turn error, not a silent non-delivery", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("!attach nope.txt"));
  assert.equal(res.status, "ok");
  assert.equal(res.attachments, undefined, "nothing rides out");
  assert.match(res.reply ?? "", /not attached.*nope\.txt \(not found\)/);
});

test("an attached file is recorded in the attach tool result", async () => {
  const { app } = freshApp();
  const t1 = await app.turn(dm("!writeattach flag.png FLAG"));
  assert.deepEqual(
    (t1.attachments ?? []).map((a) => a.name),
    ["flag.png"],
  );

  const s1 = await app.getSession(t1.sessionId!);
  const result = s1!.items.findLast((e) => e.kind === "ToolResult" && e.tool === "attach");
  assert.ok(result, "expected an attach tool result item");
  const files = result!.body.files as Array<{ name: string; artifactId?: string }>;
  assert.equal(files[0]!.name, "flag.png");
  assert.equal(files[0]!.artifactId, t1.attachments![0]!.artifactId);
});

test("turn-private transfer files are removed after staging", async () => {
  const { app, sandbox, blobTransfer } = freshApp();
  const blob = await blobTransfer.put(Buffer.from("inbound"));
  let usedHandle: Parameters<typeof sandbox.listDir>[0] | undefined;
  let cleanupAttempts = 0;
  const removeDir = sandbox.removeDir.bind(sandbox);
  sandbox.removeDir = async (handle, path) => {
    if (/^\.agent-turn\/[a-f0-9]{24}\/[a-z0-9]+-[a-f0-9]{24}$/.test(path) && ++cleanupAttempts < 3) {
      throw new Error("transient cleanup failure");
    }
    return removeDir(handle, path);
  };
  const run = sandbox.run.bind(sandbox);
  sandbox.run = async (handle, command, opts) => {
    usedHandle = handle;
    return run(handle, command, opts);
  };

  const result = await app.turn(
    dm("!writeattach result.txt outbound", {
      attachments: [{ name: "input.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
    }),
  );

  assert.deepEqual(
    result.attachments?.map((a) => a.name),
    ["result.txt"],
  );
  assert.ok(usedHandle);
  await settle(async () => cleanupAttempts === 3);
  assert.equal(cleanupAttempts, 3);
  await settle(async () => (await sandbox.listDir(usedHandle!, TURN_FILES_DIR)).length === 0);
  assert.deepEqual(await sandbox.listDir(usedHandle, TURN_FILES_DIR), []);
});

test("an attachment's name stays out of the screen's source labels", async () => {
  const parts: Array<{ source: string; content: string }> = [];
  const screener: SecurityScreener = {
    provider: "spy",
    async classify({ payload }) {
      parts.push(...(JSON.parse(payload) as typeof parts));
      return { verdict: { decision: "auto" }, score: 0, threshold: 0.7 };
    },
  };
  const { app, blobTransfer } = freshApp({ securityPosture: "auto" }, screener);
  const blob = await blobTransfer.put(Buffer.from("quarterly numbers"));
  await app.turn(
    dm("summarize", {
      attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
    }),
  );
  assert.equal(parts.find((part) => part.content === "quarterly numbers")?.source, "attachment");
});

test("an attachment name over the file name limit reaches the inbox at 255 bytes and the agent is told", async () => {
  const { app, blobTransfer } = freshApp();
  const blob = await blobTransfer.put(Buffer.from("notes"));
  const file = {
    name: `${"a".repeat(300)}.txt`,
    mimetype: "text/plain",
    sizeBytes: blob.sizeBytes,
    blobId: blob.blobId,
  };
  const reply = (await app.turn(dm("read these", { attachments: [file, file] }))).reply ?? "";
  const note = "saved under a shortened name to fit the 255-byte file name limit (the shared name was 304 bytes).";
  assert.ok(reply.includes(`${"a".repeat(251)}.txt), ${note}`), reply);
  assert.ok(reply.includes(`${"a".repeat(249)}-2.txt), ${note}`), reply);
});

test("a later turn removes same-conversation and expired transfer files", async () => {
  const built = freshApp();
  const { app, sandbox } = built;
  await selectComputer(built, "U1", scopeId("personal", "U1"));
  const handle = await sandbox.provision(scopeId("personal", "U1"));
  const sessionDir = `${TURN_FILES_DIR}/${hashId(["dm:U1:t1"], 24)}`;
  await sandbox.writeFile(handle, `${sessionDir}/abandoned/inbox/stale.bin`, "stale");
  const expiredSessionDir = `${TURN_FILES_DIR}/${hashId(["dm:U1:other"], 24)}`;
  const expiredTurnDir = `${expiredSessionDir}/${turnFileId("abandoned-run", 1, Date.now() - 25 * 60 * 60_000)}`;
  await sandbox.writeFile(handle, `${expiredTurnDir}/inbox/stale.bin`, "stale");
  await sandbox.teardown(handle);

  const result = await app.turn(dm("!run true"));

  assert.equal(result.status, "ok");
  assert.deepEqual(await sandbox.listDir(handle, TURN_FILES_DIR), []);
});

test("concurrent conversations sharing one computer attach only their own file", async () => {
  const { app, sandbox } = freshApp();
  let firstWrote!: () => void;
  let releaseFirst!: () => void;
  const firstReady = new Promise<void>((resolve) => {
    firstWrote = resolve;
  });
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const run = sandbox.run.bind(sandbox);
  sandbox.run = async (handle, command, opts) => {
    const result = await run(handle, command, opts);
    if (command.includes("first-ready")) {
      firstWrote();
      await firstMayFinish;
    }
    return result;
  };

  const first = app.turn(
    dm("!writeattach first-ready-one.txt one", {
      conversation: { kind: "dm", threadRef: "dm:U1:first" },
    }),
  );
  await firstReady;
  const second = app.turn(
    dm("!writeattach two.txt two", {
      conversation: { kind: "dm", threadRef: "dm:U1:second" },
    }),
  );
  const r2 = await second.finally(releaseFirst);

  const r1 = await first;
  assert.deepEqual(
    r1.attachments?.map((a) => a.name),
    ["first-ready-one.txt"],
  );
  assert.deepEqual(
    r2.attachments?.map((a) => a.name),
    ["two.txt"],
  );
});

test("concurrent conversations sharing one computer read only their own inbound file", async () => {
  const { app, sandbox, blobTransfer } = freshApp();
  const alpha = await blobTransfer.put(Buffer.from("alpha"));
  const beta = await blobTransfer.put(Buffer.from("beta"));
  let firstMaterialized!: () => void;
  let releaseFirst!: () => void;
  const firstReady = new Promise<void>((resolve) => {
    firstMaterialized = resolve;
  });
  const firstMayRead = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const run = sandbox.run.bind(sandbox);
  sandbox.run = async (handle, command, opts) => {
    if (command.includes("first-read")) {
      firstMaterialized();
      await firstMayRead;
    }
    return run(handle, command, opts);
  };
  const readOwnInbox = "cat {INBOX}/report.txt";

  const first = app.turn(
    dm(`!run ${readOwnInbox}; echo first-read`, {
      conversation: { kind: "dm", threadRef: "dm:U1:first-inbound" },
      attachments: [{ name: "report.txt", mimetype: "text/plain", sizeBytes: alpha.sizeBytes, blobId: alpha.blobId }],
    }),
  );
  await firstReady;
  const second = app.turn(
    dm(`!run ${readOwnInbox}`, {
      conversation: { kind: "dm", threadRef: "dm:U1:second-inbound" },
      attachments: [{ name: "report.txt", mimetype: "text/plain", sizeBytes: beta.sizeBytes, blobId: beta.blobId }],
    }),
  );
  const r2 = await second.finally(releaseFirst);
  const r1 = await first;

  assert.match(r1.reply ?? "", /alpha/);
  assert.doesNotMatch(r1.reply ?? "", /beta/);
  assert.match(r2.reply ?? "", /beta/);
  assert.doesNotMatch(r2.reply ?? "", /alpha/);
});

test("a file posted in a GROUP conversation is granted read to the conversation scope", async () => {
  const { app, acl } = freshApp();
  const grp = {
    kind: "group" as const,
    threadRef: "grp:G9:files",
    channelRef: "G9",
    audience: [internalActor, { externalId: "U2" }],
  };
  await app.turn(
    dm("!run printf FLAG > flag.png", {
      surface: "slack",
      conversation: grp,
      deliveryTarget: "slack:G9:files",
      surfaceTools: true,
    }),
  );
  const t = await app.turn(
    dm("!postfiles flag.png here you go", {
      surface: "slack",
      conversation: grp,
      deliveryTarget: "slack:G9:files",
      surfaceTools: true,
    }),
  );
  assert.notEqual(t.status, "error");
  const handles = await acl.handlesFor(tenant, [scopeId("group", "G9")]);
  const fileHandle = handles.find((h) => h.handlePath === "shared/flag.png");
  assert.ok(fileHandle, "the posted file is granted to the conversation scope");
  assert.equal(fileHandle!.ownerScopeId, scopeId("personal", "U1"));
});

test("a file shared with the session is counted, not named, in the system prompt — without provisioning a sandbox", async () => {
  const built = freshApp();
  const { app, acl } = built;
  const boxes = spyProvisioning(built.sandbox);
  await built.files.put({
    id: "budget-file",
    ownerScopeId: scopeId("personal", "U2"),
    createdBy: "U2",
    name: "budget.csv",
    path: "budget.csv",
    mimetype: "text/csv",
    data: Buffer.from("amount\n10"),
    direction: "out",
  });
  await acl.grant(tenant, {
    ownerScopeId: scopeId("personal", "U2"),
    ref: "budget-file",
    granteeScopeId: scopeId("personal", "U1"),
    permission: "read",
    grantedBy: "U2",
  });
  const res = await app.turn(dm("!sysprompt"));
  assert.equal(res.status, "ok");
  const system = (res.reply ?? "").split("<environment>")[0]!;
  assert.match(system, /\n1 file is shared with you; /);
  assert.doesNotMatch(res.reply ?? "", /budget\.csv/);
  assert.equal(boxes.provisioned, 0, "listing shared files must not provision a box");
});
