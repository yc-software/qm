# Eden AI as an EU-resident model provider

## Why

There's currently no `MODEL_PROVIDER` value that keeps a turn inside the EU. Anthropic, OpenAI and
OpenRouter all route outside it, so an org with a data-residency requirement can't adopt qm at all.

That tends to be a hard gate rather than a preference. GDPR makes each cross-border transfer
something you have to justify, and for European public sector, healthcare and finance teams it's
usually settled by procurement before anyone gets to evaluate the product. It also isn't only
about where the datacentre sits: EU teams increasingly want the processor itself under EU
jurisdiction, which is why routing to a US vendor's EU region doesn't always close the question.

Eden AI is a French AI gateway, backed by Olivier Pomel (Datadog) and Nicolas Dessaigne (Algolia).
We run a separate EU endpoint, `https://api.eu.edenai.run/v3`, that only serves models meeting
European residency requirements. It speaks `openai-completions`, so this is a provider id plus
model cards rather than new request-building code.

Disclosure: I work at Eden AI.

## What

- `edenai` as a fourth `MODEL_PROVIDERS` entry, with `EDENAI_API_KEY` on the same secret-gate path
  `OPENROUTER_API_KEY` already takes.
- A curated list (Claude, GPT, Mistral, Qwen, open-weight) rather than all 202 models the endpoint
  serves, each one verified end to end against the pi harness.
- Base URL hardcoded with no override, since an escape hatch would just defeat the point.
- Labels carry the residency guarantee rather than the hub, so a deployment holding both an
  Anthropic and an Eden AI key shows unambiguous pairs in the picker.

Prototype, if it's useful: https://github.com/SamyMe/qm/tree/edenai-eu-provider

Happy to send over an API key with credits so you can try it without spending anything, just say
where. Only real open question from my side is how many models you'd want exposed: a curated dozen
keeps the operator dropdown legible, the full catalog matches how OpenRouter behaves.
