import { parseSampleRate } from "../../chassis/src/timing.ts";

export function browserErrorConfig(
  env: NodeJS.ProcessEnv,
): { dsn: string; release?: string; tracesSampleRate?: number } | undefined {
  const dsn = env.SENTRY_BROWSER_DSN?.trim();
  if (!dsn) return undefined;
  const invalid = () => new Error("SENTRY_BROWSER_DSN must be a public HTTPS DSN without a secret key");
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== "https:" ||
    !/^[a-zA-Z0-9]{1,128}$/.test(url.username) ||
    url.password ||
    !/^\/[1-9][0-9]*$/.test(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw invalid();
  }
  const release = env.SENTRY_RELEASE ?? env.GIT_SHA;
  const tracesSampleRate = parseSampleRate(env.SENTRY_BROWSER_TRACES_SAMPLE_RATE);
  return {
    dsn: url.href,
    ...(release && /^[a-zA-Z0-9_.@+-]{1,128}$/.test(release) ? { release } : {}),
    ...(tracesSampleRate ? { tracesSampleRate } : {}),
  };
}
