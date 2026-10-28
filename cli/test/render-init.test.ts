import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfigAt } from "../src/config.ts";
import { runChecks } from "../src/commands/check.ts";

const cli = fileURLToPath(new URL("../bin/qm.ts", import.meta.url));

test("qm init --target render creates a deployment from the selected Git source", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-render-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "init",
      dir,
      "--org",
      "acme",
      "--target",
      "render",
      "--repo",
      "https://github.com/acme/qm",
      "--branch",
      "main",
    ],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const config = loadConfigAt(join(dir, "qm.config.jsonc")).config;
  assert.deepEqual(config.render!.source, { repo: "https://github.com/acme/qm", branch: "main" });
  assert.equal(config.sandbox!.backend, "render");
  assert.ok(existsSync(join(dir, ".codex", "skills", "deploy-qm", "references", "render.md")));
  assert.doesNotMatch(readFileSync(join(dir, ".env"), "utf8"), /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)=/m);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /^RENDER_API_KEY=$/m);
  const { layer } = runChecks(config, dir, join(dir, "sandbox"), { report: false });
  assert.deepEqual(layer.errors, []);
  assert.equal(layer.skills.find((skill) => skill.dir === "render-platform")?.frontmatter.name, "render-platform");
});

test("qm init rejects a Render deployment without a Git source before writing files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qm-render-source-required-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "deployment");
  const result = spawnSync(process.execPath, [cli, "init", dir, "--target", "render"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--target render requires --repo and --branch/);
  assert.equal(existsSync(dir), false);
});

test("qm init stores the selected Render Git source and rejects partial source flags", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qm-render-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "deployment");
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "init",
      dir,
      "--org",
      "acme",
      "--target",
      "render",
      "--repo",
      "https://github.com/acme/qm",
      "--branch",
      "feature/render",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(loadConfigAt(join(dir, "qm.config.jsonc")).config.render!.source, {
    repo: "https://github.com/acme/qm",
    branch: "feature/render",
  });
  const invalid = join(root, "invalid");
  const rejected = spawnSync(
    process.execPath,
    [cli, "init", invalid, "--target", "render", "--repo", "https://github.com/acme/qm"],
    { encoding: "utf8" },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /--repo and --branch must be given together/);
  assert.equal(existsSync(invalid), false);
});
