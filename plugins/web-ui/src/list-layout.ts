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
