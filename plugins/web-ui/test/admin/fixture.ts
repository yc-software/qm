import { build } from "esbuild";
import emojiSource from "emoji-datasource/emoji.json" with { type: "json" };
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { emojiTableModule } from "../../src/emoji-source.ts";
import { ADMIN_MARKUP } from "../../src/admin/markup.ts";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const EMOJI_TABLE = here("../../src/emoji-table.ts");

async function bundle(entry: string, globalName: string): Promise<string> {
  const result = await build({
    entryPoints: [here(entry)],
    bundle: true,
    write: false,
    format: "iife",
    globalName,
    platform: "browser",
    target: "es2022",
    loader: { ".css": "empty" },
    logLevel: "silent",
    plugins: [
      {
        name: "emoji-table",
        setup(build) {
          build.onLoad({ filter: /emoji-table\.ts$/ }, ({ path }) =>
            path === EMOJI_TABLE ? { contents: emojiTableModule(emojiSource), loader: "js" } : undefined,
          );
        },
      },
    ],
  });
  return result.outputFiles[0]!.text;
}

const adminBundle = await bundle("../../src/admin/admin.ts", "governanceUI");
let controllerBundle: Promise<string> | null = null;

export function litFixture(options: { markup?: boolean } = {}) {
  const dom = new JSDOM('<!doctype html><body><main id="root"></main></body>', {
    runScripts: "outside-only",
    url: "http://localhost/settings",
  });
  dom.window.structuredClone = structuredClone;
  if (options.markup) dom.window.document.body.innerHTML = ADMIN_MARKUP;
  dom.window.eval(adminBundle + ";window.ui = governanceUI;");
  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    root: dom.window.document.getElementById("root")!,
    ui: (dom.window as any).ui,
  };
}

export type Reply = object | string | number | boolean | null;
export type Route = (request: { method: string; path: string; url: URL; body: any }) => Reply | Promise<Reply>;

export interface AdminRequest {
  method: string;
  path: string;
  url: URL;
  body: any;
}

export async function mountAdmin(
  url: string,
  routes: Record<string, Reply | Route> = {},
  options: { org?: string; productName?: string; confirm?: (message: string) => boolean } = {},
) {
  controllerBundle ??= bundle("../../src/admin/controller.js", "adminController");
  const code = await controllerBundle;
  const jsdomErrors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => jsdomErrors.push(error.message));
  const dom = new JSDOM('<!doctype html><body><div id="app-view" class="admin-app"></div></body>', {
    runScripts: "outside-only",
    virtualConsole,
    url: new URL(url, "http://localhost").href,
    pretendToBeVisual: true,
  });
  const window = dom.window as any;
  window.structuredClone = structuredClone;
  window.HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  window.HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView ??= () => {};
  window.confirm = options.confirm ?? (() => true);
  window.alert = () => {};
  const requests: AdminRequest[] = [];
  const views: string[] = [];
  window.fetch = async (input: string, init: RequestInit = {}) => {
    const target = new URL(String(input), window.location.href);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : (init.body ?? null);
    const path = target.pathname.replace(/^\/api\/admin/, "");
    const request = { method, path, url: target, body };
    requests.push(request);
    const decoded = decodeURIComponent(path);
    const handler = routes[`${method} ${path}`] ?? routes[path] ?? routes[`${method} ${decoded}`] ?? routes[decoded];
    let reply: any = typeof handler === "function" ? await (handler as Route)(request) : handler;
    if (reply instanceof Response) return reply;
    if (reply === undefined) reply = { status: 404, body: { message: "not found" } };
    const framed =
      reply && typeof reply === "object" && ("status" in reply || "body" in reply) ? reply : { body: reply };
    return new Response(framed.body === undefined ? "" : JSON.stringify(framed.body), {
      status: framed.status ?? 200,
      headers: { "content-type": "application/json", ...framed.headers },
    });
  };
  window.eval(code + ";window.adminController = adminController;");
  const host = window.document.getElementById("app-view") as HTMLElement;
  const controller = window.adminController.startAdmin(host, {
    org: options.org ?? "acme",
    productName: options.productName ?? "QM",
    apiBase: "/api/admin",
    pageBase: "/settings",
    onView: (view: string) => views.push(view),
  });
  return {
    dom,
    window,
    document: window.document as Document,
    host,
    controller,
    requests,
    views,
    jsdomErrors,
    location: () => window.location.pathname + window.location.search,
    settle: async (rounds = 5) => {
      for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    close: () => dom.window.close(),
  };
}

export const adminShell = () =>
  `<!doctype html><html><head></head><body><div id="app-view">${ADMIN_MARKUP}</div></body></html>`;
