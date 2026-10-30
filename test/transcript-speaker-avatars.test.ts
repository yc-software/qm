import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { Lease } from "../src/sessions/session-store.ts";
import { scopeId, type SessionEntry } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

test("GET /v1/sessions/:id attaches directory photos to human speakers outside projects", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "speaker-avatars-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    await built.directory.replace([
      { principalId: "U1", displayName: "Ada", type: "internal", avatarUrl: "https://example.com/ada.png" },
      { principalId: "U2", displayName: "Bo", type: "internal", avatarUrl: "http://example.com/bo.png" },
    ]);
    const scope = scopeId("channel", "C1");
    const session = await built.sessions.getOrCreateByThread("slack:C1:1.0", "channel", scope, undefined, "slack");
    await built.sessions.addParticipant(session.id, "U1", undefined, { includeHistory: true });
    const lease = (await built.sessions.acquireLease(session.id)).lease as Lease;
    for (const payload of [
      { text: "from ada", speakerId: "U1" },
      { text: "from bo", speakerId: "U2" },
      { text: "from a stranger", speakerId: "U9" },
      { text: "again from ada", speakerId: "U1" },
    ]) {
      await built.sessions.append(lease, { type: "user", payload, scopeLabel: scope });
    }
    await built.sessions.append(lease, {
      type: "assistant",
      payload: { text: "noted", speakerId: "U1" },
      scopeLabel: scope,
    });
    await built.sessions.releaseLease(lease);

    const res = await fetch(`${base}/v1/sessions/${encodeURIComponent(session.id)}?viewer=U1`);
    assert.equal(res.status, 200);
    const { entries } = (await res.json()) as { entries: SessionEntry[] };
    assert.deepEqual(
      entries.map((e) => [e.type, (e.payload as { speakerAvatarUrl?: string }).speakerAvatarUrl]),
      [
        ["user", "https://example.com/ada.png"],
        ["user", undefined],
        ["user", undefined],
        ["user", "https://example.com/ada.png"],
        ["assistant", undefined],
      ],
      "only user entries get a photo, only from the directory, and only over https",
    );
    const stored = await built.sessions.getEntries(session.id);
    assert.ok(
      stored.every((e) => !("speakerAvatarUrl" in (e.payload as object))),
      "the photo is attached on read, never persisted",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
