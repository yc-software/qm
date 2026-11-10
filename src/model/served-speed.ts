import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

const SPEED = /"speed"\s*:\s*"([a-z_]+)"/;
const TAIL = 64;

export interface ServedSpeed {
  speed?: string;
}

export function speedSniffingFetch(base: typeof fetch, served: ServedSpeed): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (!response.body) return response;
    const decoder = new TextDecoder();
    let tail = "";
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (served.speed === undefined) {
            const text = tail + decoder.decode(chunk, { stream: true });
            served.speed = SPEED.exec(text)?.[1];
            tail = text.slice(-TAIL);
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export function stampServedSpeed<S extends { push(event: AssistantMessageEvent): void }>(
  stream: S,
  served: ServedSpeed,
): S {
  const push = stream.push.bind(stream);
  stream.push = (event: AssistantMessageEvent) => {
    if (event.type === "done") Object.assign(event.message, { servedSpeed: served.speed ?? "standard" });
    push(event);
  };
  return stream;
}

export function servedFast(requested: boolean | undefined, servedSpeed: string | undefined): boolean | undefined {
  return servedSpeed === undefined ? requested : servedSpeed === "fast";
}
