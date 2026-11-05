import { swallow } from "../../chassis/src/errors.ts";
import { WEB_BUILD_HEADER, WEB_BUILD_META } from "./web-build-wire.ts";

const RELOADED_BUILDS_KEY = "web-ui:reloaded-builds";
const SETTLE_MS = 2_000;
const RELOAD_COOL_OFF_MS = 5 * 60_000;

let servedBuild: string | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function holdUpdate(): () => void {
  if (typeof window === "undefined") return () => {};
  const hold = (event: Event): void => event.preventDefault();
  window.addEventListener("qm:prepare-update", hold);
  return () => window.removeEventListener("qm:prepare-update", hold);
}

export async function holdUpdates<T>(work: () => Promise<T>): Promise<T> {
  const release = holdUpdate();
  try {
    return await work();
  } finally {
    release();
  }
}

function stale(): boolean {
  if (!servedBuild || typeof document === "undefined") return false;
  const booted = document.querySelector<HTMLMetaElement>(`meta[name="${WEB_BUILD_META}"]`)?.content;
  return Boolean(booted) && servedBuild !== booted;
}

function pageIsIdle(): boolean {
  if ([...document.querySelectorAll("textarea")].some((input) => input.value.trim())) return false;
  const event = new CustomEvent("qm:prepare-update", { cancelable: true, detail: { ready: false } });
  return window.dispatchEvent(event) && event.detail.ready;
}

function claimReload(build: string): boolean {
  try {
    const now = Date.now();
    const stored: unknown = JSON.parse(sessionStorage.getItem(RELOADED_BUILDS_KEY) ?? "{}");
    const recent = Object.entries(stored && typeof stored === "object" ? stored : {}).filter(
      ([, at]) => typeof at === "number" && now - at < RELOAD_COOL_OFF_MS,
    );
    if (recent.some(([reloaded]) => reloaded === build)) return false;
    sessionStorage.setItem(RELOADED_BUILDS_KEY, JSON.stringify(Object.fromEntries([...recent, [build, now]])));
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
  const release = write ? holdUpdate() : undefined;
  try {
    const response = await request;
    servedBuild = response.headers?.get(WEB_BUILD_HEADER) ?? servedBuild;
    return response;
  } finally {
    release?.();
    settle(write);
  }
}

if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => settle());
