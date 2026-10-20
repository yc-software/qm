import { getTokenizer } from "@anthropic-ai/tokenizer";

let tokenizer: ReturnType<typeof getTokenizer> | undefined;

const CHUNK_CHARS = 4_000;
const SAMPLE_CAP_CHARS = 64_000;

export function countAllTokens(text: string): number {
  tokenizer ??= getTokenizer();
  let n = 0;
  for (let i = 0; i < text.length; i += CHUNK_CHARS) {
    n += tokenizer.encode(text.slice(i, i + CHUNK_CHARS).normalize("NFKC"), "all").length;
  }
  return n;
}

export function countTokens(text: string): number {
  if (text.length <= SAMPLE_CAP_CHARS) return countAllTokens(text);
  return Math.ceil((countAllTokens(text.slice(0, SAMPLE_CAP_CHARS)) * text.length) / SAMPLE_CAP_CHARS);
}
