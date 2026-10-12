export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

export function likeContains(s: string): string {
  return `%${likeEscape(s)}%`;
}
