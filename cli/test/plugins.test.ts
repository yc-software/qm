import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlugins } from "../src/plugins.ts";
import type { QmConfig } from "../src/config.ts";

function makeConfig(plugins: QmConfig["plugins"]): QmConfig {
  return {
    contract: 1,
    orgId: "acme",
    publicUrl: "http://localhost:8080",
    target: "docker",
    services: ["core"],
    plugins,
    skills: [],
    env: {},
    imageOverrides: {},
    sandbox: { app: "acme-sandboxes" },
  };
}

function deployment(setup: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "qm-plugins-"));
  setup(dir);
  return dir;
}

function sourceFolder(dir: string, name: string, withDockerfile = true): void {
  mkdirSync(join(dir, "plugins", name), { recursive: true });
  if (withDockerfile) writeFileSync(join(dir, "plugins", name, "Dockerfile"), "FROM scratch\n");
}

test("a plugins/<name>/Dockerfile is auto-discovered as a source plugin (no config entry needed)", () => {
  const dir = deployment((d) => sourceFolder(d, "intercom"));
  try {
    const { plugins, errors } = discoverPlugins(dir, makeConfig([]));
    assert.deepEqual(errors, []);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]!.name, "intercom");
    assert.equal(plugins[0]!.kind, "source");
    assert.equal(plugins[0]!.dockerfile, join(dir, "plugins", "intercom", "Dockerfile"));
    assert.deepEqual(plugins[0]!.env, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a config entry attaches env to a source plugin", () => {
  const dir = deployment((d) => sourceFolder(d, "intercom"));
  try {
    const { plugins, errors } = discoverPlugins(
      dir,
      makeConfig([{ name: "intercom", env: { INTERCOM_REGION: "us" } }]),
    );
    assert.deepEqual(errors, []);
    assert.equal(plugins[0]!.kind, "source");
    assert.deepEqual(plugins[0]!.env, { INTERCOM_REGION: "us" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a config { name, image } is an image plugin", () => {
  const dir = deployment(() => {});
  try {
    const { plugins, errors } = discoverPlugins(dir, makeConfig([{ name: "linear", image: "ghcr.io/acme/linear:1" }]));
    assert.deepEqual(errors, []);
    assert.equal(plugins[0]!.kind, "image");
    assert.equal(plugins[0]!.image, "ghcr.io/acme/linear:1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a name that is BOTH a source folder and an image is an error", () => {
  const dir = deployment((d) => sourceFolder(d, "dup"));
  try {
    const { errors } = discoverPlugins(dir, makeConfig([{ name: "dup", image: "ghcr.io/x:1" }]));
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /both a source folder .* and an image/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a config entry that names neither an image nor a source folder is an error", () => {
  const dir = deployment(() => {});
  try {
    const { errors } = discoverPlugins(dir, makeConfig([{ name: "ghost" }]));
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /names neither an image nor a plugins\/ghost\/ source folder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plugins/<name>/ folder without a Dockerfile (and no image) is an error", () => {
  const dir = deployment((d) => sourceFolder(d, "halfbaked", false));
  try {
    const { errors } = discoverPlugins(dir, makeConfig([{ name: "halfbaked" }]));
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /has a plugins\/halfbaked\/ folder but no Dockerfile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a source plugin whose folder name is a reserved built-in (e.g. core) is an error, not run", () => {
  const dir = deployment((d) => sourceFolder(d, "core"));
  try {
    const { plugins, errors } = discoverPlugins(dir, makeConfig([]));
    assert.deepEqual(plugins, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /collides with a built-in container/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reserved-name rejection covers pg too", () => {
  const dir = deployment((d) => sourceFolder(d, "pg"));
  try {
    const { plugins, errors } = discoverPlugins(dir, makeConfig([]));
    assert.deepEqual(plugins, []);
    assert.match(errors[0]!, /collides with a built-in container/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a source plugin folder whose name isn't a lowercase DNS label is an error, not run", () => {
  const dir = deployment((d) => sourceFolder(d, "MyPlugin"));
  try {
    const { plugins, errors } = discoverPlugins(dir, makeConfig([]));
    assert.deepEqual(plugins, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /must be a lowercase DNS label/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare deployment with no plugins/ dir and no config plugins discovers nothing", () => {
  const dir = deployment(() => {});
  try {
    const { plugins, errors } = discoverPlugins(dir, makeConfig([]));
    assert.deepEqual(plugins, []);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
