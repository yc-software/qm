type Katex = { renderToString: (text: string, opts?: object) => string };

let real: Katex | null = null;
let loading: Promise<void> | null = null;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function rerenderMountedBlocks(): void {
  if (typeof document === "undefined") return;
  for (const el of document.querySelectorAll("markdown-block")) {
    (el as { requestUpdate?: () => void }).requestUpdate?.();
  }
}

function ensureLoading(): void {
  loading ??= import("katex-real")
    .then((m: { default: Katex }) => {
      real = m.default;
      rerenderMountedBlocks();
    })
    .catch(() => {
      loading = null;
    });
}

const facade: Katex = {
  renderToString(text: string, opts?: object): string {
    if (real) return real.renderToString(text, opts);
    ensureLoading();
    return `<span class="math-pending">${escapeHtml(text)}</span>`;
  },
};

export default facade;
