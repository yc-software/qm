import type { ToolActivity } from "./core-bridge";

const MAX_PLAYGROUNDS_PER_MESSAGE = 5;

export interface PlaygroundArtifact {
  kind: "playground";
  artifactId: string;
  title: string;
}

/** Only the two fields the scan needs, so a transcript entry and a live one both fit. */
export type PlaygroundActivity = Pick<ToolActivity, "type" | "payload">;

function playgroundFromPayload(payload: unknown): PlaygroundArtifact | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const display = value.display;
  if (value.tool !== "miniapp" || value.isError === true || !display || typeof display !== "object") return null;
  const artifact = (display as Record<string, unknown>).artifact;
  if (!artifact || typeof artifact !== "object") return null;
  const typed = artifact as Record<string, unknown>;
  if (
    typed.kind !== "playground" ||
    typeof typed.artifactId !== "string" ||
    !typed.artifactId ||
    typeof typed.title !== "string" ||
    !typed.title.trim()
  )
    return null;
  return { kind: "playground", artifactId: typed.artifactId, title: typed.title };
}

export function playgroundsIn(activity: readonly PlaygroundActivity[] | undefined): PlaygroundArtifact[] {
  const seen = new Set<string>();
  const playgrounds: PlaygroundArtifact[] = [];
  for (const entry of activity ?? []) {
    if (entry.type !== "tool_result") continue;
    const playground = playgroundFromPayload(entry.payload);
    if (!playground || seen.has(playground.artifactId)) continue;
    seen.add(playground.artifactId);
    playgrounds.push(playground);
  }
  return playgrounds.slice(0, MAX_PLAYGROUNDS_PER_MESSAGE);
}

export function playgroundPath(artifactId: string, source = false): string {
  return `/api/playgrounds/${encodeURIComponent(artifactId)}${source ? "?source=1" : ""}`;
}
