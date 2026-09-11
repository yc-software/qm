# Agents are much more useful with a company context layer — and two bugs are blocking it

Hi — we're PipesHub. We do context layer for agents and enterprise search for humans across Drive, Slack, Gmail, Jira,
Confluence and internal knowledge bases, with each entities's permissions enforced
on every query.

**Why we think this matters for QM.** A QM agent with a sandbox can already do
real work. What it can't do is know anything about the company it works for — so
people spend the first half of every conversation pasting in context, and the
agent still reasons from a fragment. The obvious fix is to connect data sources.
The reason that usually goes wrong is permissions: an agent that can read every
document in the company is a fundamentally different and much riskier product
than one that reads exactly what the person asking can already read.

A context layer solves the second problem, which is what makes solving the first
one safe. We think that's a general pattern worth QM having a view on, not just
a PipesHub thing.

**What we built.** A CLI installed into the sandbox, plus a `tool.json` and a
`SKILL.md`. Deliberately QM-native — no core changes, no plugin, no MCP
attachment. Each person supplies their own token from their own keychain, so
answers stay bounded by their own access.

**To be precise about that last part:** it holds in DMs, and we've only built
for DMs. In a personal scope QM injects the speaker's own keychain credential,
so the person asking is the person whose permissions apply — we've confirmed
that end to end. In a shared conversation it works differently: your own
credential isn't injected, someone grants one to the conversation instead, and
that grant then serves whoever speaks next. For us that would mean one person's
token answering another person's question, which is the exact thing this design
exists to prevent. So we've scoped v1 to personal DMs and say so in our docs.

Supporting shared rooms properly would need QM to broker per speaker — inject
the credential belonging to whoever is talking, rather than one attached to the
room. We're not asking for that today; flagging it as the thing that would
unlock it.

**What we're asking:**

1. **Fix the two bugs below** — they're the only thing stopping this working.
2. **Tell us whether "context layer" is a pattern you want to support** — as in,
   documented as a thing QM deployments can have. If yes we'll write whatever's
   useful and keep our side maintained against your releases.

**The two bugs:**

- **#272** — with `sandbox.backend: "sprites"`, a published `sandbox.image` is
  silently ignored and the stock base boots. We published a 3.7 GB image with
  our CLI at `/usr/local/bin`; the sandbox came up with a 2.4 MB overlay and an
  empty `/usr/local/bin`.
- **#350** — on `aws`, there's no way to get a tool's program into a Lambda
  MicroVM at all. The deployment layer only carries `tool.json` and skills.

Normally a tool's program goes into the sandbox image, so every sandbox just
has it. Both bugs above break that. The only route left is for the agent to
install our CLI itself, inside its own sandbox, the first time someone uses it:

    npm install -g @pipeshub-ai/mcp

That does work — the sandbox has Node and npm and can reach the npm registry,
and the install survives after the message ends, so each person pays it once
rather than on every message. But it's a workaround. We don't want it to be the
setup instructions we hand people.

Happy to test against a branch.
