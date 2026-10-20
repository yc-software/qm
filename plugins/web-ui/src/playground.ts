import { activityItems, type Item, type WorkActivity } from "./items.ts";

const MAX_PLAYGROUNDS_PER_MESSAGE = 5;

export interface PlaygroundArtifact {
  kind: "playground";
  artifactId: string;
  title: string;
}

function playgroundFromResult(item: Item): PlaygroundArtifact | null {
  const display = item.body.display;
  if (item.tool !== "miniapp" || item.isError === true || !display || typeof display !== "object") return null;
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

export function playgroundsIn(activity: readonly WorkActivity[] | undefined): PlaygroundArtifact[] {
  const seen = new Set<string>();
  const playgrounds: PlaygroundArtifact[] = [];
  for (const item of activityItems(activity ?? [])) {
    if (item.kind !== "ToolResult") continue;
    const playground = playgroundFromResult(item);
    if (!playground || seen.has(playground.artifactId)) continue;
    seen.add(playground.artifactId);
    playgrounds.push(playground);
  }
  return playgrounds.slice(0, MAX_PLAYGROUNDS_PER_MESSAGE);
}

export function playgroundPath(artifactId: string, source = false): string {
  return `/api/playgrounds/${encodeURIComponent(artifactId)}${source ? "?source=1" : ""}`;
}
