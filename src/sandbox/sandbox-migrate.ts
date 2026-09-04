import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { shq } from "../util/shell.ts";
import { supportsBlobStaging, type Sandbox, type SandboxHandle } from "./sandbox.ts";

function translateScript(toHome: string, fromHome: string): string {
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
  const uid = randomUUID();
  const tarPath = `/tmp/.home-${uid}.tgz`;
  const H = shq(fromHome);
  const T = shq(toHome);
  const fromRel = posix.relative(fromHandle.rootDir, tarPath);
  const toRel = posix.relative(toHandle.rootDir, tarPath);

  const packed = await fromSandbox.run(
    fromHandle,
    `cd ${H} && tar czf ${tarPath} . 2>/dev/null && sha256sum ${tarPath} | cut -d' ' -f1 && wc -c < ${tarPath} && find . -type f | wc -l`,
    { timeoutMs },
  );
  if (packed.code !== 0)
    throw new Error(`copyHome: source tar failed (${packed.code}): ${(packed.stderr || packed.stdout).slice(0, 200)}`);
  const [shaLine = "", sizeLine = "", filesLine = ""] = packed.stdout.trim().split("\n");
  const sha = shaLine.trim();
  const bytes = Number.parseInt(sizeLine.trim(), 10);
  const sourceFiles = Number.parseInt(filesLine.trim(), 10);
  if (!/^[0-9a-f]{64}$/.test(sha) || !Number.isFinite(bytes) || !Number.isFinite(sourceFiles)) {
    throw new Error(`copyHome: unreadable source manifest: ${packed.stdout.slice(0, 200)}`);
  }

  if (supportsBlobStaging(fromSandbox) && supportsBlobStaging(toSandbox)) {
    const blobId = await fromSandbox.stageOut(fromHandle, fromRel);
    await toSandbox.stageIn(toHandle, toRel, blobId);
  } else {
    const tarBytes = await fromSandbox.readFileBytes(fromHandle, fromRel);
    if (!tarBytes) throw new Error("copyHome: source tar vanished before read");
    await toSandbox.writeFileBytes(toHandle, toRel, tarBytes);
  }

  const extracted = await toSandbox.run(
    toHandle,
    `dsha=$(sha256sum ${tarPath} | cut -d' ' -f1); [ "$dsha" = ${shq(sha)} ] || { echo "sha-mismatch:$dsha"; exit 3; }; mkdir -p ${T} && cd ${T} && tar xzf ${tarPath} 2>/dev/null && find . -type f | wc -l`,
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

  await Promise.all([
    fromSandbox.run(fromHandle, `rm -f ${tarPath}`, { timeoutMs: 30_000 }).catch(() => {}),
    toSandbox.run(toHandle, `rm -f ${tarPath}`, { timeoutMs: 30_000 }).catch(() => {}),
  ]);

  return { bytes, sha, sourceFiles, destFiles };
}
