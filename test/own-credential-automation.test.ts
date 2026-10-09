import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { credentialHandle } from "../src/credentials/keychain.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { installGlobalFakeSprites, type FakeSprites } from "./support/fake-sprites.ts";
import { testConfig } from "./support/test-config.ts";
import { selectLiteralDefaultSandbox } from "./support/default-sandbox.ts";

let ff: FakeSprites;
before(() => {
  ff = installGlobalFakeSprites();
});
beforeEach(() => ff.reset());
after(() => ff.cleanup());

const actor = { externalId: "U1" };

async function setup() {
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "own-cred-automation-")), signingSecret: "own-cred-test" }),
  );
  await selectLiteralDefaultSandbox(built, "U1", scopeId("personal", "U1"), scopeId("channel", "C1"));
  const credential = await built.keychain!.save({
    ownerId: "U1",
    service: "aws",
    files: [{ path: ".aws/sso/cache/session.json", contentBase64: Buffer.from("own-login").toString("base64") }],
  });
  const read = `!execute ${JSON.stringify({
    command: 'cat "$HOME/.aws/sso/cache/session.json"',
    credentials: [credentialHandle(credential.id)],
  })}`;
  return { built, read };
}

test("a scheduled turn in the owner's DM uses the owner's credential without a grant", async () => {
  const { built, read } = await setup();
  const fired = await built.app.turn({
    surface: "cron",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron" },
    text: read,
    triggered: true,
  } as TurnRequest);
  assert.equal(fired.status, "ok", fired.reason);
  assert.match(fired.reply ?? "", /own-login/);
  assert.equal((await built.keychain!.listGrants({ ownerId: "U1" })).length, 0);
});

test("a subagent of the owner's DM uses the owner's credential without a grant", async () => {
  const { built, read } = await setup();
  const personal = scopeId("personal", "U1");
  const parent = await built.sessions.getOrCreateByThread("dm:U1:parent", "dm", personal);
  const child = await built.sessions.getOrCreateByThread("agent:main:subagent:own-cred", "dm", personal);
  const conversation = {
    kind: "dm" as const,
    threadRef: "dm:U1:parent",
    audience: [{ id: "U1", type: "internal" as const }],
  };
  await built.sessions.setParentSession(child.id, parent.id);
  await built.sessions.addParticipant(child.id, "U1");
  await built.sessions.setSpawnMeta(child.id, { surface: "web", actor: { id: "U1", type: "internal" }, conversation });
  const result = await built.app.turn({
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: child.threadRef },
    text: read,
    triggered: true,
  } as TurnRequest);
  assert.equal(result.status, "ok", result.reason);
  assert.match(result.reply ?? "", /own-login/);
  assert.equal((await built.keychain!.listGrants({ ownerId: "U1" })).length, 0);
});

test("a scheduled turn in a shared channel cannot use the owner's credential without a grant", async () => {
  const { built, read } = await setup();
  await assert.rejects(
    built.app.turn({
      surface: "cron",
      actor,
      conversation: { kind: "channel", threadRef: "ch:C1:cron", channelRef: "C1", audience: [actor] },
      text: read,
      triggered: true,
    } as TurnRequest),
    /credential handle is not available/,
  );
});
