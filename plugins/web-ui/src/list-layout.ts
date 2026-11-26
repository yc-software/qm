import type { TemplateResult } from "lit";
import { listSelect } from "./list-page";

export type ListLayout = "list" | "grid";

export function readListLayout(key: string): ListLayout {
  try {
    return localStorage.getItem(key) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function saveListLayout(key: string, layout: ListLayout): void {
  try {
    localStorage.setItem(key, layout);
  } catch {
    void 0;
  }
}

export function listLayoutSelect(layout: ListLayout, onChange: (layout: ListLayout) => void): TemplateResult {
  return listSelect(
    "View",
    layout,
    [
      ["list", "List"],
      ["grid", "Grid"],
    ],
    (value) => onChange(value === "grid" ? "grid" : "list"),
  );
}
