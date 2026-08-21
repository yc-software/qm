import { isView, type View } from "./shell-state.ts";

export type BootDestination =
  | { kind: "app-edit"; slug: string }
  | { kind: "view"; view: View; item: string | null }
  | { kind: "session"; sessionId: string }
  | { kind: "provider"; provider: string }
  | { kind: "bare" };

export function resolveBootDestination(input: {
  wanted: string | null;
  sessionId: string | null;
  item: string | null;
  connectedProvider: string | null;
  appSlug: string | null;
}): BootDestination {
  if (input.wanted === "app-edit") return { kind: "app-edit", slug: (input.appSlug ?? "").toLowerCase() };
  if (isView(input.wanted) && input.wanted !== "chats") return { kind: "view", view: input.wanted, item: input.item };
  if (input.sessionId) return { kind: "session", sessionId: input.sessionId };
  if (input.connectedProvider) return { kind: "provider", provider: input.connectedProvider };
  return { kind: "bare" };
}
