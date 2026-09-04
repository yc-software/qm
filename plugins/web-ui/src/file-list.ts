export interface FileListFilterState {
  query: string;
  type: "all" | "image" | "document" | "other";
  ownership: "all" | "owned" | "shared";
  sort: "newest" | "oldest" | "name";
}

export function fileListNeedsAllPages(filters: FileListFilterState): boolean {
  return (
    Boolean(filters.query.trim()) ||
    filters.type !== "all" ||
    filters.ownership === "owned" ||
    filters.sort !== "newest"
  );
}
