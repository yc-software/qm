import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";

export type UiDocument = "index.html" | "shared.html";

const POINTER_TTL_MS = 10_000;
const RELEASE_ID = /^[a-f0-9]{16}$/;

export function createUiReleases(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/$/, "");
  let pointer: { id: string; readAt: number } | undefined;
  const documents = new Map<string, string>();

  async function get(path: string, timeoutMs = 5_000): Promise<Response> {
    const response = await fetchImpl(`${base}/${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${base}/${path}: HTTP ${response.status}`);
    }
    return response;
  }

  async function liveRelease(): Promise<string> {
    if (pointer && Date.now() - pointer.readAt < POINTER_TTL_MS) return pointer.id;
    try {
      const { id } = (await (await get("channels/live.json")).json()) as { id?: unknown };
      if (typeof id !== "string" || !RELEASE_ID.test(id)) throw new Error("channels/live.json names no release");
      pointer = { id, readAt: Date.now() };
    } catch (error) {
      if (!pointer) throw error;
      console.error(`[web-ui] live release pointer unreadable, keeping ${pointer.id}:`, String(error));
      pointer = { id: pointer.id, readAt: Date.now() };
    }
    return pointer.id;
  }

  return {
    async document(name: UiDocument): Promise<string> {
      const key = `${await liveRelease()}/${name}`;
      const cached = documents.get(key);
      if (cached !== undefined) return cached;
      const html = await (await get(`releases/${key}`)).text();
      if (documents.size >= 16) documents.clear();
      documents.set(key, html);
      return html;
    },
    async relayAsset(
      res: ServerResponse,
      path: string,
      headers: Record<string, string>,
      gzip: boolean,
    ): Promise<boolean> {
      for (const [suffix, encoding] of gzip
        ? ([
            [".gz", { "content-encoding": "gzip" }],
            ["", {}],
          ] as const)
        : ([["", {}]] as const)) {
        const headersArrived = new AbortController();
        const timer = setTimeout(() => headersArrived.abort(), 15_000);
        const upstream = await fetchImpl(`${base}${path}${suffix}`, { signal: headersArrived.signal }).finally(() =>
          clearTimeout(timer),
        );
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel();
          if (upstream.status !== 404)
            console.error(`[web-ui] asset ${path}${suffix}: release store answered HTTP ${upstream.status}`);
          continue;
        }
        res.writeHead(200, { ...headers, ...encoding, vary: "accept-encoding" });
        const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
        res.on("close", () => stream.destroy());
        stream.on("error", () => res.destroy());
        stream.pipe(res);
        return true;
      }
      return false;
    },
  };
}
