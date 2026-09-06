const BASIC_USERNAME_BY_HOST = new Map([["bitbucket.org", "x-token-auth"]]);

const DEFAULT_BASIC_USERNAME = "x-access-token";

export function credentialAuthValue(scheme: string, secret: string): string {
  return `${scheme && !/\s$/.test(scheme) ? `${scheme} ` : scheme}${secret}`;
}

export function gitAuthHeader(
  injection: { header?: string; scheme?: string } | undefined,
  secret: string,
  host: string,
): [string, string] {
  const header = injection?.header?.trim() || "Authorization";
  const scheme = injection?.scheme;
  if (scheme !== undefined || header.toLowerCase() !== "authorization") {
    return [header, credentialAuthValue(scheme ?? "Bearer ", secret)];
  }
  const user = BASIC_USERNAME_BY_HOST.get(host.toLowerCase().replace(/^www\./, "")) ?? DEFAULT_BASIC_USERNAME;
  return [header, `Basic ${Buffer.from(`${user}:${secret}`, "utf8").toString("base64")}`];
}
