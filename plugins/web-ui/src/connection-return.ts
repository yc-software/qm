import type { PickerState } from "./connection-preview";

export interface ConnectionAttempt {
  state: string;
  user: string;
  service: { id: string; name: string };
  accountId: string;
  widget: string;
  expiresAt: number;
  path: string;
  picker: PickerState;
  scrollTop: number;
}
const key = (user: string) => `qm-connection-return:${user}`;

export function saveConnectionAttempt(attempt: ConnectionAttempt): void {
  sessionStorage.setItem(key(attempt.user), JSON.stringify(attempt));
}

export function readConnectionAttempt(user: string, state: string, path: string): ConnectionAttempt | null {
  try {
    const attempt = JSON.parse(sessionStorage.getItem(key(user)) ?? "null") as ConnectionAttempt | null;
    if (
      !attempt ||
      attempt.user !== user ||
      attempt.state !== state ||
      attempt.path !== path ||
      !Number.isFinite(attempt.expiresAt) ||
      attempt.expiresAt <= Date.now() ||
      typeof attempt.accountId !== "string" ||
      !/^ca_[a-zA-Z0-9_-]+$/.test(attempt.accountId) ||
      typeof attempt.widget !== "string" ||
      typeof attempt.service?.id !== "string" ||
      typeof attempt.service.name !== "string" ||
      typeof attempt.picker?.query !== "string" ||
      typeof attempt.picker.expanded !== "boolean" ||
      !Number.isFinite(attempt.scrollTop) ||
      attempt.scrollTop < 0
    )
      return null;
    return attempt;
  } catch {
    return null;
  }
}

export function clearConnectionAttempt(user: string): void {
  try {
    sessionStorage.removeItem(key(user));
  } catch {
    return;
  }
}

let initialReturnUrl: URL | null = null;
let capturedReturn: {
  user: string;
  widget: string;
  url: URL;
  attempt: ConnectionAttempt | null;
  verified: boolean;
} | null = null;
export function captureConnectionReturn(url: string): void {
  initialReturnUrl = new URL(url);
  capturedReturn = null;
}
export function isConnectionReturn(): boolean {
  return initialReturnUrl?.searchParams.has("composioReturn") === true;
}
export function takeConnectionReturn(
  user: string,
  widget: string,
): { url: URL; attempt: ConnectionAttempt | null; verified: boolean } | null {
  if (!isConnectionReturn()) return null;
  if (capturedReturn) return capturedReturn.user === user && capturedReturn.widget === widget ? capturedReturn : null;
  let owner = "welcome";
  try {
    const attempt = JSON.parse(sessionStorage.getItem(key(user)) ?? "null") as ConnectionAttempt | null;
    if (typeof attempt?.widget === "string") owner = attempt.widget;
  } catch {
    owner = "welcome";
  }
  if (owner !== widget) return null;
  const url = new URL(initialReturnUrl!.href);
  capturedReturn = {
    user,
    widget,
    verified: false,
    url,
    attempt: readConnectionAttempt(user, url.searchParams.get("composioReturn")!, url.pathname),
  };
  return capturedReturn;
}

export function completeConnectionReturn(user: string, state: string): void {
  if (capturedReturn?.user === user && capturedReturn.attempt?.state === state) capturedReturn.verified = true;
}
