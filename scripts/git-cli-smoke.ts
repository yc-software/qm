import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { shq } from "../src/util/shell.ts";

export interface GitCliSmokeCommandOptions {
  requireGlab?: boolean;
  requireGhAuth?: boolean;
  requireGlabAuth?: boolean;
  statusDir?: string;
}

export function buildGitCliSmokeCommand(options: GitCliSmokeCommandOptions = {}): string {
  const escapedScript = buildGitCliSmokeScript(options).replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
  return `printf %b ${shq(escapedScript)} | sh`;
}

export function buildGitCliSmokeScript(options: GitCliSmokeCommandOptions = {}): string {
  const requireGhAuth = options.requireGhAuth === true;
  const requireGlabAuth = options.requireGlabAuth === true;
  const requireGlab = options.requireGlab === true || requireGlabAuth;
  const statusDir = shq(options.statusDir ?? "/tmp");
  const requiredGlabFlag = requireGlab ? "1" : "0";
  const requiredGhAuthFlag = requireGhAuth ? "1" : "0";
  const requiredGlabAuthFlag = requireGlabAuth ? "1" : "0";

  return `
set -u
status_dir=${statusDir}
mkdir -p "$status_dir"

fail_smoke() {
  printf 'git cli error: kind=%s tool=%s detail=%s\\n' "$1" "$2" "$3"
  exit 1
}

classify_auth_failure() {
  output_file="$1"
  if grep -Eiq 'not logged[ -]?in|not logged into|not authenticated|no token|missing token|could not find.*token|please authenticate|run .*auth login|no gitlab hosts? configured' "$output_file"; then
    printf 'auth_missing'
    return
  fi
  if grep -Eiq 'could not resolve|temporary failure|network is unreachable|host is unreachable|connection refused|connection reset|timed out|timeout|i/o timeout|no such host|failed to connect|tls handshake|proxyconnect|502 bad gateway|503 service unavailable|504 gateway timeout|server misbehaving' "$output_file"; then
    printf 'host_unreachable'
    return
  fi
  printf 'auth_error'
}

check_auth_status() {
  tool="$1"
  output_file="$status_dir/qm-\${tool}-auth-status.txt"
  if "$tool" auth status >"$output_file" 2>&1; then
    printf 'ok'
    return
  fi
  classify_auth_failure "$output_file"
}

git_path="$(command -v git || true)"
if [ -z "$git_path" ]; then fail_smoke binary_missing git 'git is not on PATH in the resident Agent Computer'; fi
gh_path="$(command -v gh || true)"
if [ -z "$gh_path" ]; then fail_smoke binary_missing gh 'gh is not on PATH in the resident Agent Computer image'; fi

git_version="$(git --version 2>/dev/null | head -n 1 | tr '\\n' ' ')"
if [ -z "$git_version" ]; then fail_smoke binary_error git 'git is present but git --version failed'; fi
gh_version="$(gh --version 2>/dev/null | head -n 1 | tr '\\n' ' ')"
if [ -z "$gh_version" ]; then fail_smoke binary_error gh 'gh is present but gh --version failed'; fi

gh_auth="$(check_auth_status gh)"
if [ "$gh_auth" != ok ] && [ "${requiredGhAuthFlag}" = 1 ]; then
  fail_smoke "$gh_auth" gh 'gh auth status failed; run gh auth login on the resident Agent Computer or check host reachability'
fi

glab_path="$(command -v glab || true)"
glab_version=missing
glab_auth=skipped
if [ -n "$glab_path" ]; then
  glab_version="$(glab --version 2>/dev/null | head -n 1 | tr '\\n' ' ')"
  if [ -z "$glab_version" ]; then glab_version=unknown; fi
  glab_auth="$(check_auth_status glab)"
elif [ "${requiredGlabFlag}" = 1 ]; then
  fail_smoke binary_missing glab 'glab is not on PATH; install it residently on the Agent Computer'
fi

if [ "$glab_auth" != ok ] && [ "${requiredGlabAuthFlag}" = 1 ]; then
  fail_smoke "$glab_auth" glab 'glab auth status failed; run glab auth login on the resident Agent Computer or check host reachability'
fi

printf 'git cli ok: git=%s gh=%s glab=%s git_version=%s gh_version=%s glab_version=%s gh_auth=%s glab_auth=%s glab_required=%s gh_auth_required=%s glab_auth_required=%s\\n' "$git_path" "$gh_path" "\${glab_path:-missing}" "$git_version" "$gh_version" "$glab_version" "$gh_auth" "$glab_auth" "${requiredGlabFlag}" "${requiredGhAuthFlag}" "${requiredGlabAuthFlag}"
`.trim();
}

export async function main(): Promise<void> {
  const [{ loadConfig }, { buildApp }] = await Promise.all([import("../src/config.ts"), import("../src/wiring.ts")]);
  const config = loadConfig();
  const actorProvided = Boolean(process.env.GIT_CLI_SMOKE_ACTOR_ID);
  const actorId = process.env.GIT_CLI_SMOKE_ACTOR_ID ?? `qm-git-cli-smoke-${Date.now()}`;
  const requireGlab = process.env.GIT_CLI_SMOKE_REQUIRE_GLAB === "1";
  const requireGhAuth = process.env.GIT_CLI_SMOKE_REQUIRE_GH_AUTH === "1";
  const requireGlabAuth = process.env.GIT_CLI_SMOKE_REQUIRE_GLAB_AUTH === "1";

  if (!actorProvided) process.env.GIT_CLI_SMOKE_DESTROY = process.env.GIT_CLI_SMOKE_DESTROY ?? "1";

  const built = buildApp({
    ...config,
    dataDir: process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), "qm-git-cli-smoke-")),
    harness: "mock",
    sessionStore: "memory",
    runStore: "memory",
  });

  const command = buildGitCliSmokeCommand({ requireGlab, requireGhAuth, requireGlabAuth });

  try {
    const result = await built.app.turn({
      surface: "test",
      actor: { externalId: actorId, displayName: process.env.GIT_CLI_SMOKE_DISPLAY_NAME ?? actorId },
      conversation: { kind: "dm", threadRef: `git-cli-smoke:${actorId}:${Date.now()}` },
      text: `!run ${command}`,
    });
    if (result.status !== "ok" || !result.reply?.includes("git cli ok:")) {
      throw new Error(`git cli smoke failed: ${JSON.stringify(result)}`);
    }
    console.log(result.reply);
  } finally {
    await built.runtime.stop();
    if (process.env.GIT_CLI_SMOKE_DESTROY === "1" && process.env.SPRITES_TOKEN) {
      const [{ SpritesClient }, { spriteScopeName }] = await Promise.all([
        import("@fly/sprites"),
        import("../src/sandbox/sprites-sandbox.ts"),
      ]);
      const name = spriteScopeName(process.env.SPRITES_NAME_PREFIX ?? "qm", `personal:${actorId}`);
      await new SpritesClient(process.env.SPRITES_TOKEN).deleteSprite(name).catch(() => {});
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
