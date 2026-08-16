export type AuthMode = "portal" | "dev";

export interface Me {
  user: string;
  org: string;
  mode?: AuthMode;
  slackWorkspaceUrl?: string | null;
  impersonatedBy?: string | null;
  permissions?: string[];
}

const VIEWS = ["chats", "contexts", "webhooks", "crons", "files", "keychain", "deploys", "memory", "skills"] as const;
export type View = (typeof VIEWS)[number];

export function isView(view: string | null | undefined): view is View {
  return (VIEWS as readonly (string | null | undefined)[]).includes(view);
}

export const appState = {
  me: null as Me | null,
  currentView: "chats" as View,
  viewRenderSeq: 0,
  topEl: null as HTMLElement | null,
  listEl: null as HTMLElement | null,
  mainEl: null as HTMLElement | null,
};

export function can(key: string): boolean {
  return appState.me?.permissions?.includes(key) === true;
}
