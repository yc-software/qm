# Milvus / PGVector Memory Provider for QM

Venkat M (Prithvi Monangi, Staff SWE at Walmart Global Tech). Background: built Milvus-backed vector search for 15M-user POS auth platform at Walmart (4B+ daily vectors, sub-10ms recall, K8s/Istio deployment).

## Problem

QM's memory system currently supports three provider types:
1. **`default`** — In-memory / PostgreSQL notebook
2. **`memorable`** — Procedural memory via external CLI
3. **`mcp`** — Generic MCP server (read/write operations)

For **semantic search** and **vector-based recall** at org scale, teams need a native vector DB provider that:
- Stores embeddings alongside text with scope tags
- Supports similarity search filtered by scope (`personal`, `team`, `org`)
- Integrates with QM's automatic post-turn capture
- Works with existing security postures and deployment model

**Gap**: No provider reads/writes directly from a vector database. All semantic recall currently routes through MCP → external server, losing native QM features (scope-aware routes, capture policies, health checks).

---

## Proposed Approach

Implement `src/memory/milvus-memory-provider.ts` — a native `MemoryService` backed by **Milvus** (primary) or **PostgreSQL + pgvector** (optional).

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Memory Provider Router (provider-router.ts)                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Route: scope=["personal","team","org"]              │    │
│  │  Provider: milvus                                   │    │
│  │  Capture: automatic (post-turn)                      │    │
│  │  Manage: true (explicit writes)                       │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Milvus Memory Provider                                      │
│  ├── recall(query) → vector similarity search               │
│  │   1. Embed query (local model or remote embedding API)   │
│  │   2. Search Milvus top-k similar entries                 │
│  │   3. Filter by scope tags in payload                     │
│  ├── query() → keyword filter (optional)                    │
│  ├── capture(entry) → upsert embedding + text to Milvus     │
│  └── manage() → read/write metadata, delete by scope        │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Milvus Service (External)                                  │
│  • Collection: qm_memory                                    │
│  • Schema: { text, embedding, scope, tags, created_at }     │
│  • Connection: Milvus REST API (no new SDK dependency)      │
└─────────────────────────────────────────────────────────────┘
```

### Provider Config Schema

Add to `src/memory/provider-config.ts`:

```typescript
export interface MilvusMemoryProviderConfig {
  type: "milvus";
  
  /** Milvus server endpoint (HTTP) */
  url: string;
  
  /** Authentication */
  auth: {
    token?: string;           // Milvus token
    accessKey?: string;       // Zilliz Cloud
    secretKey?: string;       // Zilliz Cloud
  };
  
  /** Collection name */
  collection?: string;  // default: "qm_memory"
  
  /** Embedding model for indexing queries */
  embeddingModel?: string;  // e.g. "openai:text-embedding-3-small"
  
  /** Max results per recall */
  recallLimit?: number;  // default: 10
  
  /** Token budget for recall (truncate long results) */
  recallMaxTokens?: number;  // default: 8000
  
  /** Optional PostgreSQL failover for metadata */
  postgresUrl?: string;
}
```

### Interface Implementation

In `src/memory/milvus-memory-provider.ts`:

```typescript
import type { MemoryService, SessionEntry } from "./memory-service.ts";
import type { MilvusMemoryProviderConfig } from "./provider-config.ts";
import type { McpFetch } from "../mcp/mcp-client.ts";

export function createMilvusMemoryProvider(
  opts: MilvusMemoryProviderConfig & { fetchImpl?: McpFetch },
): MemoryService {
  const baseUrl = opts.url;
  const collection = opts.collection ?? "qm_memory";
  const recallLimit = opts.recallLimit ?? 10;
  
  return {
    async recall(query: string, scope: string): Promise<string | null> {
      const queryEmbedding = await embedQuery(query, opts);
      const results = await searchMilvus(collection, queryEmbedding, {
        filter: `scope == "${scope}"`,
        topK: recallLimit,
      }, opts);
      return results.map(r => r.text).join("\n\n");
    },
    
    async query({ scope, keywords }): Promise<string[]> {
      // Optional: combine keyword + vector search
      return [];
    },
    
    async capture(entry: SessionEntry): Promise<void> {
      const embedding = await embedText(entry.content, opts);
      await upsertMilvus(collection, {
        text: entry.content,
        embedding,
        scope: entry.scope,
        tags: entry.tags,
        createdAt: Date.now(),
      }, opts);
    },
    
    async manage({ action, filters }): Promise<void> {
      if (action === "delete") {
        await deleteMilvus(collection, filters, opts);
      }
      if (action === "list") {
        return listMilvus(collection, filters, opts);
      }
    },
  };
}
```

### Integration Points

1. **`provider-factory.ts`** — Add branch in `createConfiguredMemoryService`:
   ```typescript
   if (provider.type === "milvus") {
     providers[provider.id] = createMilvusMemoryProvider(provider);
     continue;
   }
   ```

2. **`provider-config.ts`** — Add `MilvusMemoryProviderConfig` to union.

3. **`docs/memory-providers.md`** — Document:
   ```json
   {
     "providers": [{
       "id": "org-knowledge",
       "type": "milvus",
       "url": "http://milvus.internal:19530",
       "auth": { "token": "***" },
       "collection": "qm_memory",
       "embeddingModel": "openai:text-embedding-3-small",
       "recallLimit": 10
     }],
     "routes": [{
       "provider": "org-knowledge",
       "scopes": ["org"],
       "capture": "automatic",
       "manage": true
     }]
   }
   ```

---

## Why This Fits QM

- **Scope-aware** — matches QM's per-scope provider routing
- **Deployment flexibility** — Milvus is external; no core infra changes
- **Security posture** — reads use client credentials; writes explicit
- **Existing extension point** — `provider-factory.ts` already handles new types
- **Proven at scale** — I've built Milvus systems at 15M-user scale (Walmart)

---

## Implementation Plan

**Phase 1: Milvus REST API (MVP, 1-2 weeks)**
- Use Milvus HTTP REST API (no Go SDK dependency)
- Embed via local ONNX (nomic-embed-text) or remote API
- Basic CRUD + recall with scope filter

**Phase 2: Hybrid Search + Budget**
- Combine with Postgres full-text for keyword fallback
- Token-budgeted truncation of recall results

**Phase 3: PGVector Native (Optional)**
- Reuse existing PostgreSQL connection pool
- Single DB for teams already on Postgres

---

## ADR Impact

✅ **No core changes** — pure provider implementation  
✅ **Reuses existing patterns** — same factory/route flow as MCP provider  
✅ **Enables org-scale semantic memory** — first native vector provider  
✅ **Deployment-level config** — Milvus endpoint is external service  

---

## Next Step

If aligned, I can implement `milvus-memory-provider.ts` + factory integration + tests, or maintainers can burn tokens on it. Happy either way.