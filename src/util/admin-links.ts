const trimBase = (publicWebUrl: string): string => publicWebUrl.replace(/\/$/, "");

export function adminSessionUrl(publicWebUrl: string, sessionId: string): string {
  const segment = encodeURIComponent(sessionId);
  if (/%2F|%5C/i.test(segment)) return `${trimBase(publicWebUrl)}/settings/history?session=${segment}`;
  return `${trimBase(publicWebUrl)}/settings/history/s/${segment}`;
}

export function adminCronHistoryUrl(publicWebUrl: string, ownerScopeId: string, cronId: string): string {
  const scopeSegment = encodeURIComponent(ownerScopeId);
  const cronQuery = `kind=cron&cron=${encodeURIComponent(cronId)}`;
  if (/%2F|%5C/i.test(scopeSegment)) {
    return `${trimBase(publicWebUrl)}/settings/history?scope=${scopeSegment}&${cronQuery}`;
  }
  return `${trimBase(publicWebUrl)}/settings/history/scopes/${scopeSegment}?${cronQuery}`;
}
