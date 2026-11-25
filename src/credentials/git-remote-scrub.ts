import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import { shq } from "../util/shell.ts";
import { errMessage } from "../util/errors.ts";

export function scrubGitRemotesScript(root: string): string {
  return [
    `find ${shq(root)} \\( -name node_modules -o -path '*/.git/objects' \\) -prune -o -path '*/.git/config' -type f -print | while IFS= read -r f; do`,
    `git config --file "$f" --get-regexp '^remote\\..*url$' | while read -r k v; do`,
    `rest="\${v#*://}"; auth="\${rest%%/*}"`,
    `case "\${v%%://*}:$auth" in http:*@* | https:*@*) git config --file "$f" --fixed-value --replace-all "$k" "\${v%%://*}://\${auth##*@}\${rest#"$auth"}" "$v" || exit 1;; esac`,
    "done || exit 1; done",
  ].join("\n");
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
