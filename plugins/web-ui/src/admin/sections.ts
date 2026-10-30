export const ADMIN_SECTIONS = [
  {
    label: "Organization",
    views: ["governance", "models", "credentials", "connectors", "slack-settings", "customize", "users", "spend"],
  },
  { label: "Logs", views: ["history", "slack", "judgments", "errors", "audit", "egress"] },
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
  slack: "Slack messages",
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
