const MAX_ANNOTATION_TEXT = 20_000;
const MAX_ANNOTATION_BYTES = 20 * 1024 * 1024;

// The app bar posts page annotations (note text plus a screenshot) into this embedded
// chat. Only the app's own shell, i.e. our direct parent on `<slug>.<apps domain>`,
// may do so; the composer receives them like a paste, and nothing is sent until the
// person presses send.
export function watchAppAnnotations(slug: string, add: (text: string, files: File[]) => boolean): () => void {
  const seen = new Set<string>();
  const onMessage = (event: MessageEvent): void => {
    if (window.parent === window || event.source !== window.parent) return;
    const data = event.data as { type?: unknown; id?: unknown; text?: unknown; files?: unknown } | null;
    if (data?.type !== "qm:annotations" || typeof data.id !== "string" || typeof data.text !== "string") return;
    let host: string;
    try {
      host = new URL(event.origin).hostname;
    } catch {
      return;
    }
    if (!host.startsWith(`${slug}.`)) return;
    const files = Array.isArray(data.files)
      ? data.files.filter(
          (f): f is File => f instanceof File && f.type === "image/png" && f.size <= MAX_ANNOTATION_BYTES,
        )
      : [];
    if (!seen.has(data.id)) {
      if (!add(data.text.slice(0, MAX_ANNOTATION_TEXT), files.slice(0, 1))) return;
      seen.add(data.id);
    }
    (event.source as Window).postMessage({ type: "qm:annotations-ack", id: data.id }, event.origin);
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
