import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLayerToolInstaller,
  layerToolContentSha,
  layerToolProbeScript,
  type LayerToolInstallIo,
} from "../src/sandbox/layer-tool-install.ts";
import type { LayerInstallFile } from "../src/deployment/load-layer.ts";

const SCRIPT = "#!/usr/bin/env node\nconsole.log('hi');\n";
const LIB = "export const x = 1;\n";
const FILES: LayerInstallFile[] = [
  { to: "/usr/local/bin/acme", mode: "0755", content: SCRIPT },
  { to: "/usr/local/lib/acme/lib.mjs", mode: "0644", content: LIB },
];
const probeFor = (files: readonly LayerInstallFile[]) =>
  layerToolProbeScript(files.map((f) => ({ to: f.to, mode: f.mode, sha: layerToolContentSha(f.content) })));

interface FakeIo extends LayerToolInstallIo {
  scripts: string[];
  writes: Array<{ abs: string; data: string }>;
}

function fakeIo(codes: { probe: number; verify?: number }, files: readonly LayerInstallFile[] = FILES): FakeIo {
  const scripts: string[] = [];
  const writes: Array<{ abs: string; data: string }> = [];
  const probe = probeFor(files);
  return {
    scripts,
    writes,
    async exec(script: string) {
      scripts.push(script);
      if (script === probe) return { code: codes.probe, stdout: "", stderr: "" };
      if (script.includes("chmod")) return { code: codes.verify ?? 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    async writeAbs(abs: string, data: Uint8Array) {
      writes.push({ abs, data: Buffer.from(data).toString("utf8") });
    },
  };
}

test("the probe checks every file's content hash and the exec bit only where the mode grants one", () => {
  const probe = probeFor(FILES);
  assert.ok(probe.startsWith("printf '%s\\n' "));
  assert.ok(probe.includes(`${layerToolContentSha(SCRIPT)}  /usr/local/bin/acme`));
  assert.ok(probe.includes(`${layerToolContentSha(LIB)}  /usr/local/lib/acme/lib.mjs`));
  assert.ok(probe.includes("| sha256sum -c --status && [ -x '/usr/local/bin/acme' ]"));
  assert.ok(!probe.includes("[ -x '/usr/local/lib/acme/lib.mjs' ]"));
});

test("a machine that already matches costs one probe and no transfer", async () => {
  const install = createLayerToolInstaller(() => FILES);
  const io = fakeIo({ probe: 0 });
  await install(io);
  assert.deepEqual(io.scripts, [probeFor(FILES)]);
  assert.deepEqual(io.writes, []);
});

test("a stale machine gets every file staged under a shared nonce, chmodded, moved atomically, and re-probed", async () => {
  const install = createLayerToolInstaller(() => FILES);
  const io = fakeIo({ probe: 1 });
  await install(io);
  assert.equal(io.writes.length, 2);
  const [bin, lib] = io.writes;
  assert.match(bin!.abs, /^\/usr\/local\/bin\/acme\.staged-[0-9a-f]{8}$/);
  const nonce = bin!.abs.slice(-8);
  assert.equal(lib!.abs, `/usr/local/lib/acme/lib.mjs.staged-${nonce}`);
  assert.equal(bin!.data, SCRIPT);
  assert.equal(lib!.data, LIB);
  assert.equal(io.scripts[1], "mkdir -p '/usr/local/bin' '/usr/local/lib/acme'");
  const commit = io.scripts.at(-1)!;
  assert.ok(commit.includes(`chmod 0755 '${bin!.abs}' && mv -f '${bin!.abs}' '/usr/local/bin/acme'`));
  assert.ok(commit.includes(`chmod 0644 '${lib!.abs}' && mv -f '${lib!.abs}' '/usr/local/lib/acme/lib.mjs'`));
  assert.ok(commit.endsWith(probeFor(FILES)), "the commit step re-runs the probe so a bad copy never reports healthy");
});

test("a failed post-install verification removes the staged files and throws", async () => {
  const install = createLayerToolInstaller(() => FILES);
  const io = fakeIo({ probe: 1, verify: 1 });
  await assert.rejects(install(io), /verification failed/);
  const cleanup = io.scripts.at(-1)!;
  assert.ok(cleanup.startsWith("rm -f "));
  assert.ok(cleanup.includes(io.writes[0]!.abs) && cleanup.includes(io.writes[1]!.abs));
});

test("the installer reads the live file list on every provision, so a layer update ships new bytes", async () => {
  let files: LayerInstallFile[] = FILES;
  const install = createLayerToolInstaller(() => files);
  await install(fakeIo({ probe: 1 }, files));
  files = [{ to: "/usr/local/bin/acme", mode: "0755", content: "#!/bin/sh\necho v2\n" }];
  const io = fakeIo({ probe: 1 }, files);
  await install(io);
  assert.equal(io.writes.length, 1);
  assert.equal(io.writes[0]!.data, "#!/bin/sh\necho v2\n");
  assert.ok(io.scripts[0]!.includes(layerToolContentSha("#!/bin/sh\necho v2\n")));
});

test("a layer with no install files never touches the machine", async () => {
  const install = createLayerToolInstaller(() => []);
  const io = fakeIo({ probe: 1 }, []);
  await install(io);
  assert.deepEqual(io.scripts, []);
  assert.deepEqual(io.writes, []);
});
