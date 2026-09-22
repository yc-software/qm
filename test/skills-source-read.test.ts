import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";

async function fixture(t: TestContext) {
  const built = buildApp(testConfig());
  await built.deploymentLayerReady;
  t.after(async () => {
    built.scheduler.stop();
    built.deploymentLayerRefresh.stop();
    await built.runtime.stop();
  });
  let provisions = 0;
  const provision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = async (...args) => {
    provisions++;
    return provision(...args);
  };
  const turn = async (text: string, actor = "U1") => {
    const result = await built.app.turn({
      surface: "test",
      actor: { externalId: actor },
      conversation: { kind: "dm", threadRef: `dm:${actor}:skill-source` },
      text,
    } as TurnRequest);
    assert.equal(result.status, "ok", JSON.stringify(result));
    return result.reply ?? "";
  };
  const publish = async (scopeId: string, body: string, packId?: string, name = "source-helper") => {
    const skill = await built.skills.create({
      scopeId,
      createdBy: "U1",
      ...(packId ? { pack: { packId, commit: "c", upstreamName: name } } : {}),
      manifest: {
        name,
        description: "source test",
        body,
        requiredCapabilities: [],
        files: [{ path: "references/example.txt", content: "PUBLISHED_ASSET" }],
      },
    });
    await built.skills.review(skill.id, "reviewer", []);
    await built.skills.publish(skill.id);
    return skill;
  };
  return { ...built, turn, publish, provisions: () => provisions };
}

test("published skill sources and assets read without a sandbox, respecting scope and archive", async (t) => {
  const b = await fixture(t);
  const skill = await b.publish("personal:U1", "PUBLISHED_BODY");
  assert.match(await b.turn("!sysprompt"), /\*\*source-helper\*\*/);
  assert.match(
    await b.turn("!skill source-helper"),
    /^\.agent-turn\/\w+\/[\w-]+\/skills\/source-helper\nPUBLISHED_BODY$/,
  );
  assert.match(await b.turn("!skill source-helper references/example.txt"), /\nPUBLISHED_ASSET$/);
  assert.equal(await b.turn("!skill-run source-helper cat {dir}/references/example.txt"), "PUBLISHED_ASSET");
  assert.match(await b.turn("!skill source-helper", "U2"), /no skill file/);
  await b.skills.archive(skill.id);
  assert.match(await b.turn("!skill source-helper"), /no skill file/);
  assert.equal(b.provisions(), 3);
});

test("a body-only skill loads without any sandbox work", async (t) => {
  const b = await fixture(t);
  const skill = await b.skills.create({
    scopeId: "personal:U1",
    createdBy: "U1",
    manifest: { name: "notes-only", description: "text only", body: "JUST_TEXT", requiredCapabilities: [] },
  });
  await b.skills.review(skill.id, "reviewer", []);
  await b.skills.publish(skill.id);
  assert.equal(await b.turn("!skill notes-only"), "JUST_TEXT");
  assert.equal(await b.turn("!run echo hi"), "hi");
  assert.equal(b.provisions(), 1);
});

test("published skill loads reject invalid and control paths without provisioning", async (t) => {
  const b = await fixture(t);
  await b.publish("personal:U1", "PUBLISHED_BODY");
  for (const [name, path] of [
    ["missing", "SKILL.md"],
    ["source-helper", "../SKILL.md"],
    ["source-helper", ".tree"],
    ["..", "SKILL.md"],
    ["source-helper", "/SKILL.md"],
    ["source-helper", "./SKILL.md"],
    ["source-helper", "references/../../secret"],
    ["source-helper", "%2e%2e/secret"],
  ])
    assert.match(await b.turn(`!skill ${name} ${path}`), /no skill file/, `${name}/${path}`);
  assert.equal(b.provisions(), 0);
});

test("published source follows scope shadowing and preserves sandbox-authored working copies", async (t) => {
  const b = await fixture(t);
  await b.publish("org:default-org", "ORG_BODY");
  const personal = await b.publish("personal:U1", "PERSONAL_BODY");
  assert.match(await b.turn("!skill source-helper"), /\nPERSONAL_BODY$/);
  await b.turn("!write skills/source-helper/SKILL.md LOCAL_EDIT");
  assert.match(await b.turn("!skill source-helper"), /\nPERSONAL_BODY$/);
  assert.equal(await b.turn("!read skills/source-helper/SKILL.md"), "LOCAL_EDIT");
  await b.skills.archive(personal.id);
  assert.match(await b.turn("!skill source-helper"), /\nORG_BODY$/);
});

test("a body read avoids sandbox work and a file request materializes that skill under the turn directory", async () => {
  const { createTurnSandboxes } = await import("../src/core/orchestrator/sandboxes.ts");
  type TurnSandboxContext = import("../src/core/orchestrator/sandboxes.ts").TurnSandboxContext;
  type SkillResolution = import("../src/skills/skill-store.ts").SkillResolution;
  const files = new Map<string, string>();
  let provisions = 0;
  const sandboxIds: Array<string | undefined> = [];
  let resolution = {
    skill: {
      id: "s",
      scopeId: "personal:U1",
      manifest: {
        name: "source-helper",
        body: "BODY",
        files: [{ path: "references/example.txt", content: "v1" }],
      },
    },
    shadowed: [],
  } as unknown as SkillResolution;
  const unrelated = structuredClone(resolution);
  unrelated.skill!.id = "other";
  unrelated.skill!.manifest.name = "unrelated";
  unrelated.skill!.pack = { packId: "other-pack", commit: "c", upstreamName: "unrelated" };
  const visible = [resolution, unrelated];
  const handle = { id: "box", rootDir: "/workspace" };
  const turn = createTurnSandboxes({
    deps: {
      skills: { recordUse: async () => {} },
      sandboxResources: { get: async () => ({ ownerScopeId: "personal:U1" }) },
      sandbox: {
        provision: async (_layers: unknown, options?: { sandboxId?: string }) => {
          sandboxIds.push(options?.sandboxId);
          provisions++;
          return handle;
        },
        listDir: async () => [],
        removeDir: async () => {},
        readFile: async (_handle: unknown, path: string) => files.get(path) ?? null,
        writeFile: async (_handle: unknown, path: string, content: string) => {
          files.set(path, content);
        },
      },
    },
    input: { origin: { kind: "human" } },
    actor: { id: "U1" },
    session: { id: "s" },
    resolution: { layers: [{ scopeId: "personal:U1", mountPath: "", mode: "rw" }] },
    scopeId: "personal:U1",
    memoryScopeId: "personal:U1",
    turnSessionDir: "turn/s",
    turnFilesDir: "turn/s/t",
    connectorEnv: {},
    ownerEnvCredentialIds: [],
    credentialCutoverServices: [],
    visibleSkillsForTurn: async () => visible,
    emitGapWork: () => {},
    perf: { credsMs: 0 },
  } as unknown as TurnSandboxContext);
  const bodyOnly = structuredClone(unrelated);
  bodyOnly.skill!.id = "body-only";
  bodyOnly.skill!.manifest.name = "body-only";
  bodyOnly.skill!.manifest.files = [];
  delete bodyOnly.skill!.pack;
  visible.push(bodyOnly);
  assert.deepEqual(await turn.useSkill("body-only", "SKILL.md"), { content: "BODY", sourceScopeId: "personal:U1" });
  await turn.provision();
  assert.equal(provisions, 1);
  assert.equal(files.size, 0);
  resolution = structuredClone(resolution);
  resolution.skill!.manifest.files![0]!.content = "v2";
  visible[0] = resolution;
  const loaded = await turn.useSkill("source-helper", "references/example.txt");
  assert.equal(loaded.content, "v2");
  assert.equal(loaded.dir, "turn/s/t/skills/source-helper");
  assert.equal(provisions, 1);
  assert.equal(files.get("turn/s/t/skills/source-helper/references/example.txt"), "v2");
  files.set("turn/s/t/skills/source-helper/references/example.txt", "local edit");
  await turn.useSkill("source-helper", "SKILL.md");
  assert.equal(files.get("turn/s/t/skills/source-helper/references/example.txt"), "local edit");
  resolution.skill!.pack = { packId: "pack", commit: "c", upstreamName: "source-helper" };
  resolution.screenedBundles = [
    { packId: "pack", commit: "c", hash: "pack-hash", files: [{ path: "lib.txt", content: "PACK_RESOURCE" }] },
  ];
  const beforeResource = new Map(files);
  await turn.provisionResource("resource-1");
  assert.deepEqual(files, beforeResource);
  const onResource = await turn.useSkill("source-helper", "SKILL.md", "resource-1");
  assert.equal(onResource.packDir, "turn/s/t/skills/.packs/pack");
  assert.deepEqual(sandboxIds, [undefined, "resource-1"]);
  assert.equal(files.get("turn/s/t/skills/.packs/pack/lib.txt"), "PACK_RESOURCE");
  assert.equal(
    [...files.keys()].some((path) => path.includes("/unrelated/")),
    false,
  );
});

test("pack assets run from the turn directory and vanish with it", async (t) => {
  const { computeBundleHash } = await import("../src/skills/skill-bundle-store.ts");
  const b = await fixture(t);
  const skill = await b.publish("personal:U1", "PACK_BODY", "source-pack");
  const files = [{ path: "example.sh", content: "printf PACK_ASSET" }];
  await b.skillBundles.put({ packId: "source-pack", commit: "c", files, hash: computeBundleHash(files) });
  assert.match(await b.turn("!skill source-helper"), /skills\/\.packs\/source-pack/);
  assert.equal(b.provisions(), 1);
  assert.equal(await b.turn("!skill-run source-helper sh {dir}/../.packs/source-pack/example.sh"), "PACK_ASSET");
  assert.equal(await b.turn("!run find . -name example.sh | wc -l | tr -d ' '"), "0");
  await b.skills.archive(skill.id);
  assert.match(await b.turn("!skill source-helper"), /no skill file/);
});
