export function analyticsHookConfig(raw: string | undefined): {
  analytics?: { module: string; options?: unknown };
  scriptOrigins: string[];
  connectOrigins: string[];
} {
  if (!raw?.trim()) return { scriptOrigins: [], connectOrigins: [] };
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("WEB_UI_ANALYTICS must be a JSON object");
  const { module, connect = [], options, ...rest } = parsed as Record<string, unknown>;
  if (Object.keys(rest).length)
    throw new Error(`WEB_UI_ANALYTICS has unsupported keys: ${Object.keys(rest).join(", ")}`);
  if (typeof module !== "string" || !(module.startsWith("/") ? !module.startsWith("//") : httpsOrigin(module)))
    throw new Error("WEB_UI_ANALYTICS module must be a same-origin path or an HTTPS URL");
  if (
    !Array.isArray(connect) ||
    !connect.every((origin) => typeof origin === "string" && httpsOrigin(origin) === origin)
  )
    throw new Error("WEB_UI_ANALYTICS connect must be a list of HTTPS origins");
  const moduleOrigin = module.startsWith("/") ? undefined : httpsOrigin(module);
  return {
    analytics: { module, ...(options === undefined ? {} : { options }) },
    scriptOrigins: moduleOrigin ? [moduleOrigin] : [],
    connectOrigins: connect as string[],
  };
}

function httpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
