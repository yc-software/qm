import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { shq } from "../util/shell.ts";
import { supportsBlobStaging, type Sandbox, type SandboxHandle } from "./sandbox.ts";
import { posixJoin } from "./exec-file-ops.ts";

export function translateScript(toHome: string, fromHome: string): string {
  const H = shq(toHome);
  const FROM = fromHome.replace(/\/+$/, "");
  const pat = FROM.replace(/[.[\]*^$\\#]/g, "\\$&");
  const sub = toHome.replace(/[&\\#]/g, "\\$&");
  const rewriteTargets = [`${H}/.gitconfig`, `${H}/.config`, `${H}/.bashrc`, `${H}/.profile`];
  const rewrite = (f: string) =>
    `t=$(mktemp) && sed "s#${pat}\\([^A-Za-z0-9_.-]\\)#${sub}\\1#g; s#${pat}\\$#${sub}#" ${f} > "$t" && mv "$t" ${f}`;
  return [
    `for t in ${rewriteTargets.join(" ")}; do`,
    `  [ -e "$t" ] && grep -rIl ${shq(FROM)} "$t" 2>/dev/null | while IFS= read -r f; do`,
    `    ${rewrite('"$f"')} || true`,
    `  done`,
    `done`,
    `find ${H} -maxdepth 4 -path '*/.git/config' -type f 2>/dev/null | while IFS= read -r f; do`,
    `  grep -Iq ${shq(FROM)} "$f" 2>/dev/null && { ${rewrite('"$f"')}; } || true`,
    `done`,
    `find ${H} -name pyvenv.cfg -type f 2>/dev/null | while IFS= read -r cfg; do`,
    `  rm -rf "$(dirname "$cfg")" 2>/dev/null || true`,
    `done`,
    `true`,
  ].join("\n");
}

export interface CopyHomeResult {
  bytes: number;
  sha: string;
  sourceFiles: number;
  destFiles: number;
}

export interface PackedHome {
  tarPath: string;
  tarRel: string;
  sha: string;
  bytes: number;
  sourceFiles: number;
}

const HOME_TAR_PREFIX = ".home-";

export async function packHome(
  fromSandbox: Sandbox,
  fromHandle: SandboxHandle,
  fromHome: string,
  timeoutMs: number,
): Promise<PackedHome> {
  const tarRel = `${HOME_TAR_PREFIX}${randomUUID()}.tgz`;
  const tarPath = posixJoin(fromHandle.rootDir, tarRel);
  const H = shq(fromHome);
  const P = shq(tarPath);
  const packed = await fromSandbox.run(
    fromHandle,
    `cd ${H} && tar czf ${P} --exclude=${shq(`./${posix.relative(fromHome, fromHandle.rootDir)}/${HOME_TAR_PREFIX}*.tgz`)} . 2>/dev/null; rc=$?; [ "$rc" -le 1 ] || exit "$rc"; sha256sum ${P} | cut -d' ' -f1 && wc -c < ${P} && find . -type f ! -name ${shq(`${HOME_TAR_PREFIX}*.tgz`)} | wc -l`,
    { timeoutMs },
  );
  if (packed.code !== 0) {
    await fromSandbox.run(fromHandle, `rm -f ${P}`, { timeoutMs: 30_000 }).catch(() => {});
    throw new Error(`packHome: source tar failed (${packed.code}): ${(packed.stderr || packed.stdout).slice(0, 200)}`);
  }
  const [shaLine = "", sizeLine = "", filesLine = ""] = packed.stdout.trim().split("\n");
  const sha = shaLine.trim();
  const bytes = Number.parseInt(sizeLine.trim(), 10);
  const sourceFiles = Number.parseInt(filesLine.trim(), 10);
  if (!/^[0-9a-f]{64}$/.test(sha) || !Number.isFinite(bytes) || !Number.isFinite(sourceFiles)) {
    throw new Error(`packHome: unreadable source manifest: ${packed.stdout.slice(0, 200)}`);
  }
  return { tarPath, tarRel, sha, bytes, sourceFiles };
}

export interface CopyHomeArgs {
  fromSandbox: Sandbox;
  fromHandle: SandboxHandle;
  fromHome: string;
  toSandbox: Sandbox;
  toHandle: SandboxHandle;
  toHome: string;
  timeoutSec?: number;
}

export async function copyHome(args: CopyHomeArgs): Promise<CopyHomeResult> {
  const { fromSandbox, fromHandle, fromHome, toSandbox, toHandle, toHome } = args;
  const timeoutMs = (args.timeoutSec ?? 900) * 1000;
  const T = shq(toHome);
  const { tarPath, tarRel, sha, bytes, sourceFiles } = await packHome(fromSandbox, fromHandle, fromHome, timeoutMs);
  const toTarPath = posixJoin(toHandle.rootDir, tarRel);
  try {
    return await transferHome();
  } finally {
    await Promise.all([
      fromSandbox.run(fromHandle, `rm -f ${shq(tarPath)}`, { timeoutMs: 30_000 }).catch(() => {}),
      toSandbox.run(toHandle, `rm -f ${shq(toTarPath)}`, { timeoutMs: 30_000 }).catch(() => {}),
    ]);
  }

  async function transferHome(): Promise<CopyHomeResult> {
    if (supportsBlobStaging(fromSandbox) && supportsBlobStaging(toSandbox)) {
      const stageOpts = { timeoutSec: timeoutMs / 1000 };
      const blobId = await fromSandbox.stageOut(fromHandle, tarRel, stageOpts);
      await toSandbox.stageIn(toHandle, tarRel, blobId, stageOpts);
    } else {
      const tarBytes = await fromSandbox.readFileBytes(fromHandle, tarRel);
      if (!tarBytes) throw new Error("copyHome: source tar vanished before read");
      await toSandbox.writeFileBytes(toHandle, tarRel, tarBytes);
    }

    const extracted = await toSandbox.run(
      toHandle,
      `dsha=$(sha256sum ${shq(toTarPath)} | cut -d' ' -f1); [ "$dsha" = ${shq(sha)} ] || { echo "sha-mismatch:$dsha"; exit 3; }; mkdir -p ${T} && cd ${T} && tar xzf ${shq(toTarPath)} 2>/dev/null && find . -type f ! -name ${shq(`${HOME_TAR_PREFIX}*.tgz`)} | wc -l`,
      { timeoutMs },
    );
    if (extracted.code !== 0) {
      throw new Error(
        `copyHome: dest verify/extract failed (${extracted.code}): ${(extracted.stderr || extracted.stdout).slice(0, 200)}`,
      );
    }
    const destFiles = Number.parseInt(extracted.stdout.trim().split("\n").pop() ?? "", 10);

    if (fromHome !== toHome) {
      const t = await toSandbox.run(toHandle, translateScript(toHome, fromHome), { timeoutMs: 120_000 });
      if (t.code !== 0)
        throw new Error(`copyHome: translation failed (${t.code}): ${(t.stderr || t.stdout).slice(0, 200)}`);
    }

    return { bytes, sha, sourceFiles, destFiles };
  }
}
