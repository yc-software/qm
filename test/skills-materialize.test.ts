import { test } from "node:test";
import assert from "node:assert/strict";
import { CapabilityUnsupportedError, type Sandbox, type SandboxHandle } from "../src/sandbox/sandbox.ts";
import type { SkillFile, SkillResolution } from "../src/skills/skill-store.ts";
import {
  materializeSkillTree,
  renderSkillBody,
  safeSkillDirName,
  skillTreeFingerprint,
} from "../src/skills/materialize.ts";
import { computeBundleHash, type SkillBundle } from "../src/skills/skill-bundle-store.ts";

const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };
const root = ".agent-turn/t1/skills";

function res(name: string, body: string, files: SkillFile[] = [], packId?: string): SkillResolution {
  return {
    skill: {
      manifest: { name, body, files },
      ...(packId ? { pack: { packId, commit: "c", upstreamName: name } } : {}),
    },
    shadowed: [],
  } as unknown as SkillResolution;
}

function bundle(packId: string, files: SkillFile[]): SkillBundle {
  return { packId, commit: "c", files, hash: computeBundleHash(files) };
}

function fakeSandbox() {
  const files = new Map<string, string>();
  const sandbox = {
    async writeFile(_h: SandboxHandle, rel: string, data: string) {
      files.set(rel, data);
    },
  } as unknown as Sandbox;
  return { sandbox, files };
}

test("materialized skill directory names are validated and never lossy", () => {
  assert.equal(safeSkillDirName("popular-web-designs"), "popular-web-designs");
  assert.throws(() => safeSkillDirName("../evil"));
  assert.throws(() => safeSkillDirName("a/b"));
});

test("materializeSkillTree lays SKILL.md and assets under the turn root", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillTree(
    sandbox,
    handle,
    root,
    res("gamma", "G", [
      { path: "scripts/hello.py", content: "print('hi')", executable: true },
      { path: "references/notes.md", content: "# notes" },
    ]),
  );
  assert.equal(files.get(`${root}/gamma/SKILL.md`), "G");
  assert.equal(files.get(`${root}/gamma/scripts/hello.py`), "print('hi')");
  assert.equal(files.get(`${root}/gamma/references/notes.md`), "# notes");
});

test("renderSkillBody rewrites the skill's own skills/<name>/ paths to the turn root", () => {
  const r = res("gamma", "Run python3 skills/gamma/scripts/hello.py, not skills/other/x.py");
  assert.equal(renderSkillBody(r, root), `Run python3 ${root}/gamma/scripts/hello.py, not skills/other/x.py`);
  assert.equal(renderSkillBody(r), "Run python3 skills/gamma/scripts/hello.py, not skills/other/x.py");
});

test("unsafe asset paths are skipped rather than escaping the skill directory", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillTree(
    sandbox,
    handle,
    root,
    res("gamma", "G", [
      { path: "../escape.txt", content: "nope" },
      { path: "ok.txt", content: "yes" },
    ]),
  );
  assert.deepEqual([...files.keys()].sort(), [`${root}/gamma/SKILL.md`, `${root}/gamma/ok.txt`]);
});

test("materializeSkillTree confines a pack's shared bundle below its pack root", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, root, res("gmail", "G", [], "s1"), [
    bundle("s1", [
      { path: "lib/cite.mjs", content: "cite" },
      { path: "skills/conventions/quality.md", content: "q" },
    ]),
  ]);
  assert.match(files.get(`${root}/gmail/SKILL.md`) ?? "", new RegExp(`${root}/\\.packs/s1`));
  assert.equal(files.get(`${root}/.packs/s1/lib/cite.mjs`), "cite");
  assert.equal(files.get(`${root}/.packs/s1/skills/conventions/quality.md`), "q");
  assert.equal(files.get("lib/cite.mjs"), undefined);
});

test("a router-advertised importFiles the handle's backend refuses falls back to per-file writes", async () => {
  const { sandbox, files } = fakeSandbox();
  (sandbox as unknown as { importFiles: Sandbox["importFiles"] }).importFiles = async () => {
    throw new CapabilityUnsupportedError("local", "importFiles");
  };
  await materializeSkillTree(
    sandbox,
    handle,
    root,
    res("delta", "D", [
      { path: "a.py", content: "A" },
      { path: "b.py", content: "B" },
    ]),
  );
  assert.equal(files.get(`${root}/delta/a.py`), "A");
  assert.equal(files.get(`${root}/delta/b.py`), "B");
});

test("materializeSkillTree uses importFiles in one batch when the backend offers it", async () => {
  const { sandbox, files } = fakeSandbox();
  let batches = 0;
  (sandbox as unknown as { importFiles: Sandbox["importFiles"] }).importFiles = async (_h, entries) => {
    batches++;
    for (const e of entries) files.set(e.path, Buffer.from(e.data).toString("utf8"));
  };
  await materializeSkillTree(
    sandbox,
    handle,
    root,
    res("gamma", "G", [
      { path: "a.py", content: "A" },
      { path: "b.py", content: "B" },
    ]),
  );
  assert.equal(batches, 1);
  assert.equal(files.get(`${root}/gamma/a.py`), "A");
});

test("text assets get the same path rewrite as the body and cannot shadow SKILL.md", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillTree(
    sandbox,
    handle,
    root,
    res("gamma", "G", [
      { path: "references/how.md", content: "see skills/gamma/scripts/run.sh" },
      { path: "SKILL.md", content: "forged" },
    ]),
  );
  assert.equal(files.get(`${root}/gamma/references/how.md`), `see ${root}/gamma/scripts/run.sh`);
  assert.equal(files.get(`${root}/gamma/SKILL.md`), "G");
});

test("a pack bundle may ship a root SKILL.md of its own", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, root, res("gmail", "G", [], "s1"), [
    bundle("s1", [{ path: "SKILL.md", content: "pack readme" }]),
  ]);
  assert.equal(files.get(`${root}/.packs/s1/SKILL.md`), "pack readme");
});

test("skill recovery fingerprints include scripts and packs but ignore usage timestamps", () => {
  const original = res("helper", "body", [{ path: "run.sh", content: "echo original" }], "pack");
  const pack = bundle("pack", [{ path: "shared.sh", content: "echo shared" }]);
  const fingerprint = skillTreeFingerprint(original, [pack]);
  original.skill!.lastUsedAt = Date.now();
  assert.equal(skillTreeFingerprint(original, [pack]), fingerprint);
  const changed = structuredClone(original);
  changed.skill!.manifest.files![0]!.content = "echo changed";
  assert.notEqual(skillTreeFingerprint(changed, [pack]), fingerprint);
  const changedPack = structuredClone(pack);
  changedPack.files[0]!.content = "echo changed";
  assert.notEqual(skillTreeFingerprint(original, [changedPack]), fingerprint);
});
