# Custom MCP connectors

We already have connectors for the prebuilt SaaS apps, but there's no way to
plug in custom MCP servers. That feels incomplete — we want the agent in all
our tools, not just the ones with first-party connectors (Paper, ClickUp, etc.).
(See how Claude does it.)

Ideal shape: register an MCP server (stdio or HTTP) the way you'd add a
connector, and have its tools show up for the agent on a turn.

Open question whether that's org-admin curated servers first, or full
bring-your-own like Cursor. Happy with a small v1 if the direction is right.
