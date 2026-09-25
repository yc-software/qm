export interface PickerState {
  query: string;
  expanded: boolean;
}
export interface PreviewAttempt {
  state: string;
  user: string;
  service: { id: string; name: string };
  accountId: string;
  expiresAt: number;
  callbackUrl: string;
  picker: PickerState;
  scrollTop: number;
}
const PREFIX = "qm-connection-preview:";
const initialUrl = new URL(location.href);
export const previewParameters = () => new URLSearchParams(initialUrl.search);
export function connectionPreviewEnabled(): boolean {
  return (
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) &&
    initialUrl.searchParams.get("connectionDemo") === "1"
  );
}
export function readPreviewAttempt(user: string): PreviewAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(`${PREFIX}attempt`) ?? "null") as PreviewAttempt | null;
    return value?.user === user && value.expiresAt > Date.now() ? value : null;
  } catch {
    return null;
  }
}
export function startPreviewAttempt(
  user: string,
  service: PreviewAttempt["service"],
  picker: PickerState,
  scrollTop: number,
): void {
  const state = crypto.randomUUID();
  const callback = new URL(location.href);
  callback.searchParams.set("connectionDemo", "1");
  for (const key of ["connectionConsent", "connectionReturn", "status", "error", "connectedAccountId"])
    callback.searchParams.delete(key);
  callback.searchParams.set("connectionReturn", state);
  const attempt: PreviewAttempt = {
    state,
    user,
    service,
    accountId: `ca_demo_${crypto.randomUUID()}`,
    expiresAt: Date.now() + 20 * 60_000,
    callbackUrl: callback.href,
    picker,
    scrollTop,
  };
  sessionStorage.setItem(`${PREFIX}attempt`, JSON.stringify(attempt));
  const consent = new URL(location.href);
  consent.searchParams.set("connectionDemo", "1");
  consent.searchParams.set("connectionConsent", state);
  location.assign(consent.href);
}
export function finishPreviewAttempt(attempt: PreviewAttempt, outcome: "success" | "cancelled" | "failed"): void {
  sessionStorage.setItem(
    `${PREFIX}verification:${attempt.state}`,
    JSON.stringify({
      user: attempt.user,
      accountId: attempt.accountId,
      status: outcome === "success" ? "ACTIVE" : "FAILED",
    }),
  );
  const callback = new URL(attempt.callbackUrl);
  callback.searchParams.set("status", outcome === "success" ? "success" : "failed");
  callback.searchParams.set("connectedAccountId", attempt.accountId);
  if (outcome !== "success")
    callback.searchParams.set("error", outcome === "cancelled" ? "access_denied" : "provider_error");
  location.assign(callback.href);
}
export function verifyPreviewAttempt(attempt: PreviewAttempt): boolean {
  const record = JSON.parse(sessionStorage.getItem(`${PREFIX}verification:${attempt.state}`) ?? "null");
  return record?.user === attempt.user && record.accountId === attempt.accountId && record.status === "ACTIVE";
}
export function previewConnections(user: string): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(`${PREFIX}connected:${user}`) ?? "[]");
  } catch {
    return [];
  }
}
export function savePreviewConnection(attempt: PreviewAttempt): void {
  sessionStorage.setItem(
    `${PREFIX}connected:${attempt.user}`,
    JSON.stringify([...new Set([...previewConnections(attempt.user), attempt.service.id])]),
  );
}
export function clearPreviewAttempt(attempt: PreviewAttempt): void {
  sessionStorage.removeItem(`${PREFIX}attempt`);
  sessionStorage.removeItem(`${PREFIX}verification:${attempt.state}`);
}
export function resetPreview(user: string): void {
  sessionStorage.removeItem(`${PREFIX}connected:${user}`);
  const attempt = readPreviewAttempt(user);
  if (attempt) clearPreviewAttempt(attempt);
  location.assign(`${location.pathname}?connectionDemo=1`);
}
