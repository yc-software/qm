import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const root = fileURLToPath(new URL("../../", import.meta.url));
const plugin = resolve(root, "plugins/web-ui");
const require = createRequire(import.meta.url);
const { build, transform } = require("esbuild");
const output = resolve(process.argv[2] ?? "/tmp/qm-resource-search-demo");
mkdirSync(output, { recursive: true });
const sourceDir = `${root}/plugins/web-ui/src`;
const resources = [
  {
    id: "demo-skill",
    kind: "skills",
    title: "release-review",
    snippet: "Review release notes, check rollout readiness, and prepare the launch checklist.",
  },
  {
    id: "demo-cron",
    kind: "crons",
    title: "Weekly release digest",
    snippet: "Summarize release progress every Monday at 9:00 AM for the launch team.",
  },
  { id: "demo-app", kind: "deploys", title: "Release dashboard", snippet: "release-dashboard" },
  { id: "group:demo-release", kind: "contexts", title: "Release planning", snippet: "Project" },
];
const chat = {
  sessionId: "demo-chat",
  title: "Release readiness review",
  scopeId: "personal:demo",
  seq: 1,
  entryType: "assistant",
  snippet: "The release checklist is ready. The remaining action is the staged rollout review.",
  createdAt: 1789473600000,
};
const stubs = {
  "./core-bridge": `export const userSendMessage=x=>x; export async function api(path) { const q=new URL(path,'http://demo').searchParams.get('q').toLowerCase(); const rows=path.includes('/resources/')?DEMO_RESOURCES:[DEMO_CHAT]; return {hits:rows.filter(r=>(r.title+' '+r.snippet).toLowerCase().includes(q)),failed:[],limited:[]}; }`,
  "./sessions": `export const sessionsState={list:[{id:'demo-chat',title:'Release readiness review'}]}; export const sessionTitle=s=>s.title; export async function refreshSessions(){} export async function openSession(){document.querySelector('#demo-status').textContent='Demo: opened Release readiness review';} export function startNewChat(){return {state:{agent:{prompt(){document.querySelector('#demo-status').textContent='Demo: QM would receive your search request';}}}}}`,
  "./session-list": `export const recencyGroup=()=> 'This week';`,
  "./browse": `export const destinations=()=>[{label:'Skills',blurb:'Browse reusable skills',href:'#skills'},{label:'Crons',blurb:'Browse scheduled work',href:'#crons'},{label:'Apps',blurb:'Browse deployed apps',href:'#apps'},{label:'Projects',blurb:'Browse shared projects',href:'#projects'}];`,
  "./ui": `import {createElement} from 'lucide'; export const icon=(node,size=18)=>createElement(node,{class:'icon',width:size,height:size,'aria-hidden':'true',focusable:'false','stroke-width':1.9});`,
};
const css = readFileSync(`${sourceDir}/shell.css`, "utf8");
const paletteCss = css.slice(css.indexOf(".chat-search-overlay {"), css.indexOf(".nav-badge {"));
const variables = css.slice(css.indexOf(":root {"), css.indexOf(".layout {"));
const reset = `:root{--background:white;--foreground:#171717;--border:#e5e5e5;--muted-foreground:#737373;--primary:#171717;--primary-foreground:white}*{box-sizing:border-box}button,input{font:inherit}h1{font-size:22px}main{padding:30px;max-width:900px;margin:auto}a{color:#4338ca}#demo-status{position:fixed;bottom:20px;left:24px}nav{display:flex;gap:16px;margin:15px 0}.chat-search-cancel{display:none}`;
const style = (await transform(reset + variables + paletteCss, { loader: "css", minify: true, legalComments: "none" }))
  .code;
for (const mode of ["after", "before"]) {
  const source =
    mode === "after"
      ? readFileSync(`${sourceDir}/search.ts`, "utf8")
      : execFileSync("git", ["show", `${process.argv[3] ?? "e0966ba8"}:plugins/web-ui/src/search.ts`], {
          cwd: root,
          encoding: "utf8",
        });
  const result = await build({
    stdin: {
      contents:
        source.replace(
          "location.assign(hit.href);",
          "document.querySelector('#demo-status').textContent = 'Demo navigation: ' + hit.href;",
        ) +
        `\nregisterChatSearchHotkey();document.querySelector('#open').onclick=openChatSearch;openChatSearch();const input=document.querySelector('.chat-search-input');input.value='release';input.dispatchEvent(new Event('input',{bubbles:true}));`,
      resolveDir: sourceDir,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    define: { "import.meta": "{}", DEMO_RESOURCES: JSON.stringify(resources), DEMO_CHAT: JSON.stringify(chat) },
    minify: true,
    legalComments: "none",
    nodePaths: [resolve(plugin, "node_modules")],
    plugins: [
      {
        name: "demo-services",
        setup(b) {
          b.onResolve({ filter: /^\.\/(core-bridge|sessions|session-list|browse|ui)$/ }, (a) => ({
            path: a.path,
            namespace: "demo",
          }));
          b.onLoad({ filter: /.*/, namespace: "demo" }, (a) => ({
            contents: stubs[a.path],
            resolveDir: sourceDir,
            loader: "js",
          }));
        },
      },
    ],
  });
  const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const title = mode === "after" ? "After: resource and chat search" : "Before: chat search";
  writeFileSync(
    `${output}/resource-search-${mode}.html`,
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${style}</style><main><h1>${title}</h1><p>Interactive demo using the actual search component and synthetic data. No network requests, backend, or production identifiers.</p><nav><a href="resource-search-before.html">Before</a><a href="resource-search-after.html">After</a><button id="open">Open search</button></nav><p>Search for “release”, “dashboard”, or “digest”. Use arrow keys to select results. Escape closes the palette.</p></main><div id="demo-status" role="status"></div><script>${js}</script></html>`,
  );
}

console.log(`Open ${output}/resource-search-after.html in a browser.`);
