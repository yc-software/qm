export function filePreviewKind(name: string, mimetype = ""): "markdown" | "csv" | "tsv" | "text" | null {
  const mime = mimetype.split(";", 1)[0].trim().toLowerCase();
  if (/\.(md|markdown)$/i.test(name) || mime === "text/markdown") return "markdown";
  if (/\.tsv$/i.test(name) || mime === "text/tab-separated-values") return "tsv";
  if (/\.csv$/i.test(name) || mime === "text/csv") return "csv";
  if (
    /\.(txt|text|log|json|jsonl|yaml|yml|toml|ini|cfg|conf|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|c|h|cpp|hpp|cs|swift|kt|sh|bash|zsh|sql|graphql|gql|vue|svelte|r|lua|php|pl|ex|exs|erl|clj|diff|patch)$/i.test(
      name,
    ) ||
    /^(Dockerfile|Makefile|\.gitignore|\.env)$/i.test(name) ||
    mime.startsWith("text/") ||
    /^application\/(json|[^/]+\+json|yaml|x-yaml|toml|xml|[^/]+\+xml|javascript|x-sh)$/.test(mime)
  )
    return "text";
  return null;
}

export function previewFile(event: MouseEvent, name: string, href: string, mimetype?: string): void {
  const kind = filePreviewKind(name, mimetype);
  if (!kind || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  void import("./file-viewer.ts")
    .then(({ openFileViewer }) => openFileViewer(name, href, kind, mimetype))
    .catch(() => window.open(href, "_blank", "noopener,noreferrer"));
}
