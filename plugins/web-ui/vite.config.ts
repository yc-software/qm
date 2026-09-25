import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const SERVER = process.env.WEB_UI_SERVER_URL ?? "http://localhost:8096";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

const PRECOMPRESS_EXTENSIONS = new Set([".js", ".mjs", ".css", ".svg", ".json", ".map", ".wasm", ".txt"]);
const PRECOMPRESS_MIN_BYTES = 1024;

function precompressDirectory(dir: string): { files: number; raw: number; packed: number } {
  const totals = { files: 0, raw: 0, packed: 0 };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = precompressDirectory(path);
      totals.files += nested.files;
      totals.raw += nested.raw;
      totals.packed += nested.packed;
      continue;
    }
    if (!entry.isFile() || !PRECOMPRESS_EXTENSIONS.has(extname(entry.name))) continue;
    const size = statSync(path).size;
    if (size < PRECOMPRESS_MIN_BYTES) continue;
    const packed = gzipSync(readFileSync(path), { level: 9 });
    writeFileSync(`${path}.gz`, packed);
    totals.files += 1;
    totals.raw += size;
    totals.packed += packed.length;
  }
  return totals;
}

export function precompressStaticAssets(): Plugin {
  let outDir = "";
  return {
    name: "qm-precompress-static-assets",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const { files, raw, packed } = precompressDirectory(outDir);
      const mib = (n: number): string => `${(n / 1048576).toFixed(2)} MiB`;
      this.info(`precompressed ${files} assets: ${mib(raw)} -> ${mib(packed)} gzip`);
    },
  };
}

export default defineConfig({
  base: process.env.WEB_UI_BASE ?? "/",
  plugins: [precompressStaticAssets()],
  resolve: {
    alias: [
      { find: /^katex$/, replacement: here("src/lazy-katex.ts") },
      { find: "katex-real", replacement: here("node_modules/katex/dist/katex.mjs") },
      { find: /^highlight\.js\/lib\/core$/, replacement: here("src/lazy-hljs.ts") },
      { find: "hljs-real-javascript", replacement: here("node_modules/highlight.js/lib/languages/javascript.js") },
      { find: "hljs-real-typescript", replacement: here("node_modules/highlight.js/lib/languages/typescript.js") },
      { find: "hljs-real-python", replacement: here("node_modules/highlight.js/lib/languages/python.js") },
      { find: "hljs-real-xml", replacement: here("node_modules/highlight.js/lib/languages/xml.js") },
      { find: "hljs-real-css", replacement: here("node_modules/highlight.js/lib/languages/css.js") },
      { find: "hljs-real-json", replacement: here("node_modules/highlight.js/lib/languages/json.js") },
      { find: "hljs-real-bash", replacement: here("node_modules/highlight.js/lib/languages/bash.js") },
      { find: "hljs-real-sql", replacement: here("node_modules/highlight.js/lib/languages/sql.js") },
      { find: "hljs-real-markdown", replacement: here("node_modules/highlight.js/lib/languages/markdown.js") },
      { find: "hljs-real", replacement: here("node_modules/highlight.js/lib/core.js") },
      { find: /^highlight\.js\/lib\/languages\/.*$/, replacement: here("src/hljs-lang-stub.ts") },
    ],
  },
  build: {
    outDir: "dist-web",
    rollupOptions: { input: { main: here("index.html"), shared: here("shared.html") } },
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    proxy: {
      "/signin": SERVER,
      "/share": SERVER,
      "/me": SERVER,
      "/api": SERVER,
    },
  },
});
