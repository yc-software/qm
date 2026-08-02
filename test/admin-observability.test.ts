import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function start(overrides: Parameters<typeof testConfig>[0] = {}) {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-obs-")), ...overrides });
  const built = buildApp(config);
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    errors: built.errors,
    runs: built.runs,
    workspace: built.workspace,
    files: built.files,
    config: built.config,
    deliveries: built.deliveries,
    crons: built.crons,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE = { "x-admin-actor": "admin-alice@default-org" };
const get = (base: string, path: string, headers: Record<string, string> = ALICE) => fetch(base + path, { headers });
const getJson = async (base: string, path: string, headers: Record<string, string> = ALICE): Promise<any> =>
  (await get(base, path, headers)).json();

test("an org admin sees conversations, transcripts, files, and runs top-down", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hello there",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");

    const sess = await getJson(s.base, "/v1/admin/sessions?scope=org:default-org");
    assert.ok(sess.sessions.length >= 1, "at least one conversation");
    const conv = sess.sessions[0];
    assert.ok(conv.turns >= 1 && conv.messages >= 2, "turn + message counts populated");
    assert.equal(conv.firstMessage, "hello there", "the listing previews the conversation's opening line");
    assert.equal(conv.lastMessage, "hello there", "the listing previews the latest user message");

    const tx = await get(s.base, `/v1/admin/sessions/${encodeURIComponent(conv.id)}?scope=org:default-org`);
    assert.equal(tx.status, 200);
    const txd = await tx.json();
    const transcript = txd as { entries: { type: string }[] };
    assert.ok(
      transcript.entries.some((e) => e.type === "user"),
      "transcript includes the user message",
    );
    assert.ok(!transcript.entries.some((e) => e.type === "soul"), "resolved prompt context is not a transcript entry");

    await s.built.files.put({
      id: "todo-art-1",
      ownerScopeId: "org:default-org",
      createdBy: "U1",
      name: "todo.txt",
      path: "notes/todo.txt",
      mimetype: "text/plain",
      data: Buffer.from("buy milk"),
      direction: "out",
    });
    const files = await getJson(s.base, "/v1/admin/files?scope=org:default-org");
    const f = files.files.find((x: { name: string }) => x.name === "todo.txt");
    assert.ok(f, "the saved document is enumerated");
    assert.ok(f.openable, "it has downloadable content");
    const read = await getJson(s.base, `/v1/admin/files/read?id=${encodeURIComponent(f.id)}`);
    assert.equal(read.content, "buy milk");
    const download = await get(s.base, `/v1/admin/files/download?id=${encodeURIComponent(f.id)}`);
    assert.equal(download.status, 200);
    assert.equal(
      download.headers.get("content-type"),
      "text/plain; charset=utf-8",
      "browser-renderable types open in the browser instead of downloading",
    );
    assert.match(download.headers.get("content-disposition") ?? "", /^inline/);
    assert.match(download.headers.get("content-disposition") ?? "", /todo\.txt/);
    assert.equal(Buffer.from(await download.arrayBuffer()).toString("utf8"), "buy milk");

    await s.built.files.put({
      id: "html-art-1",
      ownerScopeId: "org:default-org",
      createdBy: "U1",
      name: "page.html",
      path: "notes/page.html",
      mimetype: "text/html",
      data: Buffer.from("<script>alert(1)</script>"),
      direction: "out",
    });
    const unsafe = await get(s.base, "/v1/admin/files/download?id=html-art-1");
    assert.equal(unsafe.status, 200);
    assert.equal(
      unsafe.headers.get("content-type"),
      "application/octet-stream",
      "html is never rendered on our origin",
    );
    assert.match(unsafe.headers.get("content-disposition") ?? "", /^attachment/);
    await unsafe.arrayBuffer();

    await s.built.files.put({
      id: "pic-art-1",
      ownerScopeId: "org:default-org",
      createdBy: "U1",
      name: "pic.png",
      path: "notes/pic.png",
      mimetype: "image/png",
      data: Buffer.from("png-bytes"),
      direction: "out",
    });
    const img = await get(s.base, "/v1/admin/files/download?id=pic-art-1");
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.match(img.headers.get("content-disposition") ?? "", /^inline/);
    assert.equal(
      img.headers.get("content-security-policy"),
      "sandbox",
      "inline bytes render with no script/document powers",
    );

    await s.built.files.put({
      id: "svg-art-1",
      ownerScopeId: "org:default-org",
      createdBy: "U1",
      name: "sneaky.svg",
      path: "notes/sneaky.svg",
      mimetype: "image/svg+xml",
      data: Buffer.from("<svg/>"),
      direction: "out",
    });
    const svg = await get(s.base, "/v1/admin/files/download?id=svg-art-1");
    assert.equal(svg.status, 200);
    assert.equal(svg.headers.get("content-type"), "application/octet-stream", "svg is never served inline");
    assert.match(svg.headers.get("content-disposition") ?? "", /^attachment/);

    const runs = await getJson(s.base, "/v1/admin/runs?scope=org:default-org");
    assert.ok(runs.runs.length >= 1, "the run is listed");
    assert.equal(runs.runs[0].sessionType, "dm");

    const actions = (await s.built.auditLog.events()).map((e) => e.action);
    for (const a of [
      "sessions.read",
      "session.read",
      "files.read",
      "file.read",
      "file.download",
      "file.view",
      "runs.read",
    ]) {
      assert.ok(actions.includes(a), `audited ${a}`);
    }
  } finally {
    await s.close();
  }
});

test("an org admin sees EXACTLY what we sent the model per turn (captured request sidecar)", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:llm" },
      text: "what's the weather",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");

    const sess = await getJson(s.base, "/v1/admin/sessions?scope=org:default-org");
    const conv = sess.sessions[0];
    const r = await get(s.base, `/v1/admin/sessions/${encodeURIComponent(conv.id)}/llm?scope=org:default-org`);
    assert.equal(r.status, 200);
    const d = (await r.json()) as {
      requests: {
        turnSeq: number | null;
        step: number;
        model: string;
        truncated: boolean;
        request: unknown;
        promptEnvelope?: unknown;
      }[];
    };
    assert.ok(d.requests.length >= 1, "at least one captured request");
    const meta = d.requests[0]!;
    assert.equal(meta.step, 0, "first agent step of the turn");
    assert.equal(typeof meta.turnSeq, "number", "correlated to the turn's user entry");
    assert.equal(meta.truncated, false);
    assert.equal(meta.request, null, "the bare list omits the prompt body — bodies load per turn on demand");
    assert.equal(meta.promptEnvelope, undefined, "…and the prompt envelope");
    const tr = await get(
      s.base,
      `/v1/admin/sessions/${encodeURIComponent(conv.id)}/llm?turnSeq=${meta.turnSeq}&scope=org:default-org`,
    );
    assert.equal(tr.status, 200);
    const td = (await tr.json()) as {
      requests: {
        turnSeq: number | null;
        promptEnvelope: { system?: string; messages?: { role: string; content: string }[] };
      }[];
    };
    assert.ok(td.requests.length >= 1, "the turn's requests");
    const req = td.requests[0]!;
    assert.equal(req.turnSeq, meta.turnSeq, "scoped to the requested turn");
    assert.ok(
      req.promptEnvelope.messages?.some((m) => m.content.includes("what's the weather")),
      "the snapshot carries exactly what we sent — the user message",
    );
    assert.ok(
      !req.promptEnvelope.messages?.some((m) => m.role === "soul"),
      "SOUL is carried in the system prompt, not as a provider message",
    );
    assert.ok(typeof req.promptEnvelope.system === "string", "and the system prompt we sent");
    assert.equal(
      (await get(s.base, `/v1/admin/sessions/${encodeURIComponent(conv.id)}/llm?turnSeq=nope&scope=org:default-org`))
        .status,
      400,
      "non-integer turnSeq rejected",
    );

    assert.equal(
      (
        await get(s.base, `/v1/admin/sessions/${encodeURIComponent(conv.id)}/llm?scope=org:default-org`, {
          "x-admin-actor": "nobody@default-org",
        })
      ).status,
      403,
    );
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "session.llm.read"),
      "audited session.llm.read",
    );
    assert.equal(
      (await get(s.base, `/v1/admin/sessions/${encodeURIComponent(conv.id)}/llm`)).status,
      400,
      "scope required",
    );
    assert.equal((await get(s.base, "/v1/admin/sessions/does-not-exist/llm?scope=org:default-org")).status, 404);
  } finally {
    await s.close();
  }
});

test("recipient delivery rows expose origin provenance and gated origin context", async () => {
  const s = start();
  try {
    const sourceScope = "channel:C-origin";
    const source = await s.built.sessions.getOrCreateByThread("cron:c1:42", "channel", sourceScope, "ops");
    const { lease } = await s.built.sessions.acquireLease(source.id);
    assert.ok(lease);
    const sourceUser = await s.built.sessions.append(lease, {
      type: "user",
      payload: { text: "post the digest" },
      scopeLabel: sourceScope,
    });
    const sourceResume = await s.built.sessions.append(lease, {
      type: "user",
      payload: { text: "(system note: resume)" },
      scopeLabel: sourceScope,
    });
    const sourceAssistant = await s.built.sessions.append(lease, {
      type: "assistant",
      payload: { text: "Digest posted." },
      scopeLabel: sourceScope,
    });
    await s.built.sessions.releaseLease(lease);
    await s.built.sessions.recordLlmRequest(source.id, {
      turnSeq: sourceUser.seq,
      step: 0,
      model: "mock",
      scopeLabel: sourceScope,
      promptEnvelope: { model: "mock", messages: [{ role: "user", content: "post the digest" }] },
      truncated: false,
    });
    await s.built.sessions.recordLlmRequest(source.id, {
      turnSeq: sourceResume.seq,
      step: 1,
      model: "mock",
      scopeLabel: sourceScope,
      promptEnvelope: { model: "mock", messages: [{ role: "user", content: "(system note: resume)" }] },
      truncated: false,
    });

    const delivery = await s.built.deliveries.enqueue({
      destination: { type: "principal", target: "U-erica", audienceScopeId: "personal:U-erica", onBehalfOf: "U-alice" },
      text: "The script ran clean and posted the digest DM.\n\n[no-update]",
      attachments: [
        {
          name: "digest.gif",
          mimetype: "image/gif",
          sizeBytes: 99,
          blobId: "blob-digest",
          artifactId: "art-digest",
          artifactViewerId: "U-alice",
        },
      ],
      idempotencyKey: "cron:c1:42",
      provenance: {
        trigger: "cron",
        surface: "cron",
        fireKey: "cron:c1:42",
        sourceScopeId: sourceScope,
        sourceThreadRef: "cron:c1:42",
        sourceSessionId: source.id,
        sourceUserSeq: sourceUser.seq,
        sourceAssistantEntrySeq: sourceAssistant.seq,
      },
    });
    await s.built.app.recordPrincipalDelivery(delivery.id, "dm:D-erica");
    const recipient = await s.built.sessions.getByThread("dm:D-erica");
    assert.ok(recipient);

    const orgRead = await get(s.base, `/v1/admin/sessions/${encodeURIComponent(recipient!.id)}?scope=org:default-org`);
    assert.equal(orgRead.status, 200);
    const orgBody = (await orgRead.json()) as any;
    assert.equal(
      orgBody.entries.some((e: any) => e.type === "assistant"),
      false,
      "recipient transcript is not copied assistant history",
    );
    assert.equal(orgBody.deliveryEvents.length, 1, "recipient transcript renders delivered output inline");
    const event = orgBody.deliveryEvents[0];
    assert.equal(event.type, "principal_delivery");
    assert.equal(event.text, "The script ran clean and posted the digest DM.\n\n[no-update]");
    assert.equal(event.provenance.fireKey, "cron:c1:42");
    assert.equal(event.provenance.sourceSessionId, source.id);
    assert.equal(event.sourceSession.id, source.id);
    assert.equal(event.sourceSession.scopeId, sourceScope);
    assert.equal(event.llmRequests.length, 2);
    assert.equal(event.llmRequests[0].turnSeq, sourceUser.seq);
    assert.deepEqual(event.llmRequests[0].promptEnvelope.messages, [{ role: "user", content: "post the digest" }]);
    assert.equal(event.llmRequests[1].turnSeq, sourceResume.seq);

    const scopedRead = await get(
      s.base,
      `/v1/admin/sessions/${encodeURIComponent(recipient!.id)}?scope=${encodeURIComponent("personal:U-erica")}`,
    );
    assert.equal(scopedRead.status, 200);
    const scopedBody = (await scopedRead.json()) as any;
    assert.equal(
      scopedBody.entries.some((e: any) => e.type === "assistant"),
      false,
    );
    assert.equal(scopedBody.deliveryEvents.length, 1);
    assert.equal(scopedBody.deliveryEvents[0].provenance.sourceSessionId, source.id);
    assert.equal(scopedBody.deliveryEvents[0].sourceSession, undefined);
    assert.equal(scopedBody.deliveryEvents[0].llmRequests, undefined);

    const sourceRead = await get(s.base, `/v1/admin/sessions/${encodeURIComponent(source.id)}?scope=org:default-org`);
    assert.equal(sourceRead.status, 200);
    const sourceBody = (await sourceRead.json()) as any;
    assert.equal(sourceBody.deliveryEvents.length, 1, "source transcript renders the outbound Slack delivery");
    assert.equal(sourceBody.deliveryEvents[0].type, "outbound_delivery");
    assert.equal(sourceBody.deliveryEvents[0].text, "The script ran clean and posted the digest DM.\n\n[no-update]");
    assert.equal(sourceBody.deliveryEvents[0].recipientThreadRef, "dm:D-erica");
    assert.deepEqual(sourceBody.deliveryEvents[0].attachments, [
      {
        name: "digest.gif",
        mimetype: "image/gif",
        sizeBytes: 99,
        blobId: "blob-digest",
        artifactId: "art-digest",
        artifactViewerId: "U-alice",
      },
    ]);
  } finally {
    await s.close();
  }
});

test("recipient delivery rows expose non-cron wake provenance without cron idempotency", async () => {
  const s = start();
  try {
    const sourceScope = "channel:C-webhook";
    const fireKey = "webhook:wh_123:delivery_456";
    const source = await s.built.sessions.getOrCreateByThread(fireKey, "channel", sourceScope, "alerts");
    const { lease } = await s.built.sessions.acquireLease(source.id);
    assert.ok(lease);
    const sourceUser = await s.built.sessions.append(lease, {
      type: "user",
      payload: { text: "triage the webhook" },
      scopeLabel: sourceScope,
    });
    const sourceAssistant = await s.built.sessions.append(lease, {
      type: "assistant",
      payload: { text: "Webhook triaged." },
      scopeLabel: sourceScope,
    });
    await s.built.sessions.releaseLease(lease);
    await s.built.sessions.recordLlmRequest(source.id, {
      turnSeq: sourceUser.seq,
      step: 0,
      model: "mock",
      scopeLabel: sourceScope,
      promptEnvelope: { model: "mock", messages: [{ role: "user", content: "triage the webhook" }] },
      truncated: false,
    });

    const sourceRead = await get(
      s.base,
      `/v1/admin/sessions/${encodeURIComponent(source.id)}?scope=${encodeURIComponent(sourceScope)}`,
    );
    assert.equal(sourceRead.status, 200);
    const sourceBody = (await sourceRead.json()) as any;
    assert.equal(sourceBody.origin.kind, "background_wake");
    assert.equal(sourceBody.origin.label, "Webhook wake");
    assert.equal(sourceBody.origin.trigger, "webhook");
    assert.equal(sourceBody.origin.fireKey, fireKey);

    const delivery = await s.built.deliveries.enqueue({
      destination: { type: "principal", target: "U-erica", audienceScopeId: "personal:U-erica", onBehalfOf: "U-alice" },
      text: "Webhook alert triaged.",
      idempotencyKey: "delivery:non-cron-key",
      provenance: {
        trigger: "webhook",
        surface: "webhook",
        fireKey,
        sourceScopeId: sourceScope,
        sourceThreadRef: fireKey,
        sourceSessionId: source.id,
        sourceUserSeq: sourceUser.seq,
        sourceAssistantEntrySeq: sourceAssistant.seq,
      },
    });
    await s.built.app.recordPrincipalDelivery(delivery.id, "dm:D-webhook-erica");
    const recipient = await s.built.sessions.getByThread("dm:D-webhook-erica");
    assert.ok(recipient);

    const orgRead = await get(s.base, `/v1/admin/sessions/${encodeURIComponent(recipient!.id)}?scope=org:default-org`);
    assert.equal(orgRead.status, 200);
    const orgBody = (await orgRead.json()) as any;
    assert.equal(orgBody.deliveryEvents.length, 1);
    const event = orgBody.deliveryEvents[0];
    assert.equal(event.idempotencyKey, "delivery:non-cron-key");
    assert.equal(event.origin.kind, "background_wake");
    assert.equal(event.origin.label, "Webhook wake");
    assert.equal(event.origin.trigger, "webhook");
    assert.equal(event.origin.fireKey, fireKey);
    assert.equal(event.origin.sourceId, "wh_123");
    assert.equal(event.origin.fireSlot, "delivery_456");
    assert.equal(event.sourceSession.id, source.id);
    assert.equal(event.llmRequests.length, 1);

    const scopedRead = await get(
      s.base,
      `/v1/admin/sessions/${encodeURIComponent(recipient!.id)}?scope=${encodeURIComponent("personal:U-erica")}`,
    );
    assert.equal(scopedRead.status, 200);
    const scopedBody = (await scopedRead.json()) as any;
    assert.equal(scopedBody.deliveryEvents.length, 1);
    assert.equal(scopedBody.deliveryEvents[0].origin.label, "Webhook wake");
    assert.equal(scopedBody.deliveryEvents[0].sourceSession, undefined);
    assert.equal(scopedBody.deliveryEvents[0].llmRequests, undefined);

    const mismatched = await s.built.deliveries.enqueue({
      destination: {
        type: "principal",
        target: "U-mismatch",
        audienceScopeId: "personal:U-mismatch",
        onBehalfOf: "U-alice",
      },
      text: "Mismatched legacy provenance.",
      idempotencyKey: "delivery:mismatched-key",
      provenance: {
        trigger: "cron",
        surface: "cron",
        fireKey,
        sourceScopeId: sourceScope,
        sourceThreadRef: fireKey,
        sourceSessionId: source.id,
      },
    });
    await s.built.app.recordPrincipalDelivery(mismatched.id, "dm:D-mismatch");
    const mismatchRecipient = await s.built.sessions.getByThread("dm:D-mismatch");
    assert.ok(mismatchRecipient);
    const mismatchRead = await get(
      s.base,
      `/v1/admin/sessions/${encodeURIComponent(mismatchRecipient!.id)}?scope=org:default-org`,
    );
    assert.equal(mismatchRead.status, 200);
    const mismatchBody = (await mismatchRead.json()) as any;
    assert.equal(mismatchBody.deliveryEvents.length, 1);
    assert.equal(mismatchBody.deliveryEvents[0].origin.kind, "background_wake");
    assert.equal(mismatchBody.deliveryEvents[0].origin.trigger, "webhook");
    assert.equal(mismatchBody.deliveryEvents[0].origin.cronId, undefined);
  } finally {
    await s.close();
  }
});

test("a live conversation post's provenance joins its source session but renders no wake-origin card", async () => {
  const s = start();
  try {
    const sourceScope = "channel:C-live";
    const source = await s.built.sessions.getOrCreateByThread("slack/C-live:171.5", "channel", sourceScope, "live");
    const delivery = await s.built.deliveries.enqueue({
      destination: { type: "principal", target: "U-erica", audienceScopeId: "personal:U-erica", onBehalfOf: "U-alice" },
      text: "forwarding this from the channel",
      idempotencyKey: "post:live:1",
      provenance: {
        trigger: "conversation",
        surface: "slack",
        fireKey: "post:live:1",
        sourceScopeId: sourceScope,
        sourceThreadRef: "slack/C-live:171.5",
        sourceSessionId: source.id,
      },
    });
    await s.built.app.recordPrincipalDelivery(delivery.id, "dm:D-live-erica");
    const recipient = await s.built.sessions.getByThread("dm:D-live-erica");
    assert.ok(recipient);
    const read = await get(s.base, `/v1/admin/sessions/${encodeURIComponent(recipient!.id)}?scope=org:default-org`);
    assert.equal(read.status, 200);
    const body = (await read.json()) as any;
    assert.equal(body.deliveryEvents.length, 1);
    const event = body.deliveryEvents[0];
    assert.equal(event.origin ?? null, null, "no background-wake card for a conversation post");
    assert.equal(event.provenance.sourceSessionId, source.id, "the session join survives");
    assert.equal(event.sourceSession.id, source.id);
  } finally {
    await s.close();
  }
});

test("a cron-fired transcript carries its originating cron", async () => {
  const s = start();
  try {
    const scope = "channel:C9";
    const cron = await s.built.app.createCron({
      ownerScopeId: scope,
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      title: "Daily security audit",
      action: "audit the new security advisories",
    });
    const session = await s.built.sessions.getOrCreateByThread(`cron:${cron.id}:42`, "channel", scope, "security");
    const { lease } = await s.built.sessions.acquireLease(session.id);
    assert.ok(lease);
    await s.built.sessions.append(lease, { type: "user", payload: { text: cron.action }, scopeLabel: scope });
    await s.built.sessions.releaseLease(lease);

    const tx = await get(
      s.base,
      `/v1/admin/sessions/${encodeURIComponent(session.id)}?scope=${encodeURIComponent(scope)}`,
    );
    assert.equal(tx.status, 200);
    const body = (await tx.json()) as any;
    assert.equal(body.origin.kind, "cron");
    assert.equal(body.origin.label, "Cron");
    assert.equal(body.origin.cronId, cron.id);
    assert.equal(body.origin.fireKey, `cron:${cron.id}:42`);
    assert.equal(body.origin.fireSlot, "42");
    assert.equal(body.origin.cron.title, "Daily security audit");
    assert.equal(body.origin.cron.ownerScopeId, scope);
    assert.equal(body.entries[0].type, "user");
  } finally {
    await s.close();
  }
});

test("principal deliveries render as delivery events and later DM turns get structured context", async () => {
  const s = start();
  try {
    const cron = await s.built.app.createCron({
      ownerScopeId: "personal:U-carol",
      owner: "U-carol",
      createdBy: "U-carol",
      schedule: { everyMs: 60_000 },
      title: "Deploy notice",
      message: "the deploy is done",
    });
    const delivery = await s.built.deliveries.enqueue({
      destination: { type: "principal", target: "U-alice", audienceScopeId: "personal:U-alice", onBehalfOf: "U-carol" },
      text: "the deploy is done",
      attachments: [
        {
          name: "rsi.gif",
          mimetype: "image/gif",
          sizeBytes: 42,
          blobId: "blob-1",
          artifactId: "art-1",
          artifactViewerId: "U-alice",
        },
      ],
      idempotencyKey: `cron:${cron.id}:42`,
    });
    await s.built.app.recordPrincipalDelivery(delivery.id, "dm:D-alice");

    const session = await s.built.sessions.getByThread("dm:D-alice");
    assert.ok(session, "recipient session exists");
    assert.equal(
      (await s.built.sessions.getEntries(session!.id)).some((e) => e.type === "assistant"),
      false,
    );

    const orgTx = await get(s.base, `/v1/admin/sessions/${encodeURIComponent(session!.id)}?scope=org:default-org`);
    assert.equal(orgTx.status, 200);
    const orgBody = (await orgTx.json()) as any;
    assert.equal(orgBody.entries.length, 0, "delivery is not a transcript entry");
    assert.equal(orgBody.deliveryEvents.length, 1, "recipient transcript renders delivery rows inline");
    assert.equal(orgBody.deliveryEvents[0].text, "the deploy is done");
    assert.deepEqual(orgBody.deliveryEvents[0].attachments, [
      {
        name: "rsi.gif",
        mimetype: "image/gif",
        sizeBytes: 42,
        blobId: "blob-1",
        artifactId: "art-1",
        artifactViewerId: "U-alice",
      },
    ]);
    assert.equal(orgBody.deliveryEvents[0].origin.cronId, cron.id);
    assert.equal(orgBody.deliveryEvents[0].origin.cron.title, "Deploy notice");

    const scopedTx = await get(
      s.base,
      `/v1/admin/sessions/${encodeURIComponent(session!.id)}?scope=${encodeURIComponent("personal:U-alice")}`,
    );
    assert.equal(scopedTx.status, 200);
    const scopedBody = (await scopedTx.json()) as any;
    assert.equal(
      scopedBody.deliveryEvents[0].origin.cron,
      null,
      "origin context outside the requested scope fails closed",
    );

    const turn: TurnRequest = {
      surface: "slack",
      actor: { externalId: "U-alice" },
      conversation: { kind: "dm", threadRef: "dm:D-alice" },
      text: "what was that deploy note?",
    };
    assert.equal((await s.built.app.turn(turn)).status, "ok");
    const reqs = await s.built.sessions.listLlmRequests(session!.id);
    const latest = reqs[reqs.length - 1] as any;
    const userMessage = latest.promptEnvelope.messages.at(-1).content;
    assert.match(userMessage, /Recent agent-initiated deliveries to this conversation/);
    assert.match(userMessage, /the deploy is done/);
  } finally {
    await s.close();
  }
});

test("monitor delivery origin context is scope-gated in admin", async () => {
  const s = start();
  try {
    const monitorId = "m1";
    const source = await s.built.sessions.getOrCreateByThread(
      `agent:main:monitor:${monitorId}`,
      "dm",
      "personal:U-carol",
    );
    const { lease } = await s.built.sessions.acquireLease(source.id);
    assert.ok(lease);
    const sourceUser = await s.built.sessions.append(lease, {
      type: "user",
      payload: { text: "monitor wake" },
      scopeLabel: "personal:U-carol",
    });
    const sourceAssistant = await s.built.sessions.append(lease, {
      type: "assistant",
      payload: { text: "Approval is due." },
      scopeLabel: "personal:U-carol",
    });
    await s.built.sessions.releaseLease(lease);
    await s.built.sessions.recordLlmRequest(source.id, {
      turnSeq: sourceUser.seq,
      step: 0,
      model: "mock",
      scopeLabel: "personal:U-carol",
      promptEnvelope: { model: "mock", messages: [{ role: "user", content: "monitor wake" }] },
      truncated: false,
    });
    const delivery = await s.built.deliveries.enqueue({
      destination: { type: "principal", target: "U-alice", audienceScopeId: "personal:U-alice", onBehalfOf: "U-carol" },
      text: "Approval is due.",
      idempotencyKey: `monitor:${monitorId}:42`,
      provenance: {
        trigger: "monitor",
        surface: "monitor",
        fireKey: `monitor:${monitorId}:42`,
        sourceScopeId: "personal:U-carol",
        sourceThreadRef: `agent:main:monitor:${monitorId}`,
        sourceSessionId: source.id,
        sourceUserSeq: sourceUser.seq,
        sourceAssistantEntrySeq: sourceAssistant.seq,
      },
    });
    await s.built.app.recordPrincipalDelivery(delivery.id, "dm:D-alice");
    const recipient = await s.built.sessions.getByThread("dm:D-alice");
    assert.ok(recipient);

    const orgRead = await get(s.base, `/v1/admin/sessions/${encodeURIComponent(recipient!.id)}?scope=org:default-org`);
    assert.equal(orgRead.status, 200);
    const orgBody = (await orgRead.json()) as any;
    assert.equal(orgBody.deliveryEvents.length, 1);
    assert.equal(orgBody.deliveryEvents[0].origin.kind, "background_wake");
    assert.equal(orgBody.deliveryEvents[0].origin.trigger, "monitor");
    assert.equal(orgBody.deliveryEvents[0].origin.sourceId, monitorId);
    assert.equal(orgBody.deliveryEvents[0].sourceSession.id, source.id);
    assert.equal(orgBody.deliveryEvents[0].llmRequests.length, 1);

    const sourceRead = await get(s.base, `/v1/admin/sessions/${encodeURIComponent(source.id)}?scope=org:default-org`);
    assert.equal(sourceRead.status, 200);
    const sourceBody = (await sourceRead.json()) as any;
    assert.equal(sourceBody.deliveryEvents.length, 1);
    assert.equal(sourceBody.deliveryEvents[0].type, "outbound_delivery");
    assert.equal(sourceBody.deliveryEvents[0].origin.kind, "background_wake");
    assert.equal(sourceBody.deliveryEvents[0].origin.trigger, "monitor");
    assert.equal(sourceBody.deliveryEvents[0].recipientThreadRef, "dm:D-alice");

    const scopedRead = await get(
      s.base,
      `/v1/admin/sessions/${encodeURIComponent(recipient!.id)}?scope=${encodeURIComponent("personal:U-alice")}`,
    );
    assert.equal(scopedRead.status, 200);
    const scopedBody = (await scopedRead.json()) as any;
    assert.equal(scopedBody.deliveryEvents.length, 1);
    assert.equal(scopedBody.deliveryEvents[0].origin.kind, "background_wake");
    assert.equal(scopedBody.deliveryEvents[0].origin.trigger, "monitor");
    assert.equal(scopedBody.deliveryEvents[0].origin.sourceId, monitorId);
    assert.equal(scopedBody.deliveryEvents[0].sourceSession, undefined);
    assert.equal(scopedBody.deliveryEvents[0].llmRequests, undefined);
  } finally {
    await s.close();
  }
});

test("conversation listing pages by limit/offset; aggregates span the whole scope; offset clamps", async () => {
  const s = start();
  try {
    for (let i = 0; i < 5; i++) {
      const dm: TurnRequest = {
        surface: "test",
        actor: { externalId: `U${i}` },
        conversation: { kind: "dm", threadRef: `dm:U${i}:t` },
        text: `hi ${i}`,
      };
      assert.equal((await s.built.app.turn(dm)).status, "ok");
    }

    const p1 = await getJson(s.base, "/v1/admin/sessions?scope=org:default-org&limit=2&offset=0");
    assert.equal(p1.sessions.length, 2, "limit bounds the returned slice");
    assert.equal(p1.total, 5, "total spans the whole scope, not the page");
    assert.equal(p1.byType.dm, 5, "by-type aggregate spans the whole scope");
    assert.equal(p1.limit, 2);
    assert.equal(p1.offset, 0);

    const p2 = await getJson(s.base, "/v1/admin/sessions?scope=org:default-org&limit=2&offset=2");
    const p3 = await getJson(s.base, "/v1/admin/sessions?scope=org:default-org&limit=2&offset=4");
    assert.equal(p3.sessions.length, 1, "the final page holds the remainder");
    const ids = new Set([...p1.sessions, ...p2.sessions, ...p3.sessions].map((x: { id: string }) => x.id));
    assert.equal(ids.size, 5, "the three pages cover every session exactly once");

    const over = await getJson(s.base, "/v1/admin/sessions?scope=org:default-org&limit=2&offset=999");
    assert.equal(over.offset, 4, "offset clamps to the last page");
    assert.equal(over.sessions.length, 1, "clamped page returns the last page's rows");
  } finally {
    await s.close();
  }
});

test("history separates background cron monologues from human conversations", async () => {
  const s = start();
  try {
    const scope = "channel:C9";
    const cron = await s.built.app.createCron({
      ownerScopeId: scope,
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      title: "Daily security audit",
      action: "audit the new security advisories",
    });

    const human = await s.built.sessions.getOrCreateByThread("ch:C9:thread", "channel", scope, "security");
    const { lease: humanLease } = await s.built.sessions.acquireLease(human.id);
    assert.ok(humanLease);
    await s.built.sessions.append(humanLease, {
      type: "user",
      payload: { text: "what happened in prod?" },
      scopeLabel: scope,
    });
    await s.built.sessions.releaseLease(humanLease);

    const monologue = await s.built.sessions.getOrCreateByThread(
      `agent:main:cron:${cron.id}`,
      "channel",
      scope,
      "security",
    );
    const { lease: monologueLease } = await s.built.sessions.acquireLease(monologue.id);
    assert.ok(monologueLease);
    await s.built.sessions.append(monologueLease, { type: "user", payload: { text: cron.action }, scopeLabel: scope });
    await s.built.sessions.releaseLease(monologueLease);

    const conversations = await getJson(s.base, `/v1/admin/sessions?scope=${encodeURIComponent(scope)}`);
    assert.equal(conversations.category, "conversation");
    assert.equal(conversations.total, 1, "default history lists human conversations only");
    assert.deepEqual(
      conversations.sessions.map((x: { id: string }) => x.id),
      [human.id],
    );
    assert.deepEqual(conversations.totalByCategory, { conversation: 1, background: 1, all: 2 });

    const background = await getJson(
      s.base,
      `/v1/admin/sessions?scope=${encodeURIComponent(scope)}&category=background`,
    );
    assert.equal(background.total, 1);
    assert.equal(background.sessions[0].id, monologue.id);
    assert.equal(background.sessions[0].category, "background");
    assert.equal(background.sessions[0].kind, "cron_monologue");
    assert.equal(background.sessions[0].origin.label, "Cron monologue");
    assert.equal(background.sessions[0].origin.cron.title, "Daily security audit");

    const transcript = await getJson(
      s.base,
      `/v1/admin/sessions/${encodeURIComponent(monologue.id)}?scope=${encodeURIComponent(scope)}`,
    );
    assert.equal(transcript.origin.label, "Cron monologue");
    assert.equal(transcript.origin.cronId, cron.id);

    const scopes = await getJson(s.base, "/v1/admin/scopes");
    const row = scopes.scopes.find((x: { scopeId: string }) => x.scopeId === scope);
    assert.equal(row.sessions, 1, "scope index counts human conversations separately");
    assert.equal(row.backgroundSessions, 1, "scope index exposes background monologues separately");
  } finally {
    await s.close();
  }
});

test("the Crons history lists one row per cron; ?cron= paginates that cron's fires", async () => {
  const s = start();
  try {
    const scope = "channel:C7";
    const mkFires = async (cronId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const sess = await s.built.sessions.getOrCreateByThread(`cron:${cronId}:slot${i}`, "channel", scope, "eng");
        const { lease } = await s.built.sessions.acquireLease(sess.id);
        assert.ok(lease);
        await s.built.sessions.append(lease, { type: "user", payload: { text: "fire " + i }, scopeLabel: scope });
        await s.built.sessions.releaseLease(lease);
      }
    };
    const cron = await s.built.app.createCron({
      ownerScopeId: scope,
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      title: "Tweet watcher",
      action: "watch tweets",
    });
    await mkFires(cron.id, 3);
    await mkFires("other-cron", 2);

    const list = await getJson(
      s.base,
      `/v1/admin/sessions?scope=${encodeURIComponent(scope)}&category=background&origin=cron`,
    );
    assert.equal(list.sessions, undefined, "grouped listing carries no per-fire rows");
    assert.equal(list.total, 2, "one row per cron, regardless of fire count");
    const g = list.crons.find((x: { cronId: string }) => x.cronId === cron.id);
    assert.equal(g.sessions, 3, "the group aggregates every fire");
    assert.equal(g.origin.cron.title, "Tweet watcher", "group row resolves the cron's name");
    assert.equal(g.deliveredRuns, 0, "no deliveries yet: delivered rollup is zero");

    await s.built.deliveries.enqueue({
      destination: { type: "principal", target: "U1", onBehalfOf: "U1" },
      text: "recap",
      idempotencyKey: `cron:${cron.id}:slot0:msg`,
      provenance: {
        trigger: "cron",
        surface: "cron",
        fireKey: `cron:${cron.id}:slot0`,
        sourceScopeId: scope,
        sourceThreadRef: `cron:${cron.id}:slot0`,
        sourceSessionId: "fire-0",
      },
    });
    const relisted = await getJson(
      s.base,
      `/v1/admin/sessions?scope=${encodeURIComponent(scope)}&category=background&origin=cron`,
    );
    assert.equal(
      relisted.crons.find((x: { cronId: string }) => x.cronId === cron.id).deliveredRuns,
      1,
      "the listing rolls up delivering runs per cron",
    );

    const p1 = await getJson(
      s.base,
      `/v1/admin/sessions?scope=${encodeURIComponent(scope)}&category=background&origin=cron&cron=${cron.id}&limit=2&offset=0`,
    );
    assert.equal(p1.total, 3, "drill-down total counts this cron's fires only");
    assert.equal(p1.sessions.length, 2);
    const p2 = await getJson(
      s.base,
      `/v1/admin/sessions?scope=${encodeURIComponent(scope)}&category=background&origin=cron&cron=${cron.id}&limit=2&offset=2`,
    );
    assert.equal(p2.sessions.length, 1, "last page holds the remainder");
    const ids = new Set([...p1.sessions, ...p2.sessions].map((x: { id: string }) => x.id));
    assert.equal(ids.size, 3, "pages cover this cron's fires exactly once");
    assert.ok(
      [...p1.sessions, ...p2.sessions].every((x: { threadRef: string }) => x.threadRef.includes(cron.id)),
      "no other cron's fires leak in",
    );
    assert.equal(p1.cron.cron.title, "Tweet watcher", "drill-down names the cron");
  } finally {
    await s.close();
  }
});

test("the Files view is the document store (write-tool artifacts), not the sandbox backup", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-obs-fly-")) }));
  const scope = "channel:C_FILE_FIXTURE";
  await built.files.put({
    id: "deck-1",
    ownerScopeId: scope,
    createdBy: "U1",
    name: "slides.pdf",
    path: "decks/slides.pdf",
    mimetype: "application/pdf",
    data: Buffer.from("%PDF-1.4 deck"),
    direction: "out",
  });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    errors: built.errors,
    runs: built.runs,
    workspace: built.workspace,
    files: built.files,
    sandboxBackend: "sprites",
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const list = await getJson(base, `/v1/admin/files?scope=${encodeURIComponent(scope)}`);
    const names = (list.files as { name: string }[]).map((f) => f.name);
    assert.deepEqual(names, ["slides.pdf"], "the document is listed; the sandbox backup is never flattened into Files");
    const doc = list.files[0] as { mimetype: string; scopeId: string; openable: boolean };
    assert.equal(doc.mimetype, "application/pdf");
    assert.equal(doc.scopeId, scope);
    assert.ok(doc.openable);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a saved document is read and downloaded by artifact id", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-obs-doc-")) }));
  const scope = "personal:U1";
  await built.files.put({
    id: "csv-1",
    ownerScopeId: scope,
    createdBy: "U1",
    name: "report.csv",
    path: "reports/report.csv",
    mimetype: "text/csv",
    data: Buffer.from("a,b\n1,2"),
    direction: "out",
  });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    errors: built.errors,
    runs: built.runs,
    workspace: built.workspace,
    files: built.files,
    sandboxBackend: "sprites",
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const list = await getJson(base, `/v1/admin/files?scope=${encodeURIComponent(scope)}`);
    const f = (list.files as { id: string; name: string }[]).find((x) => x.name === "report.csv")!;
    assert.ok(f, "the document is listed for its owning scope");
    const read = await getJson(base, `/v1/admin/files/read?id=${encodeURIComponent(f.id)}`);
    assert.equal(read.content, "a,b\n1,2", "content is served from the document store");
    const download = await get(base, `/v1/admin/files/download?id=${encodeURIComponent(f.id)}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /report\.csv/);
    assert.equal(
      Buffer.from(await download.arrayBuffer()).toString("utf8"),
      "a,b\n1,2",
      "bytes are downloadable by id",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("admin observability enforces scope grants (authz is the boundary)", async () => {
  const s = start();
  try {
    const UMA = { "x-admin-actor": "user-uma@default-org" };
    assert.equal((await get(s.base, "/v1/admin/sessions?scope=org:default-org", UMA)).status, 403);
    assert.equal(
      (await get(s.base, "/v1/admin/runs?scope=org:default-org", { "x-admin-actor": "nobody@default-org" })).status,
      403,
    );
    assert.equal((await get(s.base, "/v1/admin/files")).status, 400);
    assert.equal((await get(s.base, "/v1/admin/sessions/does-not-exist?scope=org:default-org")).status, 404);
  } finally {
    await s.close();
  }
});

test("admin governance reports the sandbox's actual egress enforcement capability", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-egress-capability-")) }));
  const read = async (declared: "none" | "ip_port" | "domain", effective: "none" | "ip_port" | "domain") => {
    const server = createInsecureTestServer(built.app, {
      admin: built.admin,
      config: built.config,
      auditLog: built.auditLog,
      sandboxBackend: "sprites",
      egressDeclaredEnforcement: declared,
      egressEnforcement: effective,
    });
    server.listen(0);
    try {
      const base = `http://localhost:${(server.address() as AddressInfo).port}`;
      return (await getJson(base, "/v1/admin/scopes/org:default-org")).egressEnforcement;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  assert.deepEqual(await read("none", "none"), {
    backend: "sprites",
    declaredFidelity: "none",
    effectiveFidelity: "none",
    fidelity: "none",
    active: false,
    reason: "backend_unsupported",
  });
  assert.deepEqual(
    await read("ip_port", "ip_port"),
    {
      backend: "sprites",
      declaredFidelity: "ip_port",
      effectiveFidelity: "ip_port",
      fidelity: "ip_port",
      active: false,
      reason: "backend_unsupported",
    },
    "IP/port fidelity cannot enforce a hostname policy",
  );
  assert.deepEqual(await read("domain", "none"), {
    backend: "sprites",
    declaredFidelity: "domain",
    effectiveFidelity: "none",
    fidelity: "none",
    active: false,
    reason: "control_plane_unconfigured",
  });
  assert.deepEqual(await read("domain", "domain"), {
    backend: "sprites",
    declaredFidelity: "domain",
    effectiveFidelity: "domain",
    fidelity: "domain",
    active: true,
    reason: "ready",
  });
});

test("admin governance: base model round-trips per-scope, validates ids", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-model-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    config: built.config,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const putModel = (scope: string, modelId: string, headers: Record<string, string>) =>
    fetch(base + `/v1/admin/scopes/${encodeURIComponent(scope)}/base-model`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ modelId }),
    });
  try {
    const initial = await getJson(base, "/v1/admin/scopes/org:default-org");
    assert.equal(initial.baseModel, null, "no override by default");
    assert.ok(initial.baseModelDefault, "the effective default is reported");
    assert.ok(
      (initial.baseModelOptions as Array<{ id: string }>).some((m) => m.id === "claude-opus-4-8"),
      "the picker options include the default",
    );

    assert.equal(
      (await putModel("org:default-org", "claude-opus-4-8", { "x-admin-actor": "nobody@default-org" })).status,
      403,
      "admin-gated",
    );
    assert.equal(
      (await putModel("org:default-org", "claude-future-99", ALICE)).status,
      400,
      "an id pi-ai doesn't know is rejected",
    );
    assert.equal(
      (await putModel("channel:C1", "claude-opus-4-8", ALICE)).status,
      200,
      "a channel scope can pin its own model",
    );
    assert.equal(built.config.getBaseModel("channel:C1"), "claude-opus-4-8", "the channel override is stored");
    assert.equal(built.config.getBaseModel("org:default-org"), null, "the channel pin does not touch the org default");

    assert.equal((await putModel("org:default-org", "claude-opus-4-8", ALICE)).status, 200);
    assert.equal((await getJson(base, "/v1/admin/scopes/org:default-org")).baseModel, "claude-opus-4-8");
    assert.equal(
      built.config.getBaseModel("org:default-org"),
      "claude-opus-4-8",
      "the store the harness reads sees the change",
    );

    const nonString = await fetch(base + "/v1/admin/scopes/org%3Adefault-org/base-model", {
      method: "PUT",
      headers: { ...ALICE, "content-type": "application/json" },
      body: JSON.stringify({ modelId: 123 }),
    });
    assert.equal(nonString.status, 400, "a non-string modelId is rejected, not treated as a clear");
    assert.equal(
      built.config.getBaseModel("org:default-org"),
      "claude-opus-4-8",
      "the override is untouched by a malformed body",
    );

    assert.equal((await putModel("org:default-org", "", ALICE)).status, 200, "empty modelId clears the override");
    assert.equal((await getJson(base, "/v1/admin/scopes/org:default-org")).baseModel, null);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("admin governance: people-directory URL round-trips, validates scheme, and is org-scoped", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-peopledir-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    config: built.config,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const putUrl = (scope: string, url: string, headers: Record<string, string>) =>
    fetch(base + `/v1/admin/scopes/${encodeURIComponent(scope)}/people-directory-url`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
  try {
    assert.equal(
      (await getJson(base, "/v1/admin/scopes/org:default-org")).peopleDirectoryUrl,
      null,
      "no directory by default",
    );

    assert.equal(
      (await putUrl("org:default-org", "https://www.example.com/people", { "x-admin-actor": "nobody@default-org" }))
        .status,
      403,
      "admin-gated",
    );
    assert.equal(
      (await putUrl("org:default-org", "example.com/people", ALICE)).status,
      400,
      "a URL without an http(s) scheme is rejected",
    );
    assert.equal(
      (await putUrl("channel:C1", "https://example.com/people", ALICE)).status,
      400,
      "org-wide only — a channel scope is rejected",
    );

    assert.equal((await putUrl("org:default-org", "https://www.example.com/people", ALICE)).status, 200);
    assert.equal(
      (await getJson(base, "/v1/admin/scopes/org:default-org")).peopleDirectoryUrl,
      "https://www.example.com/people",
    );
    assert.equal(
      built.config.getPeopleDirectoryUrl("org:default-org"),
      "https://www.example.com/people",
      "the store the resolver reads sees the change",
    );

    const nonString = await fetch(base + "/v1/admin/scopes/org%3Adefault-org/people-directory-url", {
      method: "PUT",
      headers: { ...ALICE, "content-type": "application/json" },
      body: JSON.stringify({ url: 123 }),
    });
    assert.equal(nonString.status, 400, "a non-string url is rejected, not treated as a clear");
    assert.equal(
      built.config.getPeopleDirectoryUrl("org:default-org"),
      "https://www.example.com/people",
      "the value is untouched by a malformed body",
    );

    assert.equal((await putUrl("org:default-org", "", ALICE)).status, 200, "empty url clears it");
    assert.equal((await getJson(base, "/v1/admin/scopes/org:default-org")).peopleDirectoryUrl, null);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("admin governance: browse step limit round-trips, validates, and is org-scoped", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-browsesteps-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    config: built.config,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const putSteps = (scope: string, steps: unknown, headers: Record<string, string>) =>
    fetch(base + `/v1/admin/scopes/${encodeURIComponent(scope)}/browse-max-steps`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ steps }),
    });
  try {
    assert.equal((await getJson(base, "/v1/admin/scopes/org:default-org")).browseMaxSteps, null, "no limit by default");

    assert.equal(
      (await putSteps("org:default-org", 80, { "x-admin-actor": "nobody@default-org" })).status,
      403,
      "admin-gated",
    );
    assert.equal((await putSteps("channel:C1", 80, ALICE)).status, 400, "org-wide only — a channel scope is rejected");
    assert.equal((await putSteps("org:default-org", 0, ALICE)).status, 400, "zero is rejected");
    assert.equal((await putSteps("org:default-org", 2.5, ALICE)).status, 400, "a non-integer is rejected");
    assert.equal((await putSteps("org:default-org", 501, ALICE)).status, 400, "values past the cap are rejected");

    assert.equal((await putSteps("org:default-org", 120, ALICE)).status, 200);
    assert.equal((await getJson(base, "/v1/admin/scopes/org:default-org")).browseMaxSteps, 120);
    assert.equal(
      built.config.getBrowseMaxSteps("org:default-org"),
      120,
      "the store the orchestrator reads sees the change",
    );

    assert.equal(
      (await putSteps("org:default-org", "90", ALICE)).status,
      200,
      "a numeric string is accepted (the UI sends input.value)",
    );
    assert.equal(built.config.getBrowseMaxSteps("org:default-org"), 90);

    assert.equal((await putSteps("org:default-org", "", ALICE)).status, 200, "empty clears to the default");
    assert.equal((await getJson(base, "/v1/admin/scopes/org:default-org")).browseMaxSteps, null);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("an OpenAI-only deployment still gets a browse model picker, and Anthropic picks are refused", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "admin-browsemodel-oa-")),
      modelId: "gpt-5.6-sol",
      openaiApiKey: "sk-openai-test",
    }),
  );
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    config: built.config,
    auditLog: built.auditLog,
    baseModelDefault: "gpt-5.6-sol",
    providerKeys: { anthropic: false, openai: true, openrouter: false },
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const putModel = (modelId: unknown) =>
    fetch(base + "/v1/admin/scopes/org%3Adefault-org/browse-model", {
      method: "PUT",
      headers: { ...ALICE, "content-type": "application/json" },
      body: JSON.stringify({ modelId }),
    });
  try {
    const opts = (await getJson(base, "/v1/admin/scopes/org:default-org")).browseModelOptions as Array<{ id: string }>;
    assert.ok(opts.length > 0, "the picker is not empty just because the deployment has no Anthropic key");
    assert.ok(
      opts.every((m) => m.id.startsWith("gpt-")),
      "only models this deployment can actually serve are offered",
    );

    assert.equal(
      (await putModel("claude-opus-4-8")).status,
      400,
      "an Anthropic pick is refused when no Anthropic key is configured",
    );
    assert.equal((await putModel("gpt-5.6-luna")).status, 200);
    assert.equal(built.config.getBrowseModel("org:default-org"), "gpt-5.6-luna");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("admin governance: browse model round-trips, validates, and is org-scoped", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-browsemodel-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    config: built.config,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const putModel = (scope: string, modelId: unknown, headers: Record<string, string>) =>
    fetch(base + `/v1/admin/scopes/${encodeURIComponent(scope)}/browse-model`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ modelId }),
    });
  try {
    assert.equal((await getJson(base, "/v1/admin/scopes/org:default-org")).browseModel, null, "no override by default");

    assert.equal(
      (await putModel("org:default-org", "claude-sonnet-4-6", { "x-admin-actor": "nobody@default-org" })).status,
      403,
      "admin-gated",
    );
    assert.equal(
      (await putModel("channel:C1", "claude-sonnet-4-6", ALICE)).status,
      400,
      "org-wide only — a channel scope is rejected",
    );
    assert.equal(
      (await putModel("org:default-org", "not-a-model", ALICE)).status,
      400,
      "an unknown model id is rejected",
    );
    assert.equal(
      (await putModel("org:default-org", "gpt-5.6-luna", ALICE)).status,
      200,
      "a non-Anthropic model is accepted — the browse runner follows the model's provider",
    );
    assert.equal(
      (await putModel("org:default-org", 42, ALICE)).status,
      400,
      "a non-string is rejected, not treated as a clear",
    );

    assert.equal((await putModel("org:default-org", "claude-sonnet-4-6", ALICE)).status, 200);
    assert.equal((await getJson(base, "/v1/admin/scopes/org:default-org")).browseModel, "claude-sonnet-4-6");
    assert.equal(
      built.config.getBrowseModel("org:default-org"),
      "claude-sonnet-4-6",
      "the store the orchestrator reads sees the change",
    );
    const opts = (await getJson(base, "/v1/admin/scopes/org:default-org")).browseModelOptions;
    assert.ok(
      Array.isArray(opts) && opts.some((m: { id: string }) => m.id === "claude-opus-4-8"),
      "the scope read carries the browse model picker options",
    );
    assert.ok(
      opts.some((m: { id: string }) => m.id === "gpt-5.6-sol"),
      "the browse picker spans providers, not Anthropic alone",
    );

    assert.equal((await putModel("org:default-org", "", ALICE)).status, 200, "empty clears to the default");
    assert.equal((await getJson(base, "/v1/admin/scopes/org:default-org")).browseModel, null);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
