export function sideChatExcerpt(quote: string): string {
  return `${quote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n\n`;
}

export function withoutSideChatExcerpt(text: string, quote: string | undefined): string {
  const excerpt = quote ? sideChatExcerpt(quote) : "";
  return excerpt && text.startsWith(excerpt) ? text.slice(excerpt.length) : text;
}
