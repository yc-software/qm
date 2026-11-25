import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import { shq } from "../util/shell.ts";
import { errMessage } from "../util/errors.ts";

const URL_USERINFO = String.raw`(https?://)[^/@[:space:]"]+@`;

export function scrubGitRemotesScript(root: string): string {
  return `find ${shq(root)} \\( -name node_modules -o -path '*/.git/objects' \\) -prune -o -path '*/.git/config' -type f -print | while IFS= read -r f; do if grep -qE '${URL_USERINFO}' "$f"; then sed -E -i 's#${URL_USERINFO}#\\1#g' "$f" || exit 1; fi; done`;
}

export async function scrubGitRemotes(sandbox: Sandbox, handle: SandboxHandle): Promise<string | undefined> {
  const failed = "Credentials may remain in a git remote URL under the workspace: removing them failed";
  try {
    const { code, stderr } = await sandbox.run(handle, scrubGitRemotesScript(handle.rootDir));
    return code === 0 ? undefined : `${failed} (exit ${code}): ${stderr.trim().slice(-500)}`;
  } catch (error) {
    return `${failed}: ${errMessage(error)}`;
  }
}
