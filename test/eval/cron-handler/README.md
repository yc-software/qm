# Cron handler offline eval

Replays a day of real cron replies through a `createFireHandler` implementation and compares it with the status quo (every reply sent as its own message).

```
NODE_USE_ENV_PROXY=1 node test/eval/cron-handler/run.ts \
  --corpus corpus.json --out results --runs 2 \
  --handler A=src/cron/handler/fire-handler.ts --handler-model gateway/bedrock/claude-sonnet-5-5 \
  --handler B=../triage/src/cron/handler/fire-handler.ts --handler-model gateway/bedrock/claude-haiku-5-5
```

- Fires are grouped into 10-minute batches and delivered at the batch end; `urgent` is set when the text starts with `[urgent]` or the cron title looks like an alert.
- Digests flush at 09:00 and 17:00 Pacific, plus the next 17:00 after the window.
- Gold labels (urgent / informative / noise) come from the grader model and are cached in `<out>/labels.json`.
- The grader decides which fires each delivered message conveys and whether it is noise, and scores digest readability 1–5.
- All model calls go through `$MODEL_GATEWAY_URL` with caching disabled. Keep the corpus and results out of git.
