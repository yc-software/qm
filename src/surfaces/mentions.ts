export const SLACK_MENTION = /(?<!<)<+@([A-Z0-9]+)(?:\|([^<>]*))?(?:>|(?=<))/g;

export function resolveMentions(text: string, nameById: ReadonlyMap<string, string> | undefined): string {
  if (!nameById || !text.includes("<@")) return text;
  return text.replace(SLACK_MENTION, (m, id) => {
    const name = nameById.get(id);
    return name ? `@${name}` : m;
  });
}
