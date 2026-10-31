# Project-scoped MCP servers

Today every admin-registered MCP server is offered to every session in the org. `mcp_servers` records (`src/mcp/mcp-server-store.ts`) carry url, auth, `credentialScope`, `readOnly` and `enabled`, but nothing about where the server may be used. `createMcpToolService` builds one snapshot of tools and `toolDefs()` takes no arguments, so the pi, opencode, codex and claude harnesses all get the same list, and `call()` checks only that the server exists and is enabled. `credentialScope: "per-user"` decides whose token a call uses, not which sessions can see the tools.

That is fine for shared, read-only services (search, docs, a knowledge base). It is awkward for servers that belong to one piece of work:

- A write-capable connector to one team's system (a CMS, a project tracker, a customer's sandbox) should only appear in that team's project. Offering it everywhere adds tool noise to every session and makes accidental writes from unrelated work possible.
- Tool count matters for context and tool-selection quality. Every org-wide server costs every session.
- The only way to keep a server out of other projects today is not to register it, so admins either over-share or go without.

Goals: let an admin limit an MCP server to one or more projects; enforce it on the server for both listing and calls; no behaviour change for existing servers.

Non-goals: per-user or per-group entitlements (see #1094), per-tool allowlists inside a server, letting project members register their own servers (registration stays admin-only for the SSRF and exfiltration reasons in the store's header comment), and project-level credentials.

Options I looked at:

- A. A `projectIds` list on the server record. Empty or absent means org-wide. Small, additive, easy to audit, and it maps directly onto the existing project scope ids (`group:web-project-<id>`).
- B. A separate scope-to-server binding table, edited from the project settings page. More flexible, but it splits one server's configuration across two places and needs its own admin surface.
- C. Generalise to the allow and deny policy shape proposed for scoped model access. Consistent long term, but heavier than the problem needs today, and it can absorb A later.

I'd go with A.

Behaviour:

- `McpServer.projectIds?: string[]`. Empty or absent keeps today's behaviour exactly.
- `toolDefs(scopes?)`: with a session's scope chain, return org-wide tools plus tools from servers scoped to a project in that chain. Without scopes, return org-wide tools only, so any caller that has not been taught about scopes fails closed rather than leaking a scoped server. The admin listing asks for everything explicitly.
- `call(name, args, principalId, scopes?)`: check the live record, not the cached snapshot, and refuse with a clear "not available in this project" message (audited as `mcp.call` denied) when the chain does not include one of the server's projects. Narrowing a server then takes effect on the next call without waiting for a refresh.
- Harnesses pass the turn scope when building tools; the tool context passes its layer scopes when calling.
- Admin API: `PUT /v1/admin/mcp-servers/:id` accepts `projectIds` (validated ids, de-duplicated, bounded length). When the field is omitted, the stored value is kept, so a client that does not know the field never widens a scoped server. An explicit empty list makes it org-wide. The GET listing includes `projectIds`.
- Admin UI: a "Limit to projects" multi-select on the MCP server form, showing project names.

Migration: additive field in the existing JSON record, no schema change, no backfill.

Security: listing and calling are both enforced in core, never in the sandbox. Unknown scope fails closed. Project ids are matched exactly against project scope ids, not by prefix. Bearer tokens and client secrets are unchanged and still never reach sandboxes. Admins should see a warning when a write-capable server is org-wide.

Related: #1094 (team entitlements for shared MCP servers), the scoped model access ADR (#2408), which has a similar per-scope shape.

Open calls if the direction looks right: whether subagents and scheduled jobs should resolve against the owning project (I think yes, same as the turn); whether group scopes beyond projects belong in the same list; and whether a project admin, not only an org admin, may toggle an already-registered server for their project. Happy for you to implement once you're aligned.
