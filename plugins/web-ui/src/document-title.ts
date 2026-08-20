export function formatWebDocumentTitle(brand: string, conversationTitle: string | null | undefined): string {
  const label = brand.trim() || "QM";
  const title = conversationTitle?.trim();
  return title ? `${title} · ${label}` : `${label} · Web`;
}
