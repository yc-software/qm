import test from "node:test";
import assert from "node:assert/strict";
import {
  createPersonalDefaultsService,
  materializePersonalWorkspaceDefaults,
  parseDefaultSkillTrees,
  PERSONAL_DEFAULT_CREATED_BY,
  safePersonalWorkspacePath,
  withPersonalWorkspaceDefaults,
  type PersonalDefaultFile,
} from "../src/personal-defaults.ts";
import { createSkillStore } from "../src/skills/skill-store.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId, type WorkspaceLayer } from "../src/types.ts";

const manifest = () =>
  parseDefaultSkillTrees(
    [
      {
        path: "starter/SKILL.md",
        content: "---\nname: starter\ndescription: Starter skill.\n---\nUse the starter workflow.\n",
      },
      { path: "starter/reference.md", content: "reference\n" },
    ],
    "personal default skill",
  )[0]!;

test("personal skill defaults install once and preserve edits and archives", async () => {
  const skills = createSkillStore({ signingSecret: "test" });
  const service = createPersonalDefaultsService({ skills, manifests: () => [manifest()] });
  const personal = scopeId("personal", "person@example.com");

  await Promise.all([service.ensure(personal), service.ensure(personal), service.ensure(personal)]);
  let stored = (await skills.list()).filter((skill) => skill.scopeId === personal);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.status, "published");
  assert.equal(stored[0]!.manifest.files?.[0]?.path, "reference.md");

  await skills.update(stored[0]!.id, { ...stored[0]!.manifest, body: "personally edited" });
  await service.ensure(personal);
  stored = (await skills.list()).filter((skill) => skill.scopeId === personal);
  assert.equal(stored[0]!.manifest.body, "personally edited");

  await skills.archive(stored[0]!.id);
  await createPersonalDefaultsService({ skills, manifests: () => [manifest()] }).ensure(personal);
  stored = (await skills.list()).filter((skill) => skill.scopeId === personal);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.status, "archived");

  await service.ensure(scopeId("channel", "general"));
  assert.equal((await skills.list()).length, 1);
});

test("personal skill defaults add newly introduced names without changing existing names", async () => {
  const skills = createSkillStore({ signingSecret: "test" });
  let manifests = [manifest()];
  const service = createPersonalDefaultsService({ skills, manifests: () => manifests });
  const personal = scopeId("personal", "person@example.com");

  await service.ensure(personal);
  const first = (await skills.list())[0]!;
  await skills.update(first.id, { ...first.manifest, body: "personal" });
  manifests = [
    manifest(),
    parseDefaultSkillTrees(
      [{ path: "second/SKILL.md", content: "---\nname: second\ndescription: Second skill.\n---\nSecond.\n" }],
      "personal default skill",
    )[0]!,
  ];
  await service.ensure(personal);

  const stored = (await skills.list()).filter((skill) => skill.scopeId === personal);
  assert.equal(stored.length, 2);
  assert.equal(stored.find((skill) => skill.manifest.name === "starter")?.manifest.body, "personal");
  assert.equal(stored.find((skill) => skill.manifest.name === "second")?.status, "published");
});

test("personal skill defaults repair an interrupted unpublished install", async () => {
  const skills = createSkillStore({ signingSecret: "test" });
  const personal = scopeId("personal", "person@example.com");
  const source = manifest();
  const draft = await skills.create({ scopeId: personal, manifest: source, createdBy: PERSONAL_DEFAULT_CREATED_BY });

  await createPersonalDefaultsService({ skills, manifests: () => [source] }).ensure(personal);
  assert.equal((await skills.get(draft.id))?.status, "published");
});

test("empty personal defaults do not acquire the fleet skill lock", async () => {
  const skills = createSkillStore({ signingSecret: "test" });
  let locks = 0;
  const service = createPersonalDefaultsService({
    skills,
    manifests: () => [],
    advisoryLock: {
      async withLock(_key, fn) {
        locks++;
        return fn();
      },
    },
  });

  await service.ensure(scopeId("personal", "person@example.com"));
  assert.equal(locks, 0);
});

function memorySandbox(files: Map<string, string>, runs: string[]): Sandbox {
  const handle: SandboxHandle = { id: "box", rootDir: "/root/workspace" };
  return {
    profile: { backend: "test", writablePersistence: "resident_disk", processSessions: false },
    async provision() {
      return handle;
    },
    async run(_handle, command) {
      runs.push(command);
      if (command.startsWith("[ -e ")) {
        const path = command.match(/\[ -e '([^']+)' \]/)?.[1];
        return { stdout: "", stderr: "", code: path && files.has(path) ? 0 : 1, timedOut: false };
      }
      if (command.startsWith("node -e ")) {
        const args = [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
        const source = args.at(-2)!;
        const destination = args.at(-1)!;
        if (files.has(destination)) return { stdout: "", stderr: "exists", code: 1, timedOut: false };
        files.set(destination, files.get(source) ?? "");
        files.delete(source);
      }
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
    async readFile(_handle, path) {
      return files.get(path) ?? null;
    },
    async writeFile(_handle, path, data) {
      files.set(path, data);
    },
    async writeFileBytes(_handle, path, data) {
      files.set(path, Buffer.from(data).toString("utf8"));
    },
    async readFileBytes(_handle, path) {
      const value = files.get(path);
      return value === undefined ? null : Buffer.from(value);
    },
    async listDir() {
      return [];
    },
    async removeDir() {},
    async teardown() {},
  };
}

test("personal workspace defaults write missing files and preserve existing content", async () => {
  const files = new Map([["AGENTS.md", "personal\n"]]);
  const runs: string[] = [];
  const sandbox = memorySandbox(files, runs);
  await materializePersonalWorkspaceDefaults(sandbox, { id: "box", rootDir: "/root/workspace" }, [
    { path: "AGENTS.md", content: "default\n" },
    { path: ".claude/hooks/guard.mjs", content: "guard\n", executable: true },
  ]);

  assert.equal(files.get("AGENTS.md"), "personal\n");
  assert.equal(files.get(".claude/hooks/guard.mjs"), "guard\n");
  assert.ok(runs.some((command) => /chmod \+x/.test(command)));
  assert.ok(runs.some((command) => /O_NOFOLLOW/.test(command) && /\/proc\/self\/fd/.test(command)));
});

test("sandbox wrapper seeds personal scopes lazily and skips scratch and shared scopes", async () => {
  const files = new Map<string, string>();
  const runs: string[] = [];
  const base = memorySandbox(files, runs);
  let defaults: PersonalDefaultFile[] = [{ path: "AGENTS.md", content: "default\n" }];
  const sandbox = withPersonalWorkspaceDefaults(base, () => defaults);
  const personal: WorkspaceLayer[] = [
    { scopeId: scopeId("personal", "person@example.com"), mode: "rw", mountPath: "" },
  ];

  await sandbox.provision(personal, { personalDefaults: true });
  assert.equal(files.get("AGENTS.md"), "default\n");
  files.set("AGENTS.md", "personal\n");
  defaults = [...defaults, { path: "config/personal.yaml", content: "enabled: false\n" }];
  await sandbox.provision(personal, { personalDefaults: true });
  assert.equal(files.get("AGENTS.md"), "personal\n");
  assert.equal(files.get("config/personal.yaml"), "enabled: false\n");

  files.clear();
  await sandbox.provision(personal, { scratch: { key: "scratch" } });
  assert.equal(files.size, 0);
  await sandbox.provision(personal, { personalDefaults: false });
  assert.equal(files.size, 0);
  await sandbox.provision([{ scopeId: scopeId("channel", "general"), mode: "rw", mountPath: "" }]);
  assert.equal(files.size, 0);
});

test("sandbox wrapper tears down a provisioned computer when default materialization fails", async () => {
  const files = new Map<string, string>();
  const base = memorySandbox(files, []);
  let teardowns = 0;
  const failing: Sandbox = {
    ...base,
    async writeFile() {
      throw new Error("write failed");
    },
    async teardown() {
      teardowns++;
    },
  };
  const sandbox = withPersonalWorkspaceDefaults(failing, () => [{ path: "AGENTS.md", content: "default\n" }]);

  await assert.rejects(
    sandbox.provision([{ scopeId: scopeId("personal", "person@example.com"), mode: "rw", mountPath: "" }], {
      personalDefaults: true,
    }),
    /write failed/,
  );
  assert.equal(teardowns, 1);
});

test("personal workspace paths reject absolute and traversal paths", () => {
  assert.equal(safePersonalWorkspacePath(".claude/settings.json"), ".claude/settings.json");
  assert.throws(() => safePersonalWorkspacePath("../secret"), /invalid personal workspace path/);
  assert.throws(() => safePersonalWorkspacePath("/root/secret"), /invalid personal workspace path/);
  assert.throws(() => safePersonalWorkspacePath("C:/secret"), /invalid personal workspace path/);
});
