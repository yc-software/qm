import { errMessage } from "../../../chassis/src/errors.ts";
import { webFetch } from "../core-bridge.ts";

export const ADMIN_SECTIONS = [
  {
    label: "Organization",
    views: ["governance", "models", "credentials", "connectors", "slack-settings", "customize", "users", "spend"],
  },
  { label: "Logs", views: ["history", "judgments", "errors", "audit", "egress"] },
  { label: "Artifacts", views: ["files", "skills", "memory", "deployments", "crons"] },
];

const ADMIN_VIEWS = new Set([
  ...ADMIN_SECTIONS.flatMap((section) => section.views),
  "onboarding",
  "user",
  "ackemoji",
  "keychain",
]);

export const VIEW_TITLE: Record<string, string> = {
  general: "General",
  onboarding: "Onboarding",
  governance: "Governance",
  models: "Models",
  credentials: "Credentials",
  customize: "Customize",
  connectors: "Connectors",
  users: "Users",
  keychain: "Keychain",
  user: "User",
  spend: "Spend",
  egress: "Egress",
  history: "Sessions",
  files: "Files",
  memory: "Memory",
  errors: "Errors",
  audit: "Audit",
  skills: "Skills",
  crons: "Crons",
  deployments: "Apps",
  "slack-settings": "Slack",
  judgments: "Judgments",
  ackemoji: "Ack emoji",
};

const decode = (segment: string | undefined) => {
  try {
    return segment ? decodeURIComponent(segment) : null;
  } catch {
    return null;
  }
};

export function settingsRoute(base: string) {
  const params = new URLSearchParams(location.search);
  const rel = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : "";
  const [first, kind, id] = rel.replace(/^\/+/, "").split("/");
  const path = decode(first);
  const history = path === "history";
  const session = (history && kind === "s" ? decode(id) : null) || params.get("session") || null;
  const slackStep = ["setup", "install", "connected"].includes(params.get("slack") ?? "");
  const raw = params.get("setup") === "slack" || slackStep ? "slack-settings" : params.get("view") || path;
  const named = raw === "skill-packs" ? "skills" : (raw ?? "");
  const fallback = session || raw ? "history" : "general";
  const view = ADMIN_VIEWS.has(named) ? named : fallback;
  return { view, params, session, pathScope: history && kind === "scopes" ? decode(id) : null };
}

interface AdminResponse<T = any> {
  ok: boolean;
  status: number;
  data: T;
}

export interface AdminPage {
  view: string;
  host: HTMLElement;
  org: string;
  orgScope: string;
  scope: string;
  session: string | null;
  params: URLSearchParams;
  apiBase: string;
  api: <T = any>(method: string, path: string, body?: unknown) => Promise<AdminResponse<T>>;
  href: (view: string, params?: Record<string, string | number | null | undefined>, path?: string) => string;
  go: (url: string, replace?: boolean) => void;
  current: () => boolean;
}

type AdminModule = { mount: (page: AdminPage) => void | Promise<void> };

const pages = {
  governance: () => import("./governance.ts"),
  onboarding: () => import("./onboarding.ts"),
  models: () => import("./settings.ts"),
  credentials: () => import("./settings.ts"),
  customize: () => import("./settings.ts"),
  connectors: () => import("./integrations.ts"),
  "slack-settings": () => import("./integrations.ts"),
  users: () => import("./users.ts"),
  user: () => import("./users.ts"),
  keychain: () => import("./users.ts"),
  spend: () => import("./spend.ts"),
  history: () => import("./history.ts"),
  judgments: () => import("./slack-activity.ts"),
  ackemoji: () => import("./slack-activity.ts"),
  errors: () => import("./activity.ts"),
  audit: () => import("./activity.ts"),
  egress: () => import("./activity.ts"),
  files: () => import("./artifacts.ts"),
  memory: () => import("./artifacts.ts"),
  deployments: () => import("./artifacts.ts"),
  crons: () => import("./artifacts.ts"),
  skills: () => import("./artifacts-skills.ts"),
} as Record<string, () => Promise<AdminModule>>;

const loadAdminPage = (view: string) =>
  Promise.all([import("./entry.ts"), pages[view]!()]).then(([, module]) => module);

async function adminApi(base: string, method: string, path: string, body?: unknown): Promise<AdminResponse> {
  let res: Response;
  let text: string;
  try {
    res = await webFetch(base + (path.startsWith("/api/") ? path.slice("/api".length) : path), {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    text = await res.text();
  } catch (error) {
    console.warn("[swallowed] admin api: request failed", method, path, errMessage(error));
    return { ok: false, status: 0, data: { message: "Network request failed." } };
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    console.warn("[swallowed] admin api: non-JSON response", method, path, res.status, errMessage(error));
  }
  return { ok: res.ok, status: res.status, data };
}

function settingsHref(
  base: string,
  view: string,
  params: Record<string, string | number | null | undefined> = {},
  path = "",
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value != null && value !== "") query.set(key, String(value));
  const url = view === "general" ? base : `${base}/${encodeURIComponent(view)}${path}`;
  return query.size ? `${url}?${query}` : url;
}

export function adminMounter(options: {
  base: string;
  apiBase: string;
  org: () => string;
  host: (view: string) => HTMLElement;
  go: (url: string, replace?: boolean) => void;
}): () => Promise<void> {
  let mounts = 0;
  return async () => {
    const route = settingsRoute(options.base);
    const token = ++mounts;
    const host = options.host(route.view);
    const module = await loadAdminPage(route.view);
    if (token !== mounts) return;
    const org = options.org();
    await module.mount({
      view: route.view,
      host,
      org,
      orgScope: `org:${org}`,
      scope: route.pathScope || route.params.get("scope") || `org:${org}`,
      session: route.session,
      params: route.params,
      apiBase: options.apiBase,
      api: (method, path, body) => adminApi(options.apiBase, method, path, body),
      href: (view, params, path) => settingsHref(options.base, view, params, path),
      go: options.go,
      current: () => token === mounts && host.isConnected,
    });
  };
}
