export type Usage = { calls: number; promptTokens: number; completionTokens: number };

export function newUsage(): Usage {
  return { calls: 0, promptTokens: 0, completionTokens: 0 };
}

export async function chat(model: string, prompt: string, usage?: Usage, system?: string): Promise<string> {
  const url = `${process.env.MODEL_GATEWAY_URL}/v1/chat/completions`;
  const messages = system ? [{ role: "system", content: system }, { role: "user", content: prompt }] : [{ role: "user", content: prompt }];
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MODEL_GATEWAY_TOKEN}` },
        body: JSON.stringify({ model, messages, max_tokens: 4000, cache: { "no-cache": true } }),
      });
      if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      if (usage) {
        usage.calls++;
        usage.promptTokens += body.usage?.prompt_tokens ?? Math.ceil(prompt.length / 4);
        usage.completionTokens += body.usage?.completion_tokens ?? 0;
      }
      return body.choices[0]?.message?.content ?? "";
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export function parseJson<T>(text: string): T {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = m ? m[1] : text;
  const start = raw.search(/[[{]/);
  return JSON.parse(raw.slice(start, Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]")) + 1)) as T;
}

export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}
