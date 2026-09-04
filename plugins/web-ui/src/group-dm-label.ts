export interface GroupDmLabel {
  names: string[];
  text: string;
  count: number;
}

function cleanMpdmPart(part: string): string {
  return part.trim().replace(/-\d+$/u, "").replace(/-/g, " ").trim();
}

export function groupDmLabel(name: string | null | undefined): GroupDmLabel | null {
  const raw = (name ?? "").trim().replace(/^#/u, "");
  if (!raw) return null;
  const names = raw.startsWith("mpdm-")
    ? raw.slice("mpdm-".length).split("--").map(cleanMpdmPart).filter(Boolean)
    : raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
  if (!names.length) return null;
  return { names, text: names.join(", "), count: names.length };
}

export function groupDmText(name: string | null | undefined): string | null {
  return groupDmLabel(name)?.text ?? null;
}
