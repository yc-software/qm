import { marked } from "marked";
import DOMPurify, { type Config } from "dompurify";

export const MARKDOWN_SANITIZE_CONFIG: Config = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_TAGS: ["annotation", "semantics"],
  ADD_ATTR: ["target", "encoding"],
};

const SANDBOX_WORKSPACE_LINK = /\shref=(["'])sandbox:\/home\/sprite\/workspace\/([^"']+)\1/gi;

function decodedBasename(path: string): string | null {
  const encoded = path.split("/").at(-1);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function rewriteSandboxFileLinks(html: string): string {
  return html.replace(SANDBOX_WORKSPACE_LINK, (match, quote: string, path: string) => {
    const name = decodedBasename(path);
    if (!name) return match;
    const href = `/api/files/by-name/content?name=${encodeURIComponent(name)}`;
    return ` href=${quote}${href}${quote}`;
  });
}

let installed = false;

export function installMarkdownSanitizer(): void {
  if (installed) return;
  installed = true;
  marked.use({
    hooks: {
      postprocess: (html: string) =>
        String(DOMPurify.sanitize(rewriteSandboxFileLinks(html), MARKDOWN_SANITIZE_CONFIG)),
    },
  });
}
