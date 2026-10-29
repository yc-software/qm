export const ADMIN_SECTIONS = [
  {
    label: "Organization",
    views: ["governance", "models", "credentials", "connectors", "slack-settings", "customize", "users", "spend"],
  },
  { label: "Logs", views: ["history", "slack", "judgments", "errors", "audit", "egress"] },
  { label: "Artifacts", views: ["files", "skills", "memory", "deployments", "crons"] },
];

export const ADMIN_VIEWS = new Set([
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
  live: "Live",
  errors: "Errors",
  audit: "Audit",
  skills: "Skills",
  crons: "Crons",
  deployments: "Apps",
  retention: "Retention",
  slack: "Slack messages",
  "slack-settings": "Slack",
  judgments: "Judgments",
  ackemoji: "Ack emoji",
};
