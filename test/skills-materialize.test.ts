import { readdirSync, readFileSync } from "node:fs";
import { parseSeedSkill } from "../src/skills/seed.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CapabilityUnsupportedError, type Sandbox, type SandboxHandle } from "../src/sandbox/sandbox.ts";
import type { SkillFile, SkillResolution } from "../src/skills/skill-store.ts";
import {
  materializeSkillTree,
  rankedSkills,
  renderSkillBody,
  safeSkillDirName,
  skillsIndex,
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

const names = (index: string) => [...index.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]);

test("skills index lists every skill alphabetically, independent of the message and of use", () => {
  const skills = Array.from({ length: 20 }, (_, i) => res(`skill-${String(i).padStart(2, "0")}`, "body"));
  for (const r of skills) r.skill!.manifest.description = "General task";
  skills[19]!.skill!.manifest.description = "Prepare telescope observations";
  skills[18]!.skill!.lastUsedAt = Number.MAX_SAFE_INTEGER;
  const duplicate = structuredClone(skills[0]!);
  duplicate.skill!.manifest.description = "shadowed description";
  const visible = [...skills, duplicate, { skill: null, shadowed: [] }];
  const index = skillsIndex(visible, []);
  const shown = names(index);
  assert.equal(shown.length, 20);
  assert.deepEqual(shown.slice(0, 3), ["skill-00", "skill-01", "skill-02"]);
  assert.doesNotMatch(index, /shadowed description|lastUsedAt|shortened|omitted/);
  assert.match(index, /- \*\*skill-19\*\* — Prepare telescope observations/);
  assert.match(index, /skills action read/);
  assert.equal(rankedSkills(visible).length, 20);
  assert.deepEqual(
    rankedSkills(visible, "telescope", true).map((r) => r.skill!.manifest.name),
    ["skill-19"],
  );
  assert.deepEqual(rankedSkills(visible, "unmatched", true), []);
  assert.equal(skillsIndex([{ skill: null, shadowed: [] }]), "");
});

test("an index over budget shortens descriptions, then drops them, then leaves trailing skills out", () => {
  const skills = Array.from({ length: 30 }, (_, i) => {
    const r = res(`skill-${String(i).padStart(2, "0")}`, "body");
    r.skill!.manifest.description = `${"word ".repeat(40)}end`;
    return r;
  });
  const body = (index: string) => index.split("\n").slice(2);
  const full = skillsIndex(skills);
  assert.doesNotMatch(full, /shortened|omitted/);

  const shortened = skillsIndex(skills, [], 4_000);
  assert.ok(body(shortened).join("\n").length <= 4_000);
  assert.match(shortened, /30 descriptions are shortened/);
  assert.deepEqual(names(shortened), names(full));
  assert.ok(body(shortened).every((line) => /^- \*\*skill-\d+\*\* — word.*…$/.test(line)));

  const namesOnly = skillsIndex(skills, [], 1_000);
  assert.match(namesOnly, /Descriptions are omitted to fit the list\./);
  assert.deepEqual(names(namesOnly), names(full));
  assert.ok(body(namesOnly).every((line) => /^- \*\*skill-\d+\*\*$/.test(line)));

  const truncated = skillsIndex(skills, [], 200);
  assert.match(truncated, /and 17 skills are left out; find them with skills action search/);
  assert.deepEqual(names(truncated).slice(0, 2), ["skill-00", "skill-01"]);
  assert.equal(names(truncated).length, 13);
});

test("the bundled skills fit the default index budget with full descriptions", () => {
  const entries = readdirSync(new URL("../skills-seed/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const path = new URL(`../skills-seed/${entry.name}/SKILL.md`, import.meta.url);
      try {
        const manifest = parseSeedSkill(readFileSync(path, "utf8"));
        const result = res(manifest.name, manifest.body);
        result.skill!.manifest = manifest;
        return [result];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    });
  const index = skillsIndex(entries);
  assert.equal(names(index).length, entries.length);
  assert.match(index, /\*\*google-workspace\*\*/);
  assert.doesNotMatch(index, /shortened|omitted|left out/);
});
