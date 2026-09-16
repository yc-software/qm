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
  const publish = async (scopeId: string, body: string, packId?: string) => {
    const skill = await built.skills.create({
      scopeId,
      createdBy: "U1",
      ...(packId ? { pack: { packId, commit: "c", upstreamName: "source-helper" } } : {}),
      manifest: {
        name: "source-helper",
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
  assert.match(await b.turn("!sysprompt"), /skill:\/\/source-helper\/SKILL.md/);
  assert.equal(await b.turn("!read skill://source-helper/SKILL.md"), "PUBLISHED_BODY");
  assert.equal(await b.turn("!read skill://source-helper/references/example.txt"), "PUBLISHED_ASSET");
  assert.match(await b.turn("!read skill://source-helper/SKILL.md", "U2"), /no file/);
  await b.skills.archive(skill.id);
  assert.match(await b.turn("!read skill://source-helper/SKILL.md"), /no file/);
  assert.equal(b.provisions(), 0);
});

test("published skill reads reject invalid and control paths without provisioning", async (t) => {
  const b = await fixture(t);
  await b.publish("personal:U1", "PUBLISHED_BODY");
  for (const path of [
    "skill://missing/SKILL.md",
    "skill://source-helper/../SKILL.md",
    "skill://source-helper/.tree",
    "skill://../SKILL.md",
    "skill://source-helper//SKILL.md",
    "skill://source-helper/./SKILL.md",
    "skill://source-helper/references/../../secret",
    "skill://source-helper/%2e%2e/secret",
  ])
    assert.match(await b.turn(`!read ${path}`), /no file/, path);
  assert.equal(b.provisions(), 0);
});

test("published source follows scope shadowing and preserves sandbox-authored working copies", async (t) => {
  const b = await fixture(t);
  await b.publish("org:default-org", "ORG_BODY");
  const personal = await b.publish("personal:U1", "PERSONAL_BODY");
  assert.equal(await b.turn("!read skill://source-helper/SKILL.md"), "PERSONAL_BODY");
  assert.equal(b.provisions(), 0);
  await b.turn("!read skills/source-helper/SKILL.md");
  await b.turn("!write skills/source-helper/SKILL.md LOCAL_EDIT");
  assert.equal(await b.turn("!read skill://source-helper/SKILL.md"), "PERSONAL_BODY");
  assert.equal(await b.turn("!read skills/source-helper/SKILL.md"), "LOCAL_EDIT");
  await b.skills.archive(personal.id);
  assert.equal(await b.turn("!read skill://source-helper/SKILL.md"), "ORG_BODY");
});

test("a source-only read avoids sandbox work and a subsequent asset request materializes the current revision", async () => {
  const { createTurnSandboxes } = await import("../src/core/orchestrator/sandboxes.ts");
  const { createSkillMaterializer } = await import("../src/skills/materialize.ts");
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
    visibleSkills: [resolution],
    visibleSkillsForTurn: async () => [resolution],
    skillMaterializer: createSkillMaterializer(),
    emitGapWork: () => {},
    perf: { credsMs: 0 },
  } as unknown as TurnSandboxContext);
  assert.equal((await turn.readSkill("skill://source-helper/SKILL.md")).content, "BODY");
  assert.equal(provisions, 0);
  assert.equal(files.size, 0);
  resolution = structuredClone(resolution);
  resolution.skill!.manifest.files![0]!.content = "v2";
  assert.equal((await turn.readSkill("skill://source-helper/references/example.txt")).content, "v2");
  await turn.ensureSkillTree("source-helper");
  assert.equal(provisions, 1);
  assert.equal(files.get("skills/source-helper/references/example.txt"), "v2");
  files.set("skills/source-helper/references/example.txt", "local edit");
  await turn.provision();
  assert.equal(files.get("skills/source-helper/references/example.txt"), "local edit");
  resolution.skill!.pack = { packId: "pack", commit: "c", upstreamName: "source-helper" };
  resolution.screenedBundles = [
    { packId: "pack", commit: "c", hash: "pack-hash", files: [{ path: "lib.txt", content: "PACK_RESOURCE" }] },
  ];
  await turn.ensureSkillTree(".packs", "resource-1");
  assert.deepEqual(sandboxIds, [undefined, "resource-1"]);
  assert.equal(files.get("skills/.packs/pack/lib.txt"), "PACK_RESOURCE");
});

test("pack assets remain readable and executable on later turns after source-only reads", async (t) => {
  const { computeBundleHash } = await import("../src/skills/skill-bundle-store.ts");
  const b = await fixture(t);
  const skill = await b.publish("personal:U1", "PACK_BODY", "source-pack");
  const files = [{ path: "example.sh", content: "printf PACK_ASSET" }];
  await b.skillBundles.put({ packId: "source-pack", commit: "c", files, hash: computeBundleHash(files) });
  assert.match(await b.turn("!read skill://source-helper/SKILL.md"), /skills\/\.packs\/source-pack/);
  assert.equal(b.provisions(), 0);
  assert.equal(await b.turn("!run sh skills/.packs/source-pack/example.sh"), "PACK_ASSET");
  assert.equal(await b.turn("!read skills/.packs/source-pack/example.sh"), "printf PACK_ASSET");
  await b.skills.archive(skill.id);
  assert.match(await b.turn("!read skills/.packs/source-pack/example.sh"), /no file/);
});
