import { swallow } from "../../chassis/src/errors.ts";
import { WEB_BUILD_HEADER, WEB_BUILD_META } from "./web-build-wire.ts";

const RELOADED_BUILDS_KEY = "web-ui:reloaded-builds";
const SETTLE_MS = 2_000;

let servedBuild: string | null = null;
let writesInFlight = 0;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function bootedBuild(): string | undefined {
  return document.querySelector<HTMLMetaElement>(`meta[name="${WEB_BUILD_META}"]`)?.content || undefined;
}

function stale(): boolean {
  if (!servedBuild) return false;
  const booted = bootedBuild();
  return Boolean(booted) && servedBuild !== booted;
}

function pageIsIdle(): boolean {
  if (writesInFlight) return false;
  if ([...document.querySelectorAll("textarea")].some((input) => input.value.trim())) return false;
  const event = new CustomEvent("qm:prepare-update", { cancelable: true, detail: { ready: false } });
  return window.dispatchEvent(event) && event.detail.ready;
}

function claimReload(build: string): boolean {
  try {
    const reloaded: unknown = JSON.parse(sessionStorage.getItem(RELOADED_BUILDS_KEY) ?? "[]");
    const builds = Array.isArray(reloaded) ? reloaded : [];
    if (builds.includes(build)) return false;
    sessionStorage.setItem(RELOADED_BUILDS_KEY, JSON.stringify([...builds, build]));
    return true;
  } catch (error) {
    swallow("web-ui: record build reload", error);
    return false;
  }
}

function reloadIfStale(): void {
  settleTimer = null;
  if (stale() && pageIsIdle() && claimReload(servedBuild!)) location.reload();
}

function settle(restart = false): void {
  if (!stale() || (settleTimer !== null && !restart)) return;
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = setTimeout(reloadIfStale, SETTLE_MS);
}

export async function trackWebBuild(request: Promise<Response>, method: string): Promise<Response> {
  const write = !["GET", "HEAD"].includes(method.toUpperCase());
  if (write) writesInFlight++;
  try {
    const response = await request;
    servedBuild = response.headers.get(WEB_BUILD_HEADER) ?? servedBuild;
    return response;
  } finally {
    if (write) writesInFlight--;
    settle(write);
  }
}

if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => settle());
