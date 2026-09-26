import { createHash } from "node:crypto";
import { payloadLengths, type SeedPlan } from "./seed.ts";
import { syntheticWords } from "./seed-activity.ts";

type Payload = { body: string; payload: Record<string, unknown> };

export function bindSearchText(text: string, identity: string): string {
  return text.replace(/\b0q[a-z]+\b/g, (word) => {
    const hash = createHash("md5")
      .update(`${identity}:${word}`)
      .digest("hex")
      .replace(/[0-9a-f]/g, (c) => "abcdefghijklmnop"[Number.parseInt(c, 16)]!);
    return hash.repeat(Math.ceil(word.length / hash.length)).slice(0, word.length);
  });
}

export const SEARCH_BINDING_SQL = `CREATE FUNCTION pg_temp.perf_bind_search(payload jsonb, identity text) RETURNS jsonb LANGUAGE plpgsql AS $body$
DECLARE body text; word text; replacement text;
BEGIN
  IF jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR strpos(payload->>'text','0q')=0 THEN RETURN payload; END IF;
  body := payload->>'text';
  FOR word IN SELECT DISTINCT m[1] FROM regexp_matches(body,'\\m(0q[a-z]+)\\M','g') m LOOP
    replacement := translate(md5(identity||':'||word),'0123456789abcdef','abcdefghijklmnop');
    body := regexp_replace(body,'\\m'||word||'\\M',left(repeat(replacement,1+length(word)/32),length(word)),'g');
  END LOOP;
  RETURN jsonb_set(payload,'{text}',to_jsonb(body));
END $body$`;

export function searchPayloads(kind: string, input: Payload[], aggregates: SeedPlan["aggregates"]): Payload[] {
  const vector = aggregates.search_native_vector_widths?.find((r) => r.type === kind);
  if (!vector || !["user", "assistant", "text"].includes(kind)) return input;
  const vocabulary = aggregates.search_sample_vocabulary_shape?.find((r) => r.type === kind);
  const control = aggregates.search_lexical_generation?.find((r) => r.type === kind);
  if (!vocabulary || !control) throw new Error("Search calibration requires vocabulary and generation evidence");
  const sampled = Number(vocabulary.sampled_rows);
  const distinct = Number(vocabulary.distinct_sample_lexemes);
  const singleton = Number(vocabulary.singleton_lexemes);
  const pairs = Number(vocabulary.document_lexeme_pairs);
  const power = Number(control.frequency_exponent);
  if (
    ![sampled, distinct, singleton, pairs].every(Number.isSafeInteger) ||
    sampled < 1 ||
    singleton < 0 ||
    distinct <= singleton ||
    pairs < distinct ||
    !Number.isFinite(power) ||
    power <= 0 ||
    power > 4
  )
    throw new Error("Invalid search vocabulary calibration");
  const poolSize = distinct - singleton;
  const widths = payloadLengths(
    { values: vocabulary.lexeme_bytes, max_bytes: vocabulary.lexeme_bytes_max },
    "values",
    Number(vocabulary.lexeme_bytes_mean),
    2,
  );
  const frequencies = payloadLengths(
    { values: vocabulary.documents_per_lexeme, max_bytes: vocabulary.max_documents_per_lexeme },
    "values",
    pairs / distinct,
    1,
  );
  const degrees = payloadLengths(
    { values: vector.lexemes_quantiles, max_bytes: vector.lexemes_max },
    "values",
    Number(vector.lexemes_mean),
    1,
  );
  const words: string[] = [];
  const seen = new Set<string>();
  const cdf: number[] = [];
  let weight = 0;
  for (let i = 0; i < poolSize; i++) {
    const width = widths[Math.min(1023, Math.floor((i * 1024) / poolSize))]!;
    let word = "";
    for (let attempt = 0; attempt < 10000; attempt++) {
      word = syntheticWords(`${kind}:vocabulary:${i}:${attempt}`, width, 1, width, poolSize);
      if (!seen.has(word)) break;
    }
    if (seen.has(word)) throw new Error("Measured vocabulary cannot fit its word widths");
    seen.add(word);
    words.push(word);
    cdf.push((weight += frequencies[Math.max(0, 1023 - Math.floor((i * 1024) / distinct))]! ** power));
  }
  let visible = 0;
  const count = input.filter((r) => r.body.trim()).length;
  return input.map((row, bucket) => {
    if (!row.body.trim()) return row;
    if (row.payload.text !== row.body) throw new Error("Search body does not match its native payload field");
    const rank = Math.min(1023, Math.floor((visible++ * 1024) / count));
    let state = createHash("sha256").update(`${kind}:${bucket}`).digest().readUInt32LE(0) || 1;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
    const prefixes = [
      "```text\nQM performance fixture\n```\n",
      "| Fixture | Value |\n| --- | --- |\n| QM | performance |\n",
      "QM performance fixture ",
    ];
    const prefix = prefixes.find((p) => row.body.startsWith(p)) ?? "";
    const fixedTerms = new Set(prefix.toLowerCase().match(/[a-z]+/g) ?? []).size;
    const bytes = row.body.length - prefix.length;
    const newlines = row.body.split("\n").length - prefix.split("\n").length;
    const letterBudget = bytes - newlines;
    const desired = Math.max(
      0,
      Math.min(degrees[rank]! - fixedTerms, Math.floor((bytes + 1) / 3), Math.floor(letterBudget / 2)),
    );
    const selected = new Set<string>();
    let used = 0;
    const rare = Math.floor((desired * singleton) / pairs + random());
    for (let i = 0; i < rare; i++) {
      let n = i;
      let code = "";
      do {
        code += String.fromCharCode(97 + (n % 26));
        n = Math.floor(n / 26);
      } while (n);
      const width = Math.max(4, code.length + 3, widths[Math.floor(random() * 1024)]!);
      if (
        used + width + (selected.size ? 1 : 0) > bytes ||
        used - Math.max(0, selected.size - 1) + width > letterBudget
      )
        continue;
      const word = ("0q" + code + "y").padEnd(width, "z");
      selected.add(word);
      used += word.length + (selected.size > 1 ? 1 : 0);
    }
    for (let tries = 0; selected.size < desired && tries < 100000; tries++) {
      const value = random() * weight;
      let low = 0,
        high = cdf.length - 1;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (cdf[mid]! >= value) high = mid;
        else low = mid + 1;
      }
      const word = words[low]!;
      if (
        selected.has(word) ||
        used + word.length + (selected.size ? 1 : 0) > bytes ||
        used - Math.max(0, selected.size - 1) + word.length > letterBudget
      )
        continue;
      selected.add(word);
      used += word.length + (selected.size > 1 ? 1 : 0);
    }
    const chosen = [...selected];
    let body = chosen.join(" ");
    let letters = used - Math.max(0, selected.size - 1);
    const shortest = Math.min(...chosen.map((word) => word.length));
    for (let tries = 0; body.length < bytes && tries < 100000 && chosen.length; tries++) {
      if (body.length + 1 + shortest > bytes || letters + shortest > letterBudget) break;
      const word = chosen[Math.floor(random() * chosen.length)]!;
      if (body.length + 1 + word.length <= bytes && letters + word.length <= letterBudget) {
        body += " " + word;
        letters += word.length;
      } else if (bytes - body.length < 3) break;
    }
    body = body.padEnd(bytes, " ");
    const spaces = Array.from(body.matchAll(/ /g), (m) => m.index);
    if (spaces.length < newlines) throw new Error("Search word shape cannot preserve measured newlines");
    const chars = [...body];
    for (let i = 0; i < newlines; i++) chars[spaces[Math.floor((i * spaces.length) / newlines)]!] = "\n";
    body = prefix + chars.join("");
    if (!body.trim()) body = row.body;
    return { body, payload: { ...row.payload, text: body } };
  });
}
