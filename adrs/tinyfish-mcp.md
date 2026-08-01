# TinyFish MCP

We want QM to connect `https://agent.tinyfish.ai/mcp` without a skill or API key. For now we need these TinyFish tools:

- `search` for external knowledge and finding pages
- `fetch_content` for reading supplied URLs
- `run_web_automation` for interactive website tasks
- `run_web_automation_async` only when someone explicitly asks to run the task in the background

When someone messages QM, it should use that speaker's TinyFish OAuth connection and add these tools to the same shared tool set every harness receives. The model can then select them from TinyFish's existing descriptions. Scheduled work should use the instruction owner's connection. MCP calls and results should go through QM's existing approval, external-content screening, and audit paths.

The connection should belong to the person who authorized it. It should not be stored in an ephemeral harness home or shared with a room. A channel message can use its speaker's connection, but another participant or an unowned automation should not inherit it.

I tested the endpoint directly with OAuth. Tool discovery returned all four tools. Search found the TinyFish docs, fetch returned the Example Domain page, synchronous automation returned its title, and asynchronous automation completed with the same result through `get_run`.

The QM checks should exercise the full Slack-to-tool path and prove that a current-web question selects `search`, a supplied URL selects `fetch_content`, an interactive website request selects `run_web_automation`, and an explicitly backgrounded website request selects `run_web_automation_async`.
