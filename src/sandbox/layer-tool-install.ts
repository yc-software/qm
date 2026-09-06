import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import { shq } from "../util/shell.ts";

export interface LayerToolInstallIo {
  exec(script: string, timeoutSec: number): Promise<{ code: number; stdout: string; stderr: string }>;
  writeAbs(absPath: string, data: Uint8Array): Promise<void>;
}

export type LayerToolInstaller = (io: LayerToolInstallIo) => Promise<void>;

const STEP_TIMEOUT_SEC = 60;

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

const isExecutable = (mode: string): boolean => (parseInt(mode, 8) & 0o111) !== 0;

interface StagedFile {
  to: string;
  mode: string;
  data: Buffer;
  sha: string;
}

function staged(files: readonly LayerInstallFile[]): StagedFile[] {
  return files.map((file) => {
    const data = Buffer.from(file.content, "utf8");
    return { to: file.to, mode: file.mode, data, sha: sha256(data) };
  });
}

export function layerToolProbeScript(files: readonly { to: string; mode: string; sha: string }[]): string {
  const lines = files.map((file) => shq(`${file.sha}  ${file.to}`)).join(" ");
  const executable = files
    .filter((file) => isExecutable(file.mode))
    .map((file) => ` && [ -x ${shq(file.to)} ]`)
    .join("");
  return `printf '%s\\n' ${lines} | sha256sum -c --status${executable}`;
}

export function layerToolContentSha(content: string): string {
  return sha256(Buffer.from(content, "utf8"));
}

export function createLayerToolInstaller(files: () => readonly LayerInstallFile[]): LayerToolInstaller {
  return async (io) => {
    const wanted = staged(files());
    if (wanted.length === 0) return;
    const probe = layerToolProbeScript(wanted);
    if ((await io.exec(probe, STEP_TIMEOUT_SEC)).code === 0) return;
    const dirs = [...new Set(wanted.map((file) => dirname(file.to)))];
    const prep = await io.exec(`mkdir -p ${dirs.map(shq).join(" ")}`, STEP_TIMEOUT_SEC);
    if (prep.code !== 0) {
      throw new Error(`layer tool install: mkdir failed (rc=${prep.code}): ${prep.stderr.slice(0, 200)}`);
    }
    const nonce = randomUUID().slice(0, 8);
    const plan = wanted.map((file) => ({ ...file, stagedPath: `${file.to}.staged-${nonce}` }));
    for (const file of plan) await io.writeAbs(file.stagedPath, file.data);
    const commit = plan
      .map((file) => `chmod ${file.mode} ${shq(file.stagedPath)} && mv -f ${shq(file.stagedPath)} ${shq(file.to)}`)
      .join(" && ");
    const verify = await io.exec(`${commit} && ${probe}`, STEP_TIMEOUT_SEC);
    if (verify.code !== 0) {
      await io.exec(`rm -f ${plan.map((file) => shq(file.stagedPath)).join(" ")}`, STEP_TIMEOUT_SEC).catch(() => {});
      throw new Error(`layer tool install: verification failed (rc=${verify.code}): ${verify.stderr.slice(0, 200)}`);
    }
  };
}
