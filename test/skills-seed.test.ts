import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHmac } from "node:crypto";
import { parseSeedSkill, readSeedSkills, upsertSeedSkill } from "../src/skills/seed.ts";
import { materializeSkillTree } from "../src/skills/materialize.ts";
import { createSkillStore, safeSkillFilePath } from "../src/skills/skill-store.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { buildApp } from "./support/build-app.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { testAdvisoryLock, testMap } from "./support/test-database.ts";

test("seed skill parser reads the repo frontmatter subset", () => {
  const manifest = parseSeedSkill(`---
name: demo
description: demo skill
requiredCapabilities:
  - egress:example.com
  - command:demo
---

# Demo

Run the thing.
`);
  assert.equal(manifest.name, "demo");
  assert.equal(manifest.description, "demo skill");
  assert.deepEqual(manifest.requiredCapabilities, ["egress:example.com", "command:demo"]);
  assert.match(manifest.body, /^# Demo/);
});

const seeded = (dir: string) => {
  const catalog = readSeedSkills(dir, "system:skills-seed", "system:skills-reviewer");
  return createSkillStore({
    advisoryLock: testAdvisoryLock(),
    backing: testMap(),
    signingSecret: "seed-test-secret",
    catalog: { scopeId: scopeId("org", "default-org"), skills: () => catalog },
  });
};

test("the repository starter catalog is served published from org scope without per-tenant rows", async () => {
  const skills = seeded("skills-seed");
  const names = (await skills.list()).map((s) => s.manifest.name);
  for (const name of [
    "cloud-cli",
    "composio",
    "google-workspace",
    "google-drive-sheets",
    "github-gitlab",
    "send",
    "taste-skill",
    "use-shared-credential",
  ])
    assert.ok(names.includes(name), name);
  const github = (await skills.list()).find((s) => s.manifest.name === "github-gitlab")!;
  assert.equal(
    github.manifest.files?.find((file) => file.path === "scripts/watch-ci.mjs")?.content,
    readFileSync("skills-seed/github-gitlab/scripts/watch-ci.mjs", "utf8"),
  );
  const published = await skills.list();
  assert.ok(published.every((s) => s.status === "published" && s.scopeId === scopeId("org", "default-org")));
  assert.ok(published.every((s) => skills.verify(s)));
});

test("every licence shipped with a seed skill is MIT, and no tracked source carries Apache licence text", () => {
  const seedDir = "skills-seed";
  const licences: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const child = join(dir, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (/^(licen[cs]e|notice)\b/i.test(name)) licences.push(child);
    }
  };
  walk(seedDir);

  for (const path of licences) {
    const text = readFileSync(path, "utf8");
    assert.match(text, /MIT License/, `${path} must be MIT — a seed skill may only vendor MIT-compatible material`);
  }

  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const offenders = tracked.filter((path) => {
    if (path.endsWith("package-lock.json") || path === "test/skills-seed.test.ts") return false;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return false;
    }
    return text.includes(["Apache", " License"].join(""));
  });
  assert.deepEqual(offenders, [], "Apache-licensed material must not be vendored into this MIT repository");
});

function writeSeedSkill(dir: string, name: string, description: string, body: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

function writeSeedAsset(dir: string, name: string, relPath: string, content: string): void {
  const abs = join(dir, name, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

test("concurrent upserts of the same scope+name serialize into one record (no duplicate creates)", async () => {
  const skills = createSkillStore({
    advisoryLock: testAdvisoryLock(),
    backing: testMap(),
    signingSecret: "seed-test-secret",
  });
  const org = scopeId("org", "default-org");
  const upsert = (body: string) =>
    upsertSeedSkill(skills, {
      scopeId: org,
      manifest: { name: "racy", description: "raced", requiredCapabilities: [], body },
      createdBy: "system:skills-seed",
      reviewer: "system:skills-reviewer",
    });
  const outcomes = await Promise.all([upsert("# A"), upsert("# B"), upsert("# C")]);
  assert.equal(outcomes.filter((o) => o === "installed").length, 1);
  const records = (await skills.list()).filter((s) => s.scopeId === org && s.manifest.name === "racy");
  assert.equal(records.length, 1);
  assert.equal(records[0]!.status, "published");
});

test("a fresh app advertises and materializes only admin-enabled connector skills", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "seeded-skills-")),
  });
  const built = buildApp(config);
  await selectDefaultSandbox(built, "U1", scopeId("personal", "U1"));
  await built.config.setConnectorClient(scopeId("org", "default-org"), "google", {
    clientId: "google-client",
    clientSecret: "google-secret",
  });
  const { app } = built;
  const actor = { externalId: "U1" };
  const sys = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:seeded-skills" },
    text: "!sysprompt",
  } as TurnRequest);
  assert.match(sys.reply ?? "", /google-workspace/);
  assert.match(sys.reply ?? "", /google-drive-sheets/);
  assert.match(sys.reply ?? "", /github-gitlab/);
  assert.doesNotMatch(sys.reply ?? "", /^- (?:dropbox|linear|zoom) — /m);

  const channelSys = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "channel", channelRef: "C1", threadRef: "channel:C1:seeded-skills", audience: [actor] },
    text: "!sysprompt",
  } as TurnRequest);
  assert.match(channelSys.reply ?? "", /google-workspace/);
  assert.match(channelSys.reply ?? "", /google-drive-sheets/);
  assert.doesNotMatch(channelSys.reply ?? "", /^- (?:dropbox|linear|zoom) — /m);

  const read = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:seeded-skills-read" },
    text: "!skill google-workspace",
  } as TurnRequest);
  assert.match(read.reply ?? "", /Google Workspace/);
  assert.match(read.reply ?? "", /VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM/);
  assert.match(read.reply ?? "", /Authorization: Bearer/);

  const drive = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:seeded-drive-read" },
    text: "!skill google-drive-sheets",
  } as TurnRequest);
  assert.match(drive.reply ?? "", /Google Drive \/ Docs \/ Sheets \/ Slides/);
  assert.match(drive.reply ?? "", /sheets\.googleapis\.com/);
});

function fakeSandbox() {
  const files = new Map<string, string>();
  const sandbox = {
    async readFile(_h: SandboxHandle, rel: string) {
      return files.has(rel) ? files.get(rel)! : null;
    },
    async writeFile(_h: SandboxHandle, rel: string, data: string) {
      files.set(rel, data);
    },
    async removeDir(_h: SandboxHandle, rel: string) {
      for (const k of files.keys()) if (k === rel || k.startsWith(`${rel}/`)) files.delete(k);
    },
  } as unknown as Sandbox;
  return { sandbox, files };
}

test("a bundled skill round-trips seed → store → materialize, assets land beside SKILL.md", async () => {
  const org = scopeId("org", "default-org");
  const dir = mkdtempSync(join(tmpdir(), "seed-tree-"));
  writeSeedSkill(dir, "tooled", "a skill with helpers", "# Tooled\n\nRun scripts/hello.py.");
  writeSeedAsset(dir, "tooled", "scripts/hello.py", "print('hi')\n");
  writeSeedAsset(dir, "tooled", "references/notes.md", "# notes\n");
  writeSeedSkill(dir, "plain", "no helpers", "# Plain");
  const skills = seeded(dir);

  const tooled = (await skills.list()).find((s) => s.manifest.name === "tooled")!;
  assert.ok(skills.verify(tooled), "signature covers the bundled files");
  assert.deepEqual((tooled.manifest.files ?? []).map((f) => f.path).sort(), [
    "references/notes.md",
    "scripts/hello.py",
  ]);
  assert.equal((await skills.list()).find((s) => s.manifest.name === "plain")!.manifest.files?.length, 0);

  const { sandbox, files } = fakeSandbox();
  const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };
  const resolved = await skills.resolve("tooled", [org]);
  await materializeSkillTree(sandbox, handle, "skills", resolved);
  assert.equal(files.get("skills/tooled/SKILL.md"), tooled.manifest.body);
  assert.equal(files.get("skills/tooled/scripts/hello.py"), "print('hi')\n");
  assert.equal(files.get("skills/tooled/references/notes.md"), "# notes\n");
});

test("a tampered bundled asset fails skill verification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-tamper-"));
  writeSeedSkill(dir, "tooled", "a skill with helpers", "# Tooled");
  writeSeedAsset(dir, "tooled", "scripts/hello.py", "print('hi')\n");
  const skills = seeded(dir);

  const tooled = (await skills.list()).find((s) => s.manifest.name === "tooled")!;
  assert.ok(skills.verify(tooled));
  tooled.manifest.files![0]!.content = "import os; os.system('rm -rf /')\n";
  assert.equal(skills.verify(tooled), false, "a swapped asset is detected");
});

test("a text-only skill signs identically to the pre-files scheme (legacy signatures still verify)", async () => {
  const secret = "legacy-compat-secret";
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), backing: testMap(), signingSecret: secret });
  const org = scopeId("org", "default-org");
  const legacySig = createHmac("sha256", secret)
    .update(
      JSON.stringify({
        name: "legacy",
        description: "an old skill",
        requiredCapabilities: ["command:demo"],
        body: "# Legacy",
      }),
    )
    .digest("hex");
  const created = await skills.create({
    scopeId: org,
    manifest: { name: "legacy", description: "an old skill", requiredCapabilities: ["command:demo"], body: "# Legacy" },
    createdBy: "system:skills-seed",
  });
  assert.equal(created.signature, legacySig, "new sign() reproduces the old payload for a text-only skill");
  assert.ok(skills.verify(created), "an already-stored legacy signature still verifies");
});

test("safeSkillFilePath rejects traversal / absolute / dot segments", () => {
  assert.equal(safeSkillFilePath("scripts/foo.py"), "scripts/foo.py");
  assert.equal(safeSkillFilePath("./refs/x.md"), "refs/x.md");
  for (const bad of ["../escape", "scripts/../../etc/passwd", "/abs/path", "a/./b", "a/../b", ""]) {
    assert.throws(() => safeSkillFilePath(bad), /invalid skill file path/, `should reject ${JSON.stringify(bad)}`);
  }
});
