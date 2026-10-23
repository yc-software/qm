Hi,

Vijay and I are the founders of VantedgeAI (W22). We build FundOS, an operating system
for VC, PE and private credit funds covering compliance and operations for LP records,
capital calls, NAV, waterfalls, covenants and data rooms.

We have been testing QM against FundOS and have written seven skills that let an agent do
actual fund operations: draft a compliant capital call from the live LP roster, run a
distribution waterfall and check portfolio covenants.

The skills can be found here:
https://github.com/8vdx1/fundos-mcp/tree/main/integrations/qm

Two points worth noting:

1. We initially assumed we could point QM at our MCP server. It took reading
   claude-harness.ts to understand that the harness uses MCP as its own internal
   transport. That makes sense, but the SDK sitting in devDependencies sent us down the
   wrong path. Maybe it makes sense to add a note in the README as it may save others the
   same detour.

2. For us, the credential broker is the most valuable part. Some of these workflows can
   affect real LP money, so having the agent never hold the credentials matters far more
   than convenience. Maybe this feature should be highlighted more prominently.

We would be happy to PR the skills into skills-seed/ if they are useful. Otherwise we can
leave them in our repo. Let us know whether a vertical-specific fund operations pack makes
sense for the seed set.

Best,
Ravi
