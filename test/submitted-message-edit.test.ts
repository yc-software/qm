import "./support/auto-fake-sprites.ts";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { collectBlob } from "../src/persistence/blob-transfer.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "submitted-edit-secret".repeat(3);
const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "submitted-edit-")) }));
const core = createServer(built.app, {
  signingSecret: SECRET,
  runs: built.runs,
  sessions: built.sessions,
  blobTransfer: built.blobTransfer,
});
core.listen(0);
const base = `http://localhost:${(core.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => core.close(() => resolve()));
  await built.runtime.stop();
});

const turn = (text: string, threadRef: string, actor = "U1", attachments: any[] = []) =>
  built.app.turn({
    surface: "web",
    actor: { externalId: actor },
    conversation: { kind: "dm", threadRef },
    text,
    attachments,
  });

async function edit(sessionId: string, seq: number, principalId: string, text: string): Promise<Response> {
  const path = `/v1/sessions/${encodeURIComponent(sessionId)}/messages/${seq}/edit`;
  const body = JSON.stringify({ principalId, text });
  return fetch(base + path, {
    method: "POST",
    headers: { ...signedHeaders(SECRET, "POST", path, body), "content-type": "application/json" },
    body,
  });
}

test("submitted web messages edit by rerunning an authorized durable fork", async () => {
  const first = await turn("wrong opening", "web:U1:first-submitted-edit");
  const firstSource = (await built.app.getSession(first.sessionId!))!;
  const firstEntries = structuredClone(firstSource.entries);
  const firstTape = structuredClone(await built.sessions.getTape(firstSource.session.id));
  const firstResponse = await edit(firstSource.session.id, 0, "U1", "fixed opening");
  assert.equal(firstResponse.status, 202);
  const firstResult = (await firstResponse.json()) as { entries: unknown[]; turn: { runId: string } };
  assert.deepEqual(firstResult.entries, []);
  assert.equal((await built.runs.get(firstResult.turn.runId))?.request.text, "fixed opening");
  assert.deepEqual((await built.app.getSession(firstSource.session.id))!.entries, firstEntries);
  assert.deepEqual(await built.sessions.getTape(firstSource.session.id), firstTape);

  const threadRef = "web:U1:submitted-edit";
  await turn("context that stays", threadRef);
  const blob = await built.blobTransfer.put(Buffer.from("attachment stays"));
  const original = await turn("wrong detail", threadRef, "U1", [
    { name: "notes.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId },
  ]);
  await turn("later turn must not survive", threadRef);
  const originalRun = (await built.runs.list({ threadRef })).find((run) => run.request.text === "wrong detail")!;
  const source = (await built.app.getSession(original.sessionId!))!;
  const target = source.entries.find(
    (entry) => entry.type === "user" && (entry.payload as { runId?: string }).runId === originalRun.id,
  )!;
  const sessionPath = `/v1/sessions/${source.session.id}?viewer=U1`;
  const rendered = await fetch(base + sessionPath, {
    headers: signedHeaders(SECRET, "GET", sessionPath, ""),
  });
  const renderedEntries = ((await rendered.json()) as { entries: Array<{ seq: number; editable?: boolean }> }).entries;
  assert.equal(renderedEntries.find((entry) => entry.seq === target.seq)?.editable, true);

  assert.equal((await edit(source.session.id, target.seq, "U2", "fixed detail")).status, 404);

  originalRun.status = "running";
  assert.equal((await edit(source.session.id, target.seq, "U1", "cannot edit busy")).status, 409);
  originalRun.status = "done";

  const busy = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef },
    text: "queued detail",
    async: true,
  });
  const busyRun = await built.runs.get(busy.runId!);
  assert.equal(busyRun?.status, "pending");
  assert.equal(busyRun?.turnUserSeq, null);

  const sourceEntriesBeforeEdit = structuredClone((await built.app.getSession(source.session.id))!.entries);
  const sourceTapeBeforeEdit = structuredClone(await built.sessions.getTape(source.session.id));
  await built.blobTransfer.delete(blob.blobId);

  const response = await edit(source.session.id, target.seq, "U1", "fixed detail");
  assert.equal(response.status, 202);
  const result = (await response.json()) as { session: { id: string; threadRef: string }; turn: { runId: string } };
  const forkPath = `/v1/sessions/${result.session.id}?viewer=U1`;
  const forkView = await fetch(base + forkPath, { headers: signedHeaders(SECRET, "GET", forkPath, "") });
  const forkEntries = ((await forkView.json()) as { entries: Array<{ editable?: boolean }> }).entries;
  assert.ok(forkEntries.every((entry) => entry.editable !== true));
  const rerun = await built.runs.get(result.turn.runId);
  assert.equal(rerun?.request.text, "fixed detail");
  assert.equal(rerun?.request.attachments?.length, 1);
  assert.notEqual(rerun?.request.attachments?.[0]?.blobId, blob.blobId);
  const restaged = await built.blobTransfer.open(rerun!.request.attachments![0]!.blobId);
  assert.equal((await collectBlob(restaged!.stream)).toString(), "attachment stays");
  assert.deepEqual((await built.app.getSession(source.session.id))!.entries, sourceEntriesBeforeEdit);
  assert.deepEqual(await built.sessions.getTape(source.session.id), sourceTapeBeforeEdit);

  const reloaded = (await built.app.getSession(result.session.id))!;
  const inherited = reloaded.entries.map((entry) => JSON.stringify(entry.payload)).join("\n");
  assert.match(inherited, /context that stays/);
  assert.doesNotMatch(inherited, /wrong detail|later turn must not survive/);

  built.runtime.start();
  const finished = await built.runs.waitFor(result.turn.runId, 5_000);
  assert.equal(finished.status, "done");
  const durable = (await built.app.getSession(result.session.id))!.entries;
  const durableUser = durable.filter((entry) => entry.type === "user").at(-1)!;
  assert.equal(
    durableUser.payload && (durableUser.payload as { text?: string }).text,
    "fixed detail",
  );
  assert.equal((durableUser.payload as { attachments?: unknown[] }).attachments?.length, 1);
  assert.match(JSON.stringify(durableUser.payload), /notes\.txt/);
  assert.doesNotMatch(durable.map((entry) => JSON.stringify(entry.payload)).join("\n"), /wrong detail|later turn must not survive/);
  const modelContext = JSON.stringify(await built.sessions.getTape(result.session.id));
  assert.match(modelContext, /context that stays/);
  assert.match(modelContext, /fixed detail/);
  assert.doesNotMatch(modelContext, /wrong detail|later turn must not survive/);

  const slack = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1" },
    text: "slack source",
  });
  const slackSession = (await built.app.getSession(slack.sessionId!))!;
  const slackEntry = slackSession.entries.find((entry) => entry.type === "user")!;
  assert.equal((await edit(slackSession.session.id, slackEntry.seq, "U1", "unsupported edit")).status, 404);

  const refusedThread = "web:U1:refused-submitted-edit";
  await turn("refusal context", refusedThread);
  const refusedTarget = await turn("refusal target", refusedThread);
  const refusedSource = (await built.app.getSession(refusedTarget.sessionId!))!;
  const refusedEntry = refusedSource.entries.find(
    (entry) => entry.type === "user" && (entry.payload as { text?: string }).text === "refusal target",
  )!;
  const sessionsBeforeRefusal = await built.sessions.listByParticipant("U1");
  await built.identity.deactivate("U1");
  const refused = await edit(refusedSource.session.id, refusedEntry.seq, "U1", "refused edit");
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { message: string }).message, /internal-only/);
  assert.equal((await built.sessions.listByParticipant("U1")).length, sessionsBeforeRefusal.length);
});
