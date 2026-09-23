import { dirname, join } from "node:path/posix";
import { randomUUID } from "node:crypto";
import { shq } from "../util/shell.ts";
import type { SupervisorTransport } from "./sandbox.ts";

export const SUPERVISOR_TRUST_VERSION = "1";

type RootTransport = Pick<SupervisorTransport, "run" | "identity" | "acceptTrusted" | "processStarted"> & {
  writeBytes(handle: Parameters<SupervisorTransport["writeFile"]>[0], path: string, data: Uint8Array): Promise<void>;
};

const PREPARE = [
  "import os,pathlib,stat,sys",
  "target=pathlib.Path(sys.argv[1])",
  "assert target.is_absolute() and '..' not in target.parts",
  "assert any(str(target).startswith(root+'/') for root in ['/opt/qm-supervisor','/run/qm-supervisor','/dev/shm/qm-supervisor'])",
  "assert os.geteuid()==0",
  "for parent in reversed(target.parents):",
  " if str(parent)=='/': continue",
  " try: parent.mkdir(mode=0o700)",
  " except FileExistsError: pass",
  " info=parent.lstat()",
  " assert stat.S_ISDIR(info.st_mode) and info.st_uid==0",
  " assert not info.st_mode & 0o022 or str(parent)=='/dev/shm'",
  "assert target.parent.stat().st_mode & 0o077 == 0",
].join("\n");

const COMMIT = [
  "import os,stat,sys",
  "source,target=sys.argv[1:]",
  "info=os.lstat(source)",
  "assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1",
  "os.chmod(source,0o600)",
  "os.replace(source,target)",
].join("\n");

const DEPENDENCIES = [
  "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  '[ "$(id -u)" = 0 ] || exit 126',
  "probe() { command -v python3 >/dev/null && command -v bwrap >/dev/null && command -v setpriv >/dev/null && python3 -I -c 'import ctypes; ctypes.CDLL(\"libseccomp.so.2\")'; }",
  "if ! probe >/dev/null 2>&1; then",
  " if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 bubblewrap util-linux libseccomp2 || exit 125",
  " elif command -v dnf >/dev/null; then dnf install -y python3 bubblewrap util-linux libseccomp || exit 125",
  " else exit 125; fi",
  "fi",
  "probe",
].join("\n");

export function createSupervisorTransport(io: RootTransport, fresh: ReadonlySet<string>): SupervisorTransport {
  return {
    ...io,
    async ensureDependencies(handle) {
      const result = await io.run(handle, DEPENDENCIES, { timeoutMs: 300_000 });
      if (result.code !== 0)
        throw new Error(
          "Supervisor dependencies unavailable; install Python 3, bubblewrap, util-linux and libseccomp in the provider image",
        );
    },
    async isFresh(handle) {
      return fresh.has(await io.identity(handle));
    },
    async writeFile(handle, absPath, data) {
      const staged = join(dirname(absPath), ".uploads", `${randomUUID()}.part`);
      const prepared = await io.run(handle, `python3 -I -c ${shq(PREPARE)} ${shq(staged)}`, { timeoutMs: 120_000 });
      if (prepared.code !== 0) throw new Error("Supervisor private staging directory is unavailable");
      const expiry = await io.run(
        handle,
        `setsid sh -c ${shq(`sleep 300; rm -f -- ${shq(staged)}`)} </dev/null >/dev/null 2>&1 &`,
        { timeoutMs: 30_000 },
      );
      if (expiry.code !== 0) throw new Error("Supervisor upload expiry could not be scheduled");
      try {
        await io.writeBytes(handle, staged, data);
        const committed = await io.run(handle, `python3 -I -c ${shq(COMMIT)} ${shq(staged)} ${shq(absPath)}`, {
          timeoutMs: 120_000,
        });
        if (committed.code !== 0) throw new Error("Supervisor private request upload failed");
      } finally {
        await io.run(handle, `rm -f -- ${shq(staged)}`, { timeoutMs: 30_000 });
      }
    },
  };
}
