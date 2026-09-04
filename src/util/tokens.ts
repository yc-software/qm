import { getTokenizer } from "@anthropic-ai/tokenizer";

let tokenizer: ReturnType<typeof getTokenizer> | undefined;

const CHUNK_CHARS = 4_000;
const SAMPLE_CAP_CHARS = 64_000;

export function countTokens(text: string): number {
  tokenizer ??= getTokenizer();
  const sample = text.length > SAMPLE_CAP_CHARS ? text.slice(0, SAMPLE_CAP_CHARS) : text;
  let n = 0;
  for (let i = 0; i < sample.length; i += CHUNK_CHARS) {
    n += tokenizer.encode(sample.slice(i, i + CHUNK_CHARS).normalize("NFKC"), "all").length;
  }
  return sample.length === text.length ? n : Math.ceil((n * text.length) / sample.length);
}
