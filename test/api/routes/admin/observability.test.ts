import "../../../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { type TurnRequest } from "../../../../src/types.ts";
import { eventually } from "../../../support/settle.ts";
import { start, get, getJson } from "../../../support/admin-observability.ts";
import { mockPrompts } from "../../../support/mock-harness/turn.ts";

test("an org admin sees conversations, transcripts, files, and runs top-down", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      origin: { kind: "direct" },
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
    const transcript = txd as { items: { kind: string }[] };
    assert.ok(
      transcript.items.some((e) => e.kind === "UserMessage"),
      "transcript includes the user message",
    );
    assert.ok(!transcript.items.some((e) => e.kind === "soul"), "resolved prompt context is not a transcript entry");

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

test("an org admin sees per-call model metadata for each turn", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      origin: { kind: "direct" },
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
      }[];
    };
    assert.ok(d.requests.length >= 1, "at least one captured request");
    const meta = d.requests[0]!;
    assert.equal(meta.step, 0, "first agent step of the turn");
    assert.equal(typeof meta.turnSeq, "number", "correlated to the turn's user entry");
    const tr = await get(
      s.base,
      `/v1/admin/sessions/${encodeURIComponent(conv.id)}/llm?turnSeq=${meta.turnSeq}&scope=org:default-org`,
    );
    assert.equal(tr.status, 200);
    const td = (await tr.json()) as { requests: { turnSeq: number | null }[] };
    assert.ok(td.requests.length >= 1, "the turn's requests");
    assert.ok(
      td.requests.every((req) => req.turnSeq === meta.turnSeq),
      "scoped to the requested turn",
    );
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
    await s.built.sessions.append(lease, { kind: "UserMessage", text: cron.action });
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
    assert.equal(body.items[0].kind, "UserMessage");
  } finally {
    await s.close();
  }
});

test("a Slack DM post joins the recipient's DM conversation and shows up in their next turn's context", async () => {
  const s = start();
  try {
    s.built.outbound.register(["principal"], async () => ({ recipientThreadRef: "dm:D-alice" }));
    await s.built.outbound.send({
      destination: { type: "principal", target: "U-alice", audienceScopeId: "personal:U-alice", onBehalfOf: "U-carol" },
      text: "the deploy is done",
      idempotencyKey: "cron:c1:42",
      provenance: {
        trigger: "cron",
        surface: "cron",
        fireKey: "cron:c1:42",
        sourceScopeId: "personal:U-carol",
        sourceThreadRef: "cron:c1:42",
      },
    });
    const session = await eventually(() => s.built.sessions.getByThread("dm:D-alice"), { label: "recipient session" });
    assert.equal(
      (await s.built.sessions.getItems(session!.id)).some((e) => e.kind === "AgentMessage"),
      false,
      "the post is not written into the recipient's chat history",
    );

    const turn: TurnRequest = {
      origin: { kind: "direct" },
      surface: "slack",
      actor: { externalId: "U-alice" },
      conversation: { kind: "dm", threadRef: "dm:D-alice" },
      text: "what was that deploy note?",
    };
    assert.equal((await s.built.app.turn(turn)).status, "ok");
    const userMessage = mockPrompts(session!.id).at(-1)!.messages.at(-1)!.content;
    assert.match(userMessage, /Delivered here since the user's last message/);
    assert.match(userMessage, /\[cron\] from U-carol: the deploy is done/);
  } finally {
    await s.close();
  }
});

const eventuallyJson = (base: string, path: string, ready: (body: any) => boolean): Promise<any> =>
  eventually(() => getJson(base, path), { until: ready, label: path });

test("conversation listing pages by keyset cursor; counts come from the background snapshot; offset is ignored", async () => {
  const s = start();
  try {
    for (let i = 0; i < 5; i++) {
      const dm: TurnRequest = {
        origin: { kind: "direct" },
        surface: "test",
        actor: { externalId: `U${i}` },
        conversation: { kind: "dm", threadRef: `dm:U${i}:t` },
        text: `hi ${i}`,
      };
      assert.equal((await s.built.app.turn(dm)).status, "ok");
    }

    const path = "/v1/admin/sessions?scope=org:default-org&limit=2";
    const p1 = await getJson(s.base, path);
    assert.equal(p1.sessions.length, 2, "limit bounds the returned slice");
    assert.equal(p1.total, undefined, "the listing computes no live totals");
    assert.equal(p1.limit, 2);
    assert.equal(p1.offset, undefined, "the listing no longer reports an offset");

    const p2 = await getJson(s.base, `${path}&cursor=${encodeURIComponent(p1.nextCursor)}`);
    const p3 = await getJson(s.base, `${path}&cursor=${encodeURIComponent(p2.nextCursor)}`);
    assert.equal(p3.sessions.length, 1, "the final page holds the remainder");
    assert.equal(p3.nextCursor, undefined, "a short page ends the walk");
    const ids = new Set([...p1.sessions, ...p2.sessions, ...p3.sessions].map((x: { id: string }) => x.id));
    assert.equal(ids.size, 5, "the three pages cover every session exactly once");
    const exact = await getJson(s.base, "/v1/admin/sessions?scope=org:default-org&limit=5");
    assert.equal(exact.sessions.length, 5);
    assert.equal(exact.nextCursor, undefined, "a page that exactly fills the limit offers no empty next page");

    const counted = await eventuallyJson(s.base, path, (body) => body.counts !== undefined);
    assert.deepEqual(counted.counts, { conversation: 5, cron: 0, background: 0 }, "tab counts span the org");
    assert.equal(typeof counted.countsAsOf, "number");

    const ignored = await getJson(s.base, `${path}&offset=4`);
    assert.deepEqual(
      ignored.sessions.map((x: { id: string }) => x.id),
      p1.sessions.map((x: { id: string }) => x.id),
      "an offset parameter cannot push the database into skipping rows",
    );
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
      kind: "UserMessage",
      text: "what happened in prod?",
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
    await s.built.sessions.append(monologueLease, { kind: "UserMessage", text: cron.action });
    await s.built.sessions.releaseLease(monologueLease);

    const conversations = await getJson(s.base, `/v1/admin/sessions?scope=${encodeURIComponent(scope)}`);
    assert.equal(conversations.category, "conversation");
    assert.deepEqual(
      conversations.sessions.map((x: { id: string }) => x.id),
      [human.id],
    );
    const counted = await eventuallyJson(
      s.base,
      `/v1/admin/sessions?scope=${encodeURIComponent(scope)}`,
      (body) => body.counts !== undefined,
    );
    assert.deepEqual(counted.counts, { conversation: 1, cron: 1, background: 0 }, "tab counts are per scope");

    const background = await getJson(
      s.base,
      `/v1/admin/sessions?scope=${encodeURIComponent(scope)}&category=background`,
    );
    assert.equal(background.sessions.length, 1);
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

    const scopes = await eventuallyJson(s.base, "/v1/admin/scopes", (body) => body.activityAsOf !== undefined);
    const row = scopes.scopes.find((x: { scopeId: string }) => x.scopeId === scope);
    assert.equal(row.sessions, 1, "scope index counts human conversations separately");
    assert.equal(row.backgroundSessions, 1, "scope index exposes background monologues separately");
  } finally {
    await s.close();
  }
});

test("the Crons history lists cron fires as session rows; ?cron= paginates one cron's fires", async () => {
  const s = start();
  try {
    const scope = "channel:C7";
    const mkFires = async (cronId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const sess = await s.built.sessions.getOrCreateByThread(`cron:${cronId}:slot${i}`, "channel", scope, "eng");
        const { lease } = await s.built.sessions.acquireLease(sess.id);
        assert.ok(lease);
        await s.built.sessions.append(lease, { kind: "UserMessage", text: "fire " + i });
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
    assert.equal(list.sessions.length, 5, "every fire is its own row");
    assert.ok(list.sessions.every((x: { origin: { kind: string } }) => x.origin.kind === "cron"));
    assert.equal(
      list.sessions.find((x: { threadRef: string }) => x.threadRef.includes(cron.id)).origin.cron.title,
      "Tweet watcher",
      "rows resolve the cron's name",
    );

    const p1 = await getJson(
      s.base,
      `/v1/admin/sessions?scope=${encodeURIComponent(scope)}&category=background&origin=cron&cron=${cron.id}&limit=2`,
    );
    assert.equal(p1.sessions.length, 2);
    const p2 = await getJson(
      s.base,
      `/v1/admin/sessions?scope=${encodeURIComponent(scope)}&category=background&origin=cron&cron=${cron.id}&limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`,
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

test("cron fire rows carry the fire's result digest from the cron's fire log", async () => {
  const s = start();
  try {
    const scope = "channel:C8";
    const cron = await s.built.app.createCron({
      ownerScopeId: scope,
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      title: "Sticky watcher",
      action: "Check yna's watched stickies",
    });
    const mkFire = async (slot: string) => {
      const sess = await s.built.sessions.getOrCreateByThread(`cron:${cron.id}:${slot}`, "channel", scope, "eng");
      const { lease } = await s.built.sessions.acquireLease(sess.id);
      assert.ok(lease);
      await s.built.sessions.append(lease, {
        kind: "UserMessage",
        text: "Stored cron task: Check yna's watched stickies",
      });
      await s.built.sessions.releaseLease(lease);
      return sess;
    };
    const replied = await mkFire("slot0");
    const noted = await mkFire("slot1");
    const bare = await mkFire("slot2");
    await s.built.crons.recordFire(cron.id, {
      fireKey: `cron:${cron.id}:slot0`,
      threadRef: `cron:${cron.id}:slot0`,
      firedAt: 1,
      status: "ok",
      reply: "No new stickies; nothing to report.",
      note: "recipient consent missing",
      sessionId: replied.id,
    });
    await s.built.crons.recordFire(cron.id, {
      fireKey: `cron:${cron.id}:slot1`,
      threadRef: `cron:${cron.id}:slot1`,
      firedAt: 2,
      status: "failed",
      note: "sandbox provisioning failed",
    });

    const fires = await getJson(
      s.base,
      `/v1/admin/sessions?scope=${encodeURIComponent(scope)}&category=background&origin=cron&cron=${cron.id}`,
    );
    const byId = new Map(fires.sessions.map((x: { id: string }) => [x.id, x]));
    assert.equal(
      (byId.get(replied.id) as any).result,
      "No new stickies; nothing to report.",
      "the reply wins over delivery-plumbing notes as the result digest",
    );
    assert.equal(
      (byId.get(noted.id) as any).result,
      "sandbox provisioning failed",
      "a fire keyed by threadRef surfaces its note as the result digest",
    );
    assert.equal(
      (byId.get(bare.id) as any).result,
      "Stored cron task: Check yna's watched stickies",
      "a fire without a log entry falls back to the stored-task preview, computed once server-side",
    );
  } finally {
    await s.close();
  }
});
