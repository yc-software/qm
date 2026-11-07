# MCP servers should be scopeable, the way skills already are

Right now a registered MCP server is visible to every scope. In `src/wiring.ts`:

```ts
const mcpTools = () => mcpToolService.toolDefs()
```

No scope argument, and that same closure goes to all four harnesses. So if I
register two MCP servers, every scope's agent gets the tools from both.

What strikes me is that skills don't work this way. Skills are scope-owned and
shared by grant, with admin-gated promotion to the org. MCP servers are the
opposite: admin-registered and global. Both are "capabilities an agent has", so
the asymmetry feels more like something that hasn't been done yet than a
deliberate line — the admin-only registration reasoning in `mcp-server-store.ts`
is about who may *add* a server (SSRF/exfil surface), which I agree with, and
that's a separate question from who may *use* one.

Why it matters for us: our MCP servers are how we scope data access. One server
exposes finance tables, another exposes support tickets, each with its own
credential. That separation is the access control. Under one org-wide tool
surface it collapses — every agent sees every server.

I looked for a way to enforce it on our side instead and couldn't find one.
`McpToolService.call()` takes a `principalId`, but it only reaches the audit
record; the outbound call is `clientFor(server).callTool(...)` with the server's
single configured credential, so the downstream server can't tell who is asking.

Not proposing a specific design — grants on servers like skills have, an
allowlist in scope config, or something else entirely. Mostly want to know if
you see this as a gap worth closing.

— faqundodev
