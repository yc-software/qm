import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let captureScript: string | undefined;

export function appThumbnailCaptureScript(): string {
  captureScript ??= readFileSync(fileURLToPath(import.meta.resolve("html-to-image/dist/html-to-image.js")), "utf8");
  return captureScript;
}

export const THUMBNAIL_JS = String.raw`
  let thumbnailed = thumbnailVersion;
  let thumbnailTimer;
  const loadCapture = (doc) => new Promise((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = "/__claw__/thumbnail.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("could not load /__claw__/thumbnail.js"));
    doc.head.append(script);
  });
  const pageBackground = (doc) => {
    const view = doc.defaultView;
    for (const el of [doc.body, doc.documentElement]) {
      const color = view.getComputedStyle(el).backgroundColor;
      if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
    }
    return "#ffffff";
  };
  const captureThumbnail = async () => {
    if (base === null) await poll();
    if (bare || document.hidden || base === null || upd.classList.contains("show")) return;
    const version = Number(base.split(":")[0]);
    if (!Number.isInteger(version) || version === thumbnailed) return;
    const win = app.contentWindow;
    const doc = app.contentDocument;
    if (!doc?.body || doc.URL === "about:blank") return;
    const status = win.performance.getEntriesByType("navigation")[0]?.responseStatus;
    if (status && status >= 400) return;
    if (!win.htmlToImage) await loadCapture(doc);
    const width = win.innerWidth;
    const height = Math.round((width * 3) / 4);
    const dataUrl = await win.htmlToImage.toJpeg(doc.documentElement, {
      quality: 0.8, width, height, canvasWidth: 640, canvasHeight: 480,
      backgroundColor: pageBackground(doc),
    });
    const image = await (await fetch(dataUrl)).blob();
    const r = await fetch("/__claw__/thumbnail?version=" + version, {
      method: "POST", headers: { "content-type": "image/jpeg" }, body: image,
    });
    if (!r.ok) throw new Error("thumbnail upload failed: " + r.status);
    thumbnailed = version;
  };
  app.addEventListener("load", () => {
    clearTimeout(thumbnailTimer);
    thumbnailTimer = setTimeout(() => captureThumbnail().catch((e) => console.warn("QM app thumbnail:", e)), 2500);
  });
`;
