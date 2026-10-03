export function buildInfo(env: NodeJS.ProcessEnv): { version?: string; sha?: string } | undefined {
  const version = env.QM_VERSION?.trim();
  const sha = env.GIT_SHA?.trim().match(/^([0-9a-f]{7})[0-9a-f]{0,33}(-dirty)?$/);
  const build = {
    ...(version && /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version) ? { version } : {}),
    ...(sha ? { sha: `${sha[1]}${sha[2] ?? ""}` } : {}),
  };
  return build.version || build.sha ? build : undefined;
}
