import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../src/types.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import {
  createGbrainClient,
  createGbrainMemory,
  isVisibleToScope,
  scopeMemoryPrefix,
  type GbrainClient,
} from "../src/memory/gbrain-memory-service.ts";

const SCOPE = scopeId("personal", "U0ALICE");

function stubBase(overrides: Partial<MemoryService> = {}): MemoryService {
  return {
    recall: async () => "",
    capture: async () => 1,
    query: async () => [],
    read: async () => "# Memory\n\n- (2026-08-01) alice ships on fridays",
    replace: async () => {},
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function toolResponse(text: string, status = 200): Response {
  return jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }, status);
}

function tokenResponse(value = "at-1", expiresIn = 3600): Response {
  return jsonResponse({ access_token: value, expires_in: expiresIn });
}

interface Call {
  url: string;
  init: RequestInit;
}

function recordingFetch(handlers: Array<(call: Call) => Response | undefined>): {
  calls: Call[];
  impl: typeof fetch;
} {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    for (const h of handlers) {
      const res = h(call);
      if (res) return res;
    }
    throw new Error(`unexpected fetch: ${call.url}`);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const clientOptions = (fetchImpl: typeof fetch, onError?: (e: unknown) => void) => ({
  mcpUrl: "https://brain.example.com/mcp",
  issuerUrl: "https://brain.example.com",
  clientId: "gbrain_cl_test",
  clientSecret: "gbrain_cs_test",
  fetchImpl,
  ...(onError ? { onError } : {}),
});

describe("scopeMemoryPrefix", () => {
  it("maps a scope to a lowercase slug-safe prefix carrying a digest of the exact scope id", () => {
    assert.match(scopeMemoryPrefix(scopeId("personal", "U0ALICE")), /^qm\/personal\/u0alice-[0-9a-f]{12}$/);
    assert.match(scopeMemoryPrefix(scopeId("channel", "C_123/../x")), /^qm\/channel\/c-123-x-[0-9a-f]{12}$/);
  });

  it("does not collide scopes that sanitise to the same segment", () => {
    assert.notEqual(scopeMemoryPrefix(scopeId("personal", "U_A")), scopeMemoryPrefix(scopeId("personal", "U-A")));
    assert.notEqual(scopeMemoryPrefix(scopeId("personal", "U1")), scopeMemoryPrefix(scopeId("channel", "U1")));
  });
});

describe("createGbrainMemory without a client", () => {
  it("returns the base service untouched", () => {
    const base = stubBase();
    assert.equal(createGbrainMemory(base, undefined), base);
  });
});

describe("createGbrainMemory query", () => {
  const clientStub = (search: GbrainClient["search"]): GbrainClient => ({
    search,
  });

  it("merges remote hits after local ones and dedupes", async () => {
    const base = stubBase({ query: async () => ["alice ships on fridays"] });
    const memory = createGbrainMemory(
      base,
      clientStub(async () => ["Alice ships on Fridays", "acme renewal closed in q3"]),
    );
    assert.deepEqual(await memory.query(SCOPE, "alice", 5), ["alice ships on fridays", "acme renewal closed in q3"]);
  });

  it("respects the limit", async () => {
    const base = stubBase({ query: async () => ["a"] });
    const memory = createGbrainMemory(
      base,
      clientStub(async () => ["b", "c", "d"]),
    );
    assert.deepEqual(await memory.query(SCOPE, "q", 2), ["a", "b"]);
  });

  it("does not call the brain when local results already fill the limit", async () => {
    let searched = false;
    const base = stubBase({ query: async () => ["a", "b"] });
    const memory = createGbrainMemory(
      base,
      clientStub(async () => {
        searched = true;
        return ["c"];
      }),
    );
    await memory.query(SCOPE, "q", 2);
    assert.equal(searched, false);
  });

  it("still returns local results when the brain fails", async () => {
    const base = stubBase({ query: async () => ["local only"] });
    const memory = createGbrainMemory(
      base,
      clientStub(async () => {
        throw new Error("brain down");
      }),
    );
    assert.deepEqual(await memory.query(SCOPE, "q", 5), ["local only"]);
  });
});

describe("createGbrainClient", () => {
  it("mints a token once and reuses it across calls", async () => {
    const { calls, impl } = recordingFetch([
      (c) => (c.url.endsWith("/token") ? tokenResponse() : undefined),
      (c) => (c.url.endsWith("/mcp") ? toolResponse("[]") : undefined),
    ]);
    const client = createGbrainClient(clientOptions(impl));
    await client.search(SCOPE, "q", 5);
    await client.search(SCOPE, "q", 5);
    assert.equal(calls.filter((c) => c.url.endsWith("/token")).length, 1);
    assert.equal(calls.filter((c) => c.url.endsWith("/mcp")).length, 2);
  });

  it("re-mints once on a 401 and retries the call", async () => {
    let mcpCalls = 0;
    const { calls, impl } = recordingFetch([
      (c) => (c.url.endsWith("/token") ? tokenResponse() : undefined),
      (c) => {
        if (!c.url.endsWith("/mcp")) return undefined;
        mcpCalls += 1;
        return mcpCalls === 1 ? new Response("nope", { status: 401 }) : toolResponse("[]");
      },
    ]);
    const client = createGbrainClient(clientOptions(impl));
    await client.search(SCOPE, "q", 5);
    assert.equal(calls.filter((c) => c.url.endsWith("/token")).length, 2);
    assert.equal(mcpCalls, 2);
  });

  it("sends the bearer token and a tools/call envelope", async () => {
    const { calls, impl } = recordingFetch([
      (c) => (c.url.endsWith("/token") ? tokenResponse("at-xyz") : undefined),
      (c) => (c.url.endsWith("/mcp") ? toolResponse("[]") : undefined),
    ]);
    await createGbrainClient(clientOptions(impl)).search(SCOPE, "renewal", 3);
    const mcp = calls.find((c) => c.url.endsWith("/mcp"))!;
    assert.equal((mcp.init.headers as Record<string, string>).authorization, "Bearer at-xyz");
    const body = JSON.parse(String(mcp.init.body)) as {
      method: string;
      params: { name: string; arguments: { query: string; limit: number } };
    };
    assert.equal(body.method, "tools/call");
    assert.equal(body.params.name, "search");
    assert.equal(body.params.arguments.query, "renewal");
    assert.ok((body.params.arguments.limit as number) >= 3);
  });

  it("parses structured search results into snippets", async () => {
    const { impl } = recordingFetch([
      (c) => (c.url.endsWith("/token") ? tokenResponse() : undefined),
      (c) =>
        c.url.endsWith("/mcp")
          ? toolResponse(
              JSON.stringify([
                { slug: "org/handbook", title: "Handbook", chunk_text: "we ship on   fridays" },
                { slug: "org/notes" },
              ]),
            )
          : undefined,
    ]);
    assert.deepEqual(await createGbrainClient(clientOptions(impl)).search(SCOPE, "q", 5), [
      "Handbook: we ship on fridays",
      "org/notes",
    ]);
  });

  it("reads results out of an SSE framed response", async () => {
    const sse = `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify([{ slug: "org/t", title: "T", chunk_text: "body" }]) }],
      },
    })}\n\n`;
    const { impl } = recordingFetch([
      (c) => (c.url.endsWith("/token") ? tokenResponse() : undefined),
      (c) =>
        c.url.endsWith("/mcp")
          ? new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
          : undefined,
    ]);
    assert.deepEqual(await createGbrainClient(clientOptions(impl)).search(SCOPE, "q", 5), ["T: body"]);
  });

  it("reports and swallows transport failures instead of throwing at the caller", async () => {
    const seen: unknown[] = [];
    const { impl } = recordingFetch([
      (c) => (c.url.endsWith("/token") ? new Response("no", { status: 500 }) : undefined),
    ]);
    const client = createGbrainClient(clientOptions(impl, (e) => seen.push(e)));
    assert.deepEqual(await client.search(SCOPE, "q", 5), []);
    assert.equal(seen.length, 1);
  });

  it("surfaces a tool-level error through onError", async () => {
    const seen: unknown[] = [];
    const { impl } = recordingFetch([
      (c) => (c.url.endsWith("/token") ? tokenResponse() : undefined),
      (c) =>
        c.url.endsWith("/mcp")
          ? jsonResponse({
              jsonrpc: "2.0",
              id: 1,
              result: { isError: true, content: [{ type: "text", text: "permission_denied" }] },
            })
          : undefined,
    ]);
    const client = createGbrainClient(clientOptions(impl, (e) => seen.push(e)));
    assert.deepEqual(await client.search(SCOPE, "q", 5), []);
    assert.match(String(seen[0]), /permission_denied/);
  });
});

describe("scope isolation of remote results", () => {
  const OTHER = scopeId("personal", "U0BOB");

  it("hides another scope's memory page from this scope", () => {
    assert.equal(isVisibleToScope(SCOPE, `${scopeMemoryPrefix(OTHER)}/memory`), false);
    assert.equal(isVisibleToScope(SCOPE, `${scopeMemoryPrefix(SCOPE)}/memory`), true);
  });

  it("keeps shared org pages visible", () => {
    assert.equal(isVisibleToScope(SCOPE, "org/handbook"), true);
  });

  it("drops rows with no slug, since visibility cannot be checked", () => {
    assert.equal(isVisibleToScope(SCOPE, undefined), false);
  });

  it("filters another scope's page out of live search results", async () => {
    const { impl } = recordingFetch([
      (c) => (c.url.endsWith("/token") ? tokenResponse() : undefined),
      (c) =>
        c.url.endsWith("/mcp")
          ? toolResponse(
              JSON.stringify([
                {
                  slug: `${scopeMemoryPrefix(OTHER)}/memory`,
                  title: "bob memory",
                  chunk_text: "bob is interviewing elsewhere",
                },
                { slug: "org/handbook", title: "Handbook", chunk_text: "we ship on fridays" },
                { slug: `${scopeMemoryPrefix(SCOPE)}/memory`, title: "my memory", chunk_text: "mine" },
              ]),
            )
          : undefined,
    ]);
    const hits = await createGbrainClient(clientOptions(impl)).search(SCOPE, "interview", 10);
    assert.equal(
      hits.some((h) => h.includes("interviewing elsewhere")),
      false,
    );
    assert.deepEqual(hits, ["Handbook: we ship on fridays", "my memory: mine"]);
  });
});
