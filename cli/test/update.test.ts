import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, runUpdate } from "../src/commands/update.ts";
import { cliPackageName } from "../src/manifest.ts";

test("version comparison handles stable, prerelease, and newer major releases", () => {
  assert.equal(compareVersions("0.1.9", "0.1.10"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

function fixture(
  current: string,
  latest: string,
): {
  dir: string;
  configPath: string;
  sandboxDir: string;
  logPath: string;
  npm: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "qm-update-"));
  const configPath = join(dir, "qm.config.jsonc");
  const sandboxDir = join(dir, "sandbox");
  const logPath = join(dir, "npm.log");
  const npm = join(dir, "npm-fake.mjs");
  const packageName = cliPackageName();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [packageName]: current } }, null, 2),
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
      plugins: [],
      skills: [],
      env: {},
      imageOverrides: {},
      sandbox: { app: "acme-sandboxes", image: `example.invalid/sandbox@sha256:${"a".repeat(64)}` },
    }),
  );
  mkdirSync(sandboxDir);
  writeFileSync(
    npm,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.UPDATE_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "view") console.log(process.env.UPDATE_METADATA);
if (args[0] === "install") {
  const path = join(process.cwd(), "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.dependencies[${JSON.stringify(packageName)}] = args.at(-1).split("@").at(-1);
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\\n");
}
`,
  );
  chmodSync(npm, 0o755);
  process.env.NPM_BIN = npm;
  process.env.UPDATE_LOG = logPath;
  process.env.UPDATE_METADATA = JSON.stringify({
    time: { [current]: "2020-01-01T00:00:00.000Z", [latest]: "2020-02-01T00:00:00.000Z" },
    versions: [...new Set([current, latest])],
    "dist-tags": { latest },
  });
  return { dir, configPath, sandboxDir, logPath, npm };
}

function invocations(logPath: string): string[][] {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function clean(dir: string): void {
  delete process.env.NPM_BIN;
  delete process.env.UPDATE_LOG;
  delete process.env.UPDATE_METADATA;
  rmSync(dir, { recursive: true, force: true });
}

test("update without --yes reports availability without modifying the deployment", () => {
  const f = fixture("0.1.9", "0.2.0");
  try {
    runUpdate({ ...f, configDir: f.dir, target: "fly", yes: false });
    assert.deepEqual(invocations(f.logPath), [["view", cliPackageName(), "time", "versions", "dist-tags", "--json"]]);
    const pkg = JSON.parse(readFileSync(join(f.dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies[cliPackageName()], "0.1.9");
  } finally {
    clean(f.dir);
  }
});

test("registry failures are reported as CLI errors", () => {
  const f = fixture("0.1.9", "0.2.0");
  process.env.NPM_BIN = join(f.dir, "missing-npm");
  try {
    assert.throws(() => runUpdate({ ...f, configDir: f.dir, target: "fly", yes: false }), /failed/);
  } finally {
    clean(f.dir);
  }
});

test("the CLI dispatches update from a deployment directory", () => {
  const f = fixture("0.1.9", "0.2.0");
  try {
    const result = spawnSync(process.execPath, [new URL("../bin/qm.ts", import.meta.url).pathname, "update"], {
      cwd: f.dir,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /QM 0\.1\.9 → 0\.2\.0/);
    assert.deepEqual(invocations(f.logPath), [["view", cliPackageName(), "time", "versions", "dist-tags", "--json"]]);
  } finally {
    clean(f.dir);
  }
});

test("the CLI validates an exact release without installing or deploying it", () => {
  const f = fixture("0.1.9", "0.2.0");
  try {
    const result = spawnSync(
      process.execPath,
      [new URL("../bin/qm.ts", import.meta.url).pathname, "update", "--version", "0.2.0"],
      {
        cwd: f.dir,
        encoding: "utf8",
        env: process.env,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /QM 0\.1\.9 → 0\.2\.0/);
    assert.deepEqual(invocations(f.logPath), [["view", cliPackageName(), "time", "versions", "dist-tags", "--json"]]);
  } finally {
    clean(f.dir);
  }
});

test("update --yes installs an exact release and deploys it with relocated paths", () => {
  const f = fixture("0.1.9", "0.2.0");
  const envFile = join(f.dir, "runtime.env");
  writeFileSync(envFile, "");
  try {
    runUpdate({ ...f, configDir: f.dir, envFile, target: "fly", yes: true });
    assert.deepEqual(invocations(f.logPath), [
      ["view", cliPackageName(), "time", "versions", "dist-tags", "--json"],
      ["install", "--save-exact", `${cliPackageName()}@0.2.0`],
      ["exec", "qm", "--", "up", "--config", f.configPath, "--sandbox-dir", f.sandboxDir, "--env-file", envFile],
    ]);
  } finally {
    clean(f.dir);
  }
});

test("update --yes redeploys an already-pinned AWS release with its confirmation flag", () => {
  const f = fixture("0.2.0", "0.2.0");
  try {
    runUpdate({ ...f, configDir: f.dir, target: "aws", yes: true });
    assert.deepEqual(invocations(f.logPath), [
      ["view", cliPackageName(), "time", "versions", "dist-tags", "--json"],
      ["exec", "qm", "--", "up", "--config", f.configPath, "--sandbox-dir", f.sandboxDir, "--yes"],
    ]);
  } finally {
    clean(f.dir);
  }
});

test("update rejects a requested release still inside the cooldown", () => {
  const f = fixture("0.1.9", "0.2.0");
  process.env.UPDATE_METADATA = JSON.stringify({
    time: { "0.1.9": "2020-01-01T00:00:00.000Z", "0.2.0": "2026-09-01T00:00:00.000Z" },
    versions: ["0.1.9", "0.2.0"],
    "dist-tags": { latest: "0.2.0" },
  });
  try {
    assert.throws(
      () =>
        runUpdate({
          ...f,
          configDir: f.dir,
          target: "fly",
          yes: true,
          version: "0.2.0",
          now: Date.parse("2026-09-02T00:00:00.000Z"),
        }),
      /not an eligible stable release/,
    );
  } finally {
    clean(f.dir);
  }
});

test("update installs the requested eligible pin instead of a newer eligible release", () => {
  const f = fixture("0.1.9", "0.3.0");
  process.env.UPDATE_METADATA = JSON.stringify({
    time: {
      "0.1.9": "2020-01-01T00:00:00.000Z",
      "0.2.0": "2020-02-01T00:00:00.000Z",
      "0.3.0": "2020-03-01T00:00:00.000Z",
    },
    versions: ["0.1.9", "0.2.0", "0.3.0"],
    "dist-tags": { latest: "0.3.0" },
  });
  try {
    runUpdate({ ...f, configDir: f.dir, target: "fly", yes: true, version: "0.2.0" });
    assert.deepEqual(invocations(f.logPath)[1], ["install", "--save-exact", `${cliPackageName()}@0.2.0`]);
  } finally {
    clean(f.dir);
  }
});

test("update accepts a release at exactly the seven-day boundary", () => {
  const f = fixture("0.1.9", "0.2.0");
  const now = Date.parse("2026-09-02T00:00:00.000Z");
  process.env.UPDATE_METADATA = JSON.stringify({
    time: {
      "0.1.9": "2020-01-01T00:00:00.000Z",
      "0.2.0": new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
    versions: ["0.1.9", "0.2.0"],
    "dist-tags": { latest: "0.2.0" },
  });
  try {
    runUpdate({ ...f, configDir: f.dir, target: "fly", yes: true, version: "0.2.0", now });
    assert.deepEqual(invocations(f.logPath)[1], ["install", "--save-exact", `${cliPackageName()}@0.2.0`]);
  } finally {
    clean(f.dir);
  }
});

test("update refuses a requested release older than the current pin before touching the deployment", () => {
  const f = fixture("0.3.0", "0.3.0");
  process.env.UPDATE_METADATA = JSON.stringify({
    time: { "0.2.0": "2020-02-01T00:00:00.000Z", "0.3.0": "2020-03-01T00:00:00.000Z" },
    versions: ["0.2.0", "0.3.0"],
    "dist-tags": { latest: "0.3.0" },
  });
  try {
    assert.throws(
      () => runUpdate({ ...f, configDir: f.dir, target: "fly", yes: true, version: "0.2.0" }),
      /older than the deployment's current 0\.3\.0 pin/,
    );
    assert.deepEqual(invocations(f.logPath), [["view", cliPackageName(), "time", "versions", "dist-tags", "--json"]]);
  } finally {
    clean(f.dir);
  }
});

test("update without --yes reports an already-current pin without modifying the deployment", () => {
  const f = fixture("0.2.0", "0.2.0");
  try {
    runUpdate({ ...f, configDir: f.dir, target: "fly", yes: false });
    assert.deepEqual(invocations(f.logPath), [["view", cliPackageName(), "time", "versions", "dist-tags", "--json"]]);
    const pkg = JSON.parse(readFileSync(join(f.dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies[cliPackageName()], "0.2.0");
  } finally {
    clean(f.dir);
  }
});
