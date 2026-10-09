import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { principalOf } from "./support/principal.ts";

async function withDefaultComputer(built: ReturnType<typeof buildApp>) {
  const owner = await principalOf(built, "U1");
  const computer = await built.sandboxResources.create(owner, `personal:${owner}`, "sprites", "default");
  await built.sandboxResources.setDefault(owner, `personal:${owner}`, computer.id);
  return built;
}

function freshApp() {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-skill-")),
  });
  return buildApp(config);
}

const actor = { externalId: "U1", provider: "slack" as const };

async function publishPersonalSkill(built: ReturnType<typeof buildApp>) {
  const { skills } = built;
  const owner = await principalOf(built, "U1");
  const sk = await skills.create({
    scopeId: scopeId("personal", owner),
    manifest: {
      name: "make-digest",
      description: "assemble a morning digest",
      requiredCapabilities: [],
      body: "# make-digest\nStep 1: gather. Step 2: summarize.",
    },
    createdBy: owner,
  });
  await skills.review(sk.id, "reviewer-1", []);
  await skills.publish(sk.id);
  return sk;
}

test("a published personal skill is advertised and loads in the owner's DM", async () => {
  const built = freshApp();
  const { app } = built;
  await publishPersonalSkill(built);

  const sys = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text: "!sysprompt",
  } as TurnRequest);
  assert.match(sys.reply ?? "", /## Skills/);
  assert.match(sys.reply ?? "", /make-digest/);

  const read = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:t2" },
    text: "!skill make-digest",
  } as TurnRequest);
  assert.match(read.reply ?? "", /Step 1: gather/);
});

test("a channel session does NOT see a personal skill (scope boundary)", async () => {
  const built = freshApp();
  const { app } = built;
  await publishPersonalSkill(built);
  const sys = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "channel", threadRef: "C1:t1", channelRef: "C1", audience: [actor] },
    text: "!sysprompt",
  } as TurnRequest);
  assert.doesNotMatch(sys.reply ?? "", /make-digest/);
});

test("ordinary sandbox work never touches the skills tree", async () => {
  const built = await withDefaultComputer(freshApp());
  const { app, sandbox } = built;
  await publishPersonalSkill(built);
  const touched: string[] = [];
  const read = sandbox.readFile.bind(sandbox);
  sandbox.readFile = async (handle, path) => {
    if (path.startsWith("skills/")) touched.push(path);
    return read(handle, path);
  };
  const write = sandbox.writeFile.bind(sandbox);
  sandbox.writeFile = async (handle, path, content) => {
    if (path.startsWith("skills/")) touched.push(path);
    return write(handle, path, content);
  };
  const remove = sandbox.removeDir.bind(sandbox);
  sandbox.removeDir = async (handle, path) => {
    if (path.startsWith("skills/")) touched.push(path);
    return remove(handle, path);
  };
  await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:no-sync" },
    text: "!read missing.txt",
  } as TurnRequest);
  assert.deepEqual(touched, []);
});

async function publishFileSkill(built: ReturnType<typeof buildApp>, name: string) {
  const { skills } = built;
  const owner = await principalOf(built, "U1");
  const sk = await skills.create({
    scopeId: scopeId("personal", owner),
    manifest: {
      name,
      description: `${name} ships a script`,
      requiredCapabilities: [],
      body: "run the script",
      files: [{ path: "scripts/run.sh", content: `printf ${name}` }],
    },
    createdBy: owner,
  });
  await skills.review(sk.id, "reviewer-1", []);
  await skills.publish(sk.id);
  return sk;
}

test("skill files stay on the computer across turns", async () => {
  const built = await withDefaultComputer(freshApp());
  const { app } = built;
  const first = await publishFileSkill(built, "helper");
  const request = {
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:archive" },
  };
  const ran = await app.turn({ ...request, text: "!skill-run helper cat {dir}/scripts/run.sh" } as TurnRequest);
  assert.equal(ran.reply, "printf helper");
  const next = await app.turn({ ...request, text: "!run find . -name run.sh | wc -l | tr -d ' '" } as TurnRequest);
  assert.equal(next.reply, "1");
  await built.skills.archive(first.id);
  assert.match((await app.turn({ ...request, text: "!skill helper" } as TurnRequest)).reply ?? "", /no skill file/);
});
