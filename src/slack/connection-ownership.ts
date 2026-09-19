import { createHash } from "node:crypto";

const owners = new Map<string, symbol>();

export function createSlackConnectionOwnership() {
  const owner = Symbol();
  const held = new Set<string>();
  return {
    reserve(kind: "bot token" | "app token" | "bot identity" | "socket app", value: string): void {
      const key = `${kind}:${createHash("sha256").update(value.trim()).digest("hex")}`;
      const existing = owners.get(key);
      if (existing && existing !== owner) throw new Error(`Slack ${kind} already has an active connection`);
      owners.set(key, owner);
      held.add(key);
    },
    release(): void {
      for (const key of held) if (owners.get(key) === owner) owners.delete(key);
      held.clear();
    },
  };
}

export function assertSlackEventIdentity(
  body: Record<string, unknown>,
  expected: { teamId: string; appId: string },
): void {
  const team = body.team as { id?: unknown } | undefined;
  const view = body.view as { app_installed_team_id?: unknown; app_id?: unknown } | undefined;
  const authorization = (body.authorizations as { team_id?: unknown }[] | undefined)?.[0];
  const teamId =
    body.type === "event_callback"
      ? (authorization?.team_id ?? body.team_id)
      : (view?.app_installed_team_id ?? team?.id ?? body.team_id);
  const appId = body.api_app_id ?? view?.app_id;
  if (!expected.teamId || teamId !== expected.teamId || !expected.appId || appId !== expected.appId)
    throw new Error("Slack event does not belong to this installation");
}
