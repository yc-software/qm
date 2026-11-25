import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import { shq } from "../util/shell.ts";

const URL_USERINFO = String.raw`(https?://)[^/@[:space:]"]+@`;

export function scrubGitRemotesScript(root: string): string {
  return `find ${shq(root)} -maxdepth 4 -path '*/.git/config' -type f -exec grep -lE '${URL_USERINFO}' {} + 2>/dev/null | xargs -r -d '\\n' sed -E -i 's#${URL_USERINFO}#\\1#g'`;
}

export async function scrubGitRemotes(sandbox: Sandbox, handle: SandboxHandle): Promise<string | undefined> {
  const failed = "Credentials may remain in a git remote URL under the workspace: removing them failed.";
  try {
    const { code } = await sandbox.run(handle, scrubGitRemotesScript(handle.rootDir));
    return code === 0 ? undefined : failed;
  } catch {
    return failed;
  }
}
