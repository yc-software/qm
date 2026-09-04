import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILENAME, type QmConfig } from "../../src/config.ts";
import { runCli, tmp, rmDir, writeConfig } from "./harness.ts";

const manifest = (dir: string): string => readFileSync(join(dir, "slack-app-manifest.yml"), "utf8");

test("init → uncomment the scaffold's botName/orgName → check accepts → slack render brands the manifest", () => {
  const root = tmp("identity");
  const dir = join(root, "straylight-deploy");
  try {
    const initialized = runCli(["init", dir, "--org", "acme"]);
    assert.equal(initialized.code, 0, initialized.out);
    assert.match(manifest(dir), /name: qm\n/);
    assert.match(manifest(dir), /display_name: qm\n/);

    const cfgPath = join(dir, CONFIG_FILENAME);
    const scaffolded = readFileSync(cfgPath, "utf8");
    assert.match(scaffolded, /\/\/ "botName": /, "scaffold documents the botName knob");
    assert.match(scaffolded, /\/\/ "orgName": /, "scaffold documents the orgName knob");
    writeFileSync(
      cfgPath,
      scaffolded
        .replace(/\/\/ "botName": "[^"]*",/, '"botName": "straylight",')
        .replace(/\/\/ "orgName": "[^"]*",/, '"orgName": "Straylight Industries",'),
    );

    const checked = runCli(["check"], { cwd: dir });
    assert.equal(checked.code, 0, checked.out);

    assert.match(manifest(dir), /name: qm\n/, "the init-time manifest is stale until re-rendered");

    const rendered = runCli(["slack", "render"], { cwd: dir });
    assert.equal(rendered.code, 0, rendered.out);
    const branded = manifest(dir);
    assert.match(branded, /name: straylight\n/);
    assert.match(branded, /display_name: straylight\n/);
    assert.match(branded, /description: straylight workspace agent for acme\n/);
    assert.doesNotMatch(branded, /\bqm\b/);
  } finally {
    rmDir(root);
  }
});

test("outputs refuses a manifest that predates a botName change until slack render", () => {
  const dep = tmp("identity-outputs");
  const org = `qm-e2e-id-${process.pid}`;
  const services: QmConfig["services"] = ["core", "web-ui", "admin", "portal", "slack"];
  try {
    writeConfig(dep, { orgId: org, target: "docker", services });
    assert.equal(runCli(["slack", "render"], { cwd: dep }).code, 0);

    writeConfig(dep, { orgId: org, target: "docker", services, botName: "straylight" });
    const stale = runCli(["outputs"], { cwd: dep });
    assert.equal(stale.code, 1);
    assert.match(stale.out, /Slack manifests do not match the current configuration; run `qm slack render`/);

    assert.equal(runCli(["slack", "render"], { cwd: dep }).code, 0);
    const fresh = runCli(["outputs"], { cwd: dep });
    assert.equal(fresh.code, 0, fresh.out);
    assert.match(fresh.out, /straylight/);
  } finally {
    rmDir(dep);
  }
});
