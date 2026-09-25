export function utcMinute(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")}Z`;
}
