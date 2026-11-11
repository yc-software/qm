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

export function askEmbedder<T>(message: Record<string, unknown>, replyType: string, timeoutMs: number): Promise<T> {
  const origin = embedderOrigin;
  if (!origin) return Promise.reject(new Error("The app page is not connected to this chat."));
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const done = (): void => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== window.parent || event.origin !== origin) return;
      if (event.data?.type !== replyType || event.data?.id !== id) return;
      done();
      resolve(event.data as T);
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`The app page did not answer within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ ...message, id }, origin);
  });
}
