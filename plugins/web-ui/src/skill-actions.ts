export function skillActions(s: { id?: string; editable?: boolean }): { edit: boolean; delete: boolean } {
  const owned = s.editable === true && typeof s.id === "string" && s.id !== "";
  return { edit: owned, delete: owned };
}
