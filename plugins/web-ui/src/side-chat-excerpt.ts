export function sideChatExcerpt(quote: string): string {
  return `${quote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n\n`;
}
