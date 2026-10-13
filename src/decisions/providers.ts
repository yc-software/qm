import { posix } from "node:path";
import { asError, type DecisionBackend, type DecisionProvider, type DecisionQuestion } from "./decisions.ts";

const MAX_RESPONSE_BYTES = 1_000_000;

async function readCapped(response: Response): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of (response.body ?? []) as AsyncIterable<Uint8Array>) {
    if (size + chunk.byteLength > MAX_RESPONSE_BYTES) {
      const prefix = Buffer.concat([...chunks, Buffer.from(chunk.subarray(0, 300))])
        .subarray(0, 300)
        .toString("utf8");
      throw new Error(`classifier HTTP ${response.status}: response over ${MAX_RESPONSE_BYTES} bytes: ${prefix}`);
    }
    size += chunk.byteLength;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const sample = (value: unknown) =>
  String((typeof value === "string" ? value : JSON.stringify(value)) ?? value).slice(0, 500);

function parseJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`classifier returned invalid JSON: ${sample(text)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`classifier returned a non-object JSON body: ${sample(text)}`);
  return parsed as Record<string, unknown>;
}

function normalize(
  probabilities: Record<string, unknown>,
  options: Record<string, string>,
  response: unknown,
): Record<string, number> {
  const unknown = Object.keys(probabilities).filter((k) => !Object.hasOwn(options, k));
  if (unknown.length)
    throw new Error(`classifier returned unconfigured options ${unknown.join(", ")}: ${sample(response)}`);
  const out: Record<string, number> = {};
  let total = 0;
  for (const key of Object.keys(options)) {
    const p = probabilities[key];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0)
      throw new Error(
        `classifier returned an invalid probability for ${key}: ${String(JSON.stringify(p) ?? p).slice(0, 200)} in ${sample(response)}`,
      );
    out[key] = p;
    total += p;
  }
  if (!(total > 0) || !Number.isFinite(total))
    throw new Error(`classifier returned no usable probabilities: ${sample(response)}`);
  for (const key of Object.keys(out)) out[key] = out[key]! / total;
  return out;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal,
  });
  const text = await readCapped(response);
  if (!response.ok) throw new Error(`classifier HTTP ${response.status}: ${text.slice(0, 300)}`);
  return parseJson(text);
}

function choiceProbabilities(answer: unknown): Record<string, unknown> {
  const a = (answer ?? {}) as { probabilities?: unknown };
  if (!Array.isArray(a.probabilities)) return (a.probabilities ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const p of a.probabilities as ({ value?: unknown; probability?: unknown } | null)[]) {
    if (!p || typeof p !== "object") throw new Error(`malformed probability entry: ${sample(answer)}`);
    const key = String(p.value);
    if (Object.hasOwn(out, key)) throw new Error(`duplicate probability for ${key}: ${sample(answer)}`);
    out[key] = p.probability;
  }
  return out;
}

type Questions = Record<string, DecisionQuestion>;
const typesafeQuestions = (questions: Questions) =>
  Object.fromEntries(
    Object.entries(questions).map(([k, q]) => [k, { type: "choice", instructions: q.question, criteria: q.options }]),
  );
const byKey = (answers: unknown) => (k: string) => ((answers ?? {}) as Record<string, unknown>)[k];

const PROTOCOLS: Record<
  DecisionProvider["protocol"],
  {
    path: string;
    request: (model: string, questions: Questions, state: string) => unknown;
    answers: (body: Record<string, unknown>) => (key: string) => unknown;
  }
> = {
  decisions: {
    path: "/decisions",
    request: (model, questions, state) => ({
      model,
      questions: Object.entries(questions).map(([name, q]) => ({
        type: "choice",
        name,
        instructions: q.question,
        choices: Object.entries(q.options).map(([value, description]) => ({ value, description })),
      })),
      input: state,
    }),
    answers: (body) => {
      if (!Array.isArray(body.answers)) throw new Error(`decisions response has no answers array: ${sample(body)}`);
      return (k) => (body.answers as ({ name?: string } | null)[]).find((a) => a?.name === k);
    },
  },
  systemone: {
    path: "/systemone",
    request: (model, questions, state) => ({ model, questions: typesafeQuestions(questions), state }),
    answers: (body) => byKey(body.answers),
  },
  "chat-completions": {
    path: "/chat/completions",
    request: (model, questions, state) => ({
      model,
      messages: [],
      typesafe: { questions: typesafeQuestions(questions), state },
    }),
    answers: (body) => {
      const content = (body.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error(`classifier returned no message content: ${sample(body)}`);
      const parsed = parseJson(content);
      return byKey(parsed.answers ?? parsed);
    },
  },
};

export function createDecisionBackend(opts: {
  providers: () => readonly DecisionProvider[] | Promise<readonly DecisionProvider[]>;
  gateway?: { url: string; apiKey: string; apiKeyHeader?: string };
  credential: (slug: string) => Promise<{ host: string; enabled: boolean; header: [string, string] } | null>;
  fetch?: typeof fetch;
}): DecisionBackend {
  const fetchImpl = opts.fetch ?? fetch;
  const endpoint = async (provider: DecisionProvider): Promise<{ base: string; auth: Record<string, string> }> => {
    if (!provider.baseUrl) {
      if (!opts.gateway) throw new Error(`decision provider ${provider.id}: no model gateway is configured`);
      const header = opts.gateway.apiKeyHeader;
      return {
        base: opts.gateway.url,
        auth: header ? { [header]: opts.gateway.apiKey } : { authorization: `Bearer ${opts.gateway.apiKey}` },
      };
    }
    const rec = await opts.credential(provider.credential!);
    if (!rec?.enabled)
      throw new Error(`decision provider ${provider.id}: credential ${provider.credential} is missing or disabled`);
    const url = new URL(provider.baseUrl);
    if (url.host !== rec.host)
      throw new Error(
        `decision provider ${provider.id}: credential ${provider.credential} is for ${rec.host}, not ${url.host}`,
      );
    return { base: provider.baseUrl, auth: { [rec.header[0]]: rec.header[1] } };
  };
  return {
    async choose({ questions, state, model, signal }) {
      signal.throwIfAborted();
      const provider = (await opts.providers()).find((p) => p.id === model.provider);
      if (!provider) throw new Error(`decision provider ${model.provider} is not configured`);
      const { base, auth } = await endpoint(provider);
      const keys = Object.keys(questions);
      const wire = PROTOCOLS[provider.protocol];
      const url = new URL(base);
      url.pathname = posix.join(url.pathname, wire.path);
      const body = await postJson(fetchImpl, url.toString(), auth, wire.request(model.model, questions, state), signal);
      const answers = wire.answers(body);
      return Object.fromEntries(
        keys.map((k) => {
          try {
            const answer = answers(k);
            if ((answer as { type?: string } | undefined)?.type === "refusal")
              throw new Error(`decision provider refused: ${sample(answer)}`);
            return [k, normalize(choiceProbabilities(answer), questions[k]!.options, body)];
          } catch (error) {
            return [k, asError(error)];
          }
        }),
      );
    },
  };
}
