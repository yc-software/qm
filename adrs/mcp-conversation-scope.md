# Send the conversation scope to attested MCP servers

Hi qm team, a quick idea from running qm with a shared memory MCP server.

Today an MCP server with `attestActor` gets `x-qm-actor`, so it knows who is asking, but not where. For a memory server this matters: the same person should see different things in their own DM vs. a public channel, and right now the server can't tell.

What I'd like: on `tools/call`, also send `x-qm-scope` with the conversation's `ScopeId` (`personal:…`, `channel:…`, `group:…`). qm already has it from `scopeFor(conversation, actor)`, so tool args can't fake it. Tool listings don't need it.

A few things I think should come with it:
- If a server sees a scope form it doesn't handle, treat it as "no data". A group has several people listening, so the asker's own access isn't enough.
- Reserve `x-qm-scope` like `x-qm-actor` / `x-qm-approval`, so credential config can't set it.
- No new settings or tables. External runs have no MCP, so nothing changes there.

I tried this in my own fork with a memory MCP server: channel, DM, someone else's DM, and a call with no scope were all allowed or refused the way I expected. Happy to share the diff if it helps.

Does this make sense? :)
