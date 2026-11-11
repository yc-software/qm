import { errMessage } from "../../chassis/src/errors.ts";
import { createClientToolExecutor, type ClientToolResult, type ClientToolRun } from "./client-tools.ts";
import { askEmbedder, hasEmbedder } from "./embedder.ts";

export const APP_SCREENSHOT_TOOL = "ui__app_screenshot";
const APP_SCREENSHOT_TIMEOUT_MS = 45_000;

export type AppShot = {
  ok: boolean;
  error?: string;
  image?: string;
  mimeType?: "image/png" | "image/jpeg";
  url?: string;
  width?: number;
  height?: number;
  scrollY?: number;
  dark?: boolean;
  version?: string | null;
  consoleErrors?: string[];
  consoleErrorCount?: number;
  consoleWatchError?: string;
};

function appViewEmbedded(): boolean {
  return hasEmbedder() && document.body.classList.contains("app-edit-embed");
}

export function appViewClientTools(): Array<Record<string, unknown>> {
  if (!appViewEmbedded()) return [];
  return [
    {
      name: APP_SCREENSHOT_TOOL,
      description:
        "Take a screenshot of the app exactly as the person sees it right now in their own browser tab: their sign-in, data, theme and scroll position. Waits for the tab to load the newest saved version first. Returns the picture plus the page address, viewport size, light or dark mode, and console errors since the page loaded.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: APP_SCREENSHOT_TIMEOUT_MS,
    },
  ];
}

function consoleLine(shot: AppShot): string {
  if (shot.consoleWatchError) return `Console errors since load: unknown (${shot.consoleWatchError})`;
  const errors = shot.consoleErrors ?? [];
  const total = shot.consoleErrorCount ?? errors.length;
  if (!total) return "Console errors since load: none";
  const shown = total > errors.length ? `${total}, the first ${errors.length} shown` : String(total);
  return `Console errors since load (${shown}):\n${errors.join("\n")}`;
}

export function shotResult(shot: AppShot): ClientToolResult {
  if (!shot.ok || !shot.image || !shot.mimeType)
    return { content: `Screenshot failed: ${shot.error ?? "the page returned no image."}`, isError: true };
  const lines = [
    `Page: ${shot.url ?? "unknown"}`,
    `Viewport: ${shot.width}×${shot.height}${shot.scrollY ? `, scrolled ${shot.scrollY}px down` : ""}`,
    `Color scheme: ${shot.dark ? "dark" : "light"}`,
    ...(shot.version ? [`App version shown: ${shot.version}`] : []),
    consoleLine(shot),
  ];
  return { content: lines.join("\n"), images: [{ data: shot.image, mimeType: shot.mimeType }] };
}

async function takeAppShot(): Promise<ClientToolResult> {
  try {
    return shotResult(
      await askEmbedder<AppShot>({ type: "qm:app-shot" }, "qm:app-shot-result", APP_SCREENSHOT_TIMEOUT_MS),
    );
  } catch (error) {
    return { content: `Screenshot failed: ${errMessage(error)}`, isError: true };
  }
}

export function appViewRunner(
  runId: string,
  send: (path: string, init: RequestInit) => Promise<unknown>,
): ((run: ClientToolRun) => Promise<void>) | undefined {
  if (!appViewEmbedded()) return undefined;
  return createClientToolExecutor(APP_SCREENSHOT_TOOL, takeAppShot, (callId, result) =>
    send(`/api/runs/${encodeURIComponent(runId)}/signal`, {
      method: "POST",
      body: JSON.stringify({ kind: "client_result", callId, result }),
    }),
  );
}
