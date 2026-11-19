# SpecStream as a provider for the web tool (#839)

Hi, Tarek from SpecStream here. We make the most accurate web search API in the world, and I'd like it to be one of the providers behind the `web` tool in #839.

The proposal in #69 already has the right shape: a two method `WebToolDeps` (`search` and `scrape`) wired in one place. Ours maps onto it directly:

- `search`: `GET https://api.specstream.ai/v1/web-search?q=...` with a bearer key. Results come back in `data.sources` with title, url, snippet and published date. $5 per 1,000 searches.
- `scrape`: `POST https://api.specstream.ai/v1/extract` with `{"urls": [url], "format": "markdown"}`. It handles pages rendered client side, PDF, Word and Excel, and returns a status per URL (`ok`, `blocked`, `not_found`, `empty`). $0.80 per 1,000 pages, and a page with no text isn't charged.

On accuracy: 97.9 on all 1,000 SimpleQA Verified questions and 64.0 item F1 on all 200 WideSearch tasks, ahead of Parallel, Exa, Tavily and Perplexity in the same runs. Scores, method and every raw answer are at https://specstream.ai/benchmarks.

So the idea is `SPECSTREAM_API_KEY` next to `FIRECRAWL_API_KEY`, picked at that one call site, with results still going through your content screener.

We also run a remote MCP server at `https://api.specstream.ai/mcp`, which an org admin can register today through `/v1/admin/mcp-servers` for the bigger jobs: many rows that each meet conditions, kept up to date on a schedule.

Happy to write the provider and its tests once you've picked how the web tool lands, or leave it to you. Your call.

Tarek Etman
Founder & CEO, SpecStream
