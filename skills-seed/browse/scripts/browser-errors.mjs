import { inspect } from "node:util";

export function formatBrowserError(error, privateValues = []) {
  const secrets = new Set(privateValues.filter((value) => typeof value === "string" && value));
  for (const value of [...secrets]) {
    try {
      const url = new URL(value);
      for (const part of [url.href, `${url.origin}${url.pathname}`, url.hostname, url.password])
        if (part) secrets.add(part);
      if (url.password) {
        const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
        secrets.add(decodeURIComponent(url.password));
        secrets.add(credentials);
        secrets.add(Buffer.from(credentials).toString("base64"));
      }
    } catch {
      continue;
    }
  }
  let text = inspect(error, {
    depth: 8,
    maxArrayLength: 30,
    maxStringLength: 10_000,
    customInspect: false,
    getters: false,
  });
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, "<private browser value>");
  return text;
}

export async function withBrowserCleanup(action, ...cleanups) {
  const errors = [];
  let result;
  try {
    result = await action();
  } catch (error) {
    errors.push(error);
  }
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Browser operation and cleanup failed");
  return result;
}
