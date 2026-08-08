# `qm doctor` could catch a base model that the endpoint no longer serves

We run the base model on our own OpenAI-compatible gateway, reached with
`HARNESS=claude` plus `ANTHROPIC_BASE_URL`, and no `modelProvider` — so `qm doctor`
correctly refuses to live-check a vendor key against api.anthropic.com. It reports:

```
· base model: no modelProvider set — an administrator supplies the key from the Admin page
```

Then someone tidied the gateway's aliases. The model id in our `CLAUDE_MODEL` stopped
existing, and calls started coming back as:

```
400 anthropic_messages: Invalid model name passed in model=<id>.
    Call `/v1/models` to view available models for your key.
```

Every agent turn failed. `qm check` passed. `qm doctor` passed. `qm up` deployed happily,
`qm check --live` agreed the live deployment matched the directory — because it does; the
directory was the thing that was wrong. Nothing in the gate order looks at whether the
model id resolves, so the deployment was green end to end while being completely dead.

That is the part worth fixing. A wrong model id is not an exotic failure: the id is a
plain string in config, the gateway that serves it is operated by someone else, and there
is no signal until a user gets a broken turn.

## The check we'd suggest

When `ANTHROPIC_BASE_URL` is set, have `doctor` ask that endpoint for its model listing
and confirm `CLAUDE_MODEL` appears in it.

The machinery already exists. `validateKey` in `src/api/routes/admin/custom-providers.ts`
already talks to `${baseUrl}/v1/models` with the anthropic protocol headers — it just
discards everything but `response.ok`. Reading the ids out of that same response is the
whole change.

Two things we'd guard, learned from the code as it stands:

- Not every gateway implements a listing. The custom-provider route already accounts for
  this with `{"validate": false}`, and the comment there says so. A missing or non-JSON
  listing should be a skip with a note, not a failure — same posture as the rest of
  `doctor`.
- The check belongs to `doctor` rather than `check`: it is an external, read-only probe of
  someone else's service, which is exactly the line the two commands already draw.

## What we did meanwhile

A shell script in our own deployment layer that reads `CLAUDE_MODEL` and
`ANTHROPIC_BASE_URL` out of the config, queries `/v1/models`, and exits non-zero when the
id is absent, printing what the endpoint does offer. It runs first in our gate order. It
is nine lines of logic and it would have turned a silent outage into a refused deploy, so
it seems worth having in the tool rather than in every operator's layer.

Happy to test any shape of this against a live third-party gateway — that is the case that
is awkward to reproduce with a vendor endpoint.
