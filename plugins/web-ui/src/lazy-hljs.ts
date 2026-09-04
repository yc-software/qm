type HighlightResult = { value: string };
type Hljs = {
  registerLanguage: (name: string, lang: unknown) => void;
  getLanguage: (name: string) => unknown;
  highlight: (code: string, opts: { language: string }) => HighlightResult;
  highlightAuto: (code: string) => HighlightResult;
};

let real: Hljs | null = null;
let loading: Promise<void> | null = null;

const LANGS = ["javascript", "typescript", "python", "xml", "css", "json", "bash", "sql", "markdown"] as const;
const LANG_ALIASES: Record<string, string> = { html: "xml" };

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function rerenderMountedBlocks(): void {
  if (typeof document === "undefined") return;
  for (const el of document.querySelectorAll("code-block")) {
    (el as { requestUpdate?: () => void }).requestUpdate?.();
  }
}

function ensureLoading(): void {
  loading ??= Promise.all([
    import("hljs-real"),
    import("hljs-real-javascript"),
    import("hljs-real-typescript"),
    import("hljs-real-python"),
    import("hljs-real-xml"),
    import("hljs-real-css"),
    import("hljs-real-json"),
    import("hljs-real-bash"),
    import("hljs-real-sql"),
    import("hljs-real-markdown"),
  ])
    .then(([core, ...langs]: Array<{ default: unknown }>) => {
      const hljs = core.default as Hljs;
      LANGS.forEach((name, i) => hljs.registerLanguage(name, (langs[i] as { default: unknown }).default));
      for (const [alias, target] of Object.entries(LANG_ALIASES)) {
        hljs.registerLanguage(
          alias,
          (langs[LANGS.indexOf(target as (typeof LANGS)[number])] as { default: unknown }).default,
        );
      }
      real = hljs;
      rerenderMountedBlocks();
    })
    .catch(() => {
      loading = null;
    });
}

const facade: Hljs = {
  registerLanguage(): void {},
  getLanguage(name: string): unknown {
    return real ? real.getLanguage(name) : undefined;
  },
  highlight(code: string, opts: { language: string }): HighlightResult {
    if (real) return real.highlight(code, opts);
    ensureLoading();
    return { value: escapeHtml(code) };
  },
  highlightAuto(code: string): HighlightResult {
    if (real) return real.highlightAuto(code);
    ensureLoading();
    return { value: escapeHtml(code) };
  },
};

export default facade;
