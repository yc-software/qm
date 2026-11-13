import { validIcon } from "./suggested-activities.ts";

export interface WelcomeIdea {
  id: string;
  icon: string;
  title: string;
  src?: string;
  replaces?: string;
}

export interface WelcomeProfile {
  ideas: WelcomeIdea[];
  connectors: Record<string, WelcomeIdea[]>;
}

function parseIdeas(value: unknown): WelcomeIdea[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ideas: WelcomeIdea[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const { id, icon, title, src, replaces } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof title !== "string" || !title.trim()) return undefined;
    if (typeof icon !== "string" || !validIcon(icon)) return undefined;
    if ((src !== undefined && typeof src !== "string") || (replaces !== undefined && typeof replaces !== "string"))
      return undefined;
    ideas.push({ id, icon, title: title.trim(), ...(src ? { src } : {}), ...(replaces ? { replaces } : {}) });
  }
  return ideas;
}

export function parseWelcomeProfile(value: unknown): WelcomeProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { ideas, connectors } = value as Record<string, unknown>;
  const parsedIdeas = parseIdeas(ideas);
  if (!parsedIdeas?.length) return undefined;
  if (!connectors || typeof connectors !== "object" || Array.isArray(connectors)) return undefined;
  const parsedConnectors: Record<string, WelcomeIdea[]> = {};
  for (const [toolkit, items] of Object.entries(connectors)) {
    const parsed = parseIdeas(items);
    if (!parsed) return undefined;
    parsedConnectors[toolkit] = parsed;
  }
  return { ideas: parsedIdeas, connectors: parsedConnectors };
}
