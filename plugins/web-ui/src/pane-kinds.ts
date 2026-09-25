import type { IconNode } from "lucide";
import type { DensityTier } from "./density";

export interface PaneKind {
  paramsKey: string;
  glyph: IconNode;
  title(id: string): string;
  badge(id: string): number;
  mount(opts: {
    host: HTMLElement;
    id: string;
    density: () => DensityTier;
    onDensityChange: (handler: () => void) => void;
  }): { dispose(): void };
  maximize(id: string): void;
}

const paneKinds: PaneKind[] = [];

export function registerPaneKind(kind: PaneKind): void {
  paneKinds.push(kind);
}

export function paneKindByKey(paramsKey: string): PaneKind | null {
  return paneKinds.find((kind) => kind.paramsKey === paramsKey) ?? null;
}

export function paneKindEntry(params: Record<string, string | undefined>): { kind: PaneKind; id: string } | null {
  for (const kind of paneKinds) {
    const id = params[kind.paramsKey];
    if (id) return { kind, id };
  }
  return null;
}
