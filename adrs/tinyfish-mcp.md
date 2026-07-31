# TinyFish MCP

Could QM support an org-configured remote MCP server that people connect to with OAuth?

We want to connect `https://agent.tinyfish.ai/mcp` without a skill or API key. For now we need these TinyFish tools:

- `search` for external knowledge and finding pages
- `fetch_content` for reading supplied URLs
- `run_web_automation` for interactive website tasks
- `run_web_automation_async` only when someone explicitly asks to run the task in the background

I tested the endpoint directly with OAuth. Tool discovery returned all four tools. Search found the TinyFish docs, fetch returned the Example Domain page, synchronous automation returned its title, and asynchronous automation completed with the same result through `get_run`.

This proposal does not itself connect TinyFish to a QM agent. QM still needs to load these remote MCP tools into the active harness tool set before the model can select them.

The connection should belong to the person who authorized it. It should not be stored in an ephemeral harness home or shared with a room.

The QM checks should prove that a current-web question selects `search`, a supplied URL selects `fetch_content`, an interactive website request selects `run_web_automation`, and an explicitly backgrounded website request selects `run_web_automation_async`.
