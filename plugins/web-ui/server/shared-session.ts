export function sharedSessionHtml(template: string, transcript: unknown): string {
  const json = JSON.stringify(transcript).replace(/</g, "\\u003c");
  return template.replace(
    /<script id="shared-transcript" type="application\/json">\s*null\s*<\/script>/,
    () => `<script id="shared-transcript" type="application/json">${json}</script>`,
  );
}
