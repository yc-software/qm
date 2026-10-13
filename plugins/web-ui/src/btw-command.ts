export const BTW_COMMAND_ITEM = {
  name: "btw",
  description: "Ask a side question without interrupting this chat",
  scope: "",
};

export function parseBtw(draft: string): string | null {
  const m = /^\/btw(?:\s+([\s\S]*))?$/i.exec(draft.trim());
  return m ? (m[1] ?? "").trim() : null;
}

export const btwPrompt = (question: string): string =>
  `(btw: side question. The main conversation continues separately; just answer this briefly.)\n\n${question}`;
