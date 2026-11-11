import { fetchServerSentEvents } from "@tanstack/ai-client";
import { errMessage } from "../../chassis/src/errors.ts";
import { askEmbedder, hasEmbedder } from "./embedder.ts";
import { activityItems, type RunActivityEntry } from "./items.ts";

export const APP_SCREENSHOT_TOOL = "ui__app_screenshot";
const SHOT_TIMEOUT_MS = 40_000;

type Result = {
  content: string;
  isError?: boolean;
  images?: Array<{ data: string; mimeType: "image/png" | "image/jpeg" }>;
};

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
  brightness?: number;
  version?: string | null;
  consoleErrors?: string[];
};

export function appViewClientTools(): Array<Record<string, unknown>> {
  if (!hasEmbedder() || !document.body.classList.contains("app-edit-embed")) return [];
  return [
    {
      name: APP_SCREENSHOT_TOOL,
      description:
        "Take a screenshot of the app exactly as the person sees it right now in their own browser tab: their sign-in, data, theme and scroll position. Waits for the tab to load the newest saved version first. Returns the picture plus the page address, viewport size, light or dark mode, and console errors since the page loaded.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: 45_000,
    },
  ];
}

export function shotResult(shot: AppShot): Result {
  if (!shot.ok || !shot.image || !shot.mimeType)
    return { content: `Screenshot failed: ${shot.error ?? "the page returned no image."}`, isError: true };
  const errors = shot.consoleErrors ?? [];
  const lines = [
    `Page: ${shot.url ?? "unknown"}`,
    `Viewport: ${shot.width}×${shot.height}${shot.scrollY ? `, scrolled ${shot.scrollY}px down` : ""}`,
    `Color scheme: the browser prefers ${shot.dark ? "dark" : "light"}${
      typeof shot.brightness === "number"
        ? `; the page renders mostly ${shot.brightness < 110 ? "dark" : "light"} (average brightness ${shot.brightness}/255)`
        : ""
    }`,
    ...(shot.version ? [`App version shown: ${shot.version}`] : []),
    errors.length
      ? `Console errors since load (${errors.length}):\n${errors.join("\n")}`
      : "Console errors since load: none",
  ];
  return { content: lines.join("\n"), images: [{ data: shot.image, mimeType: shot.mimeType }] };
}

export async function takeAppShot(): Promise<Result> {
  try {
    return shotResult(await askEmbedder<AppShot>({ type: "qm:app-shot" }, "qm:app-shot-result", SHOT_TIMEOUT_MS));
  } catch (error) {
    return { content: `Screenshot failed: ${errMessage(error)}`, isError: true };
  }
}

type ViewRun = { status?: string; alive?: boolean; activity?: RunActivityEntry[] };

export function createAppViewExecutor(
  shoot: () => Promise<Result>,
  send: (callId: string, result: Result) => Promise<unknown>,
) {
  const handled = new Set<string>();
  return async (run: ViewRun): Promise<void> => {
    if (run.status !== "running" || !run.alive) return;
    const items = activityItems(run.activity ?? []);
    const complete = new Set(items.filter((item) => item.kind === "ToolResult").map((item) => item.callId));
    for (const item of items) {
      const callId = item.callId;
      if (
        item.kind !== "ToolCall" ||
        item.body.client !== true ||
        item.tool !== APP_SCREENSHOT_TOOL ||
        !callId ||
        complete.has(callId) ||
        handled.has(callId)
      )
        continue;
      handled.add(callId);
      await send(callId, await shoot());
    }
  };
}

export async function serveAppViewRun(
  runId: string,
  base: (path: string) => string,
  send: (path: string, init: RequestInit) => Promise<unknown>,
): Promise<void> {
  const controller = new AbortController();
  const execute = createAppViewExecutor(takeAppShot, (callId, result) =>
    send(`/api/runs/${encodeURIComponent(runId)}/signal`, {
      method: "POST",
      body: JSON.stringify({ kind: "client_result", callId, result }),
    }),
  );
  const transport = fetchServerSentEvents(base(`/api/runs/${encodeURIComponent(runId)}/events`), {
    credentials: "same-origin",
  });
  for await (const event of transport.joinRun(runId, controller.signal)) {
    if (event.type !== "CUSTOM" || event.name !== "run") continue;
    const run = event.value as ViewRun;
    if (run.status === "done" || run.status === "failed" || run.status === "cancelled") break;
    void execute(run);
  }
  controller.abort();
}
