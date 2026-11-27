import { LitElement, html, nothing } from "lit";
import { marked, type Tokens } from "marked";
import { api } from "./core-bridge";
import { htmlPreviewCard } from "./html-preview";
import { appTitle, type AppView } from "./app-view";
import { reportHandledError } from "./browser-errors";
import { appState } from "./shell";

const APP_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";

const appsByOrigin = new Map<string, AppView>();
const lookedUp = new Set<string>();
let loading: Promise<void> | null = null;

async function loadApps(): Promise<void> {
  const { apps } = await api<{ apps?: AppView[] }>("/api/apps");
  appsByOrigin.clear();
  for (const app of apps ?? []) {
    if (app.status === "running" && app.webUrl) appsByOrigin.set(new URL(app.webUrl, location.href).origin, app);
  }
}

function appLinkCandidates(text: string): { href: string; origin: string }[] {
  const domain = appState.me?.appsDomain;
  if (!domain) return [];
  const hrefs = new Set<string>();
  marked.walkTokens(marked.lexer(text), (token) => {
    if (token.type === "link") hrefs.add((token as Tokens.Link).href);
  });
  return [...hrefs].flatMap((href) => {
    const url = URL.parse(href);
    return url?.protocol === "https:" && url.hostname.endsWith(`.${domain}`) ? [{ href, origin: url.origin }] : [];
  });
}

export interface AppLink {
  href: string;
  app: AppView;
}

export async function appLinksIn(text: string): Promise<AppLink[]> {
  const links = appLinkCandidates(text);
  if (links.some(({ origin }) => !appsByOrigin.has(origin) && !lookedUp.has(origin))) {
    for (const { origin } of links) lookedUp.add(origin);
    loading ??= loadApps().finally(() => (loading = null));
  }
  if (loading) await loading;
  const shown = new Set<string>();
  return links.flatMap(({ href, origin }) => {
    const app = appsByOrigin.get(origin);
    if (!app || shown.has(app.id)) return [];
    shown.add(app.id);
    return [{ href, app }];
  });
}

export class AppPreviews extends LitElement {
  static properties = { text: {}, links: { state: true } };

  declare text: string;
  declare links: AppLink[];

  constructor() {
    super();
    this.text = "";
    this.links = [];
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has("text")) return;
    const text = this.text;
    appLinksIn(text).then(
      (links) => {
        if (this.text === text) this.links = links;
      },
      (error: unknown) => reportHandledError("app link previews", error),
    );
  }

  render() {
    if (!this.links.length) return nothing;
    return html`<div class="message-files">
      ${this.links.map(({ href, app }) =>
        htmlPreviewCard({ name: appTitle(app), src: href, open: href, sandbox: APP_FRAME_SANDBOX }),
      )}
    </div>`;
  }
}

if (!customElements.get("qm-app-previews")) customElements.define("qm-app-previews", AppPreviews);
