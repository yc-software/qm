import { CLIENT_TOOL_MAX_TIMEOUT_MS } from "../../chassis/src/client-tools.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import {
  createClientToolExecutor,
  postClientResult,
  type ClientToolResult,
  type ClientToolRun,
} from "./client-tools.ts";
import { askEmbedder, hasEmbedder } from "./embedder.ts";

export const APP_SCREENSHOT_TOOL = "ui__app_screenshot";

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
  notDrawn?: string[];
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
        "Take a screenshot of the app exactly as the person sees it right now in their own browser tab: their sign-in, data, theme and scroll position. Use it after changing how the app looks, to check the result before saying it is done. Waits for the tab to load the newest saved version first. The picture shows only the color scheme the person is using now, light or dark; it cannot show the other one. Returns the picture plus the page address, viewport size, and that color scheme.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: CLIENT_TOOL_MAX_TIMEOUT_MS,
    },
  ];
}

export function shotResult(shot: AppShot): ClientToolResult {
  if (!shot.ok || !shot.image || !shot.mimeType)
    return { content: `Screenshot failed: ${shot.error ?? "the page returned no image."}`, isError: true };
  const lines = [
    `Page: ${shot.url ?? "unknown"}`,
    `Viewport: ${shot.width}×${shot.height}${shot.scrollY ? `, scrolled ${shot.scrollY}px down` : ""}`,
    `Color scheme: ${shot.dark ? "dark" : "light"}`,
    ...(shot.version ? [`App version shown: ${shot.version}`] : []),
    ...(shot.notDrawn?.length
      ? [`Not drawn in the picture (shown as gray boxes or fallback fonts):\n${shot.notDrawn.join("\n")}`]
      : []),
  ];
  return { content: lines.join("\n"), images: [{ data: shot.image, mimeType: shot.mimeType }] };
}

async function takeAppShot(): Promise<ClientToolResult> {
  try {
    return shotResult(
      await askEmbedder<AppShot>({ type: "qm:app-shot" }, "qm:app-shot-result", CLIENT_TOOL_MAX_TIMEOUT_MS),
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
  return createClientToolExecutor(APP_SCREENSHOT_TOOL, takeAppShot, postClientResult(send, runId));
}
