import type { WorkBlock } from "./core-bridge";
import { activityItems } from "./items";

let embedderOrigin: string | null = null;

export function hasEmbedder(): boolean {
  return embedderOrigin !== null;
}

export function tellEmbedder(message: Record<string, unknown>): void {
  if (embedderOrigin) window.parent.postMessage(message, embedderOrigin);
}

export function answerEmbedder(request: string, answer: () => void): void {
  window.addEventListener("message", (event) => {
    if (window.parent === window || event.source !== window.parent || event.origin === "null") return;
    if (event.data?.type !== request) return;
    embedderOrigin = event.origin;
    answer();
  });
}

export function tellEmbedderOfFinishedTools(): (work: WorkBlock) => void {
  let toldThrough = 0;
  return (work) => {
    const finished = activityItems(work.activity).findLast((item) => item.kind === "ToolResult");
    if (!finished || finished.seq <= toldThrough) return;
    toldThrough = finished.seq;
    tellEmbedder({ type: "qm:app-check" });
  };
}
