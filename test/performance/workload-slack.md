# Synthetic Slack network endpoint

`workload-slack.ts` supplies the narrow Slack Web API methods used by the native plugin's directory sync and a text-only DM. It listens only on loopback, requires an explicitly synthetic `xoxb-qm-perf-` token, checks fixture identity, and rejects unknown methods, users, conversations, or writes outside the profile's explicit writable conversations. It has no outbound client or external fallback. The actual QM Slack plugin, signed HTTP event receiver, core, worker, model clients, persistence, mirror and delivery handling remain ordinary application code.

The profile contains the complete synthetic user directory and distinct channel/group/DM IDs with exact rosters. A real Slack conversation has one roster; duplicate IDs are rejected. Snapshot all existing fixture directory records before starting the primary plugin: its normal full sync replaces the directory and can deactivate omitted people. Any prerequisite fixture namespace repair requires separate audited lineage. Do not start this against a fixture with conflicting channel/group IDs.

Run with Node 24 and private profile/fixture paths:

```sh
node --env-file=/absolute/private/synthetic-slack.env test/performance/workload-slack.ts /absolute/private/slack-profile.json /absolute/private/fixture.json /absolute/private/slack-network.jsonl
```

Configure the existing core with `SLACK_EVENTS_MODE=http`, its signing secret and events port, `SLACK_API_URL=http://127.0.0.1:<responder-port>`, `SLACK_IDENTITY_EMAIL=1`, the synthetic bot token, and Slack enabled. Submit an actual HMAC-signed `event_callback` to `/slack/events`; never substitute a web turn whose origin label says Slack. Keep utility/main model calls pinned to the reviewed fail-closed performance companion. Startup and observed runtime settings must be retained with the evidence.

The profile's `messages` supplies synthetic network history. Posted replies and updates remain in the responder process, with method, bytes, hashes, timings and failures appended to raw JSONL. This disposable remote-service simulation does not stand in for QM durability. The installed-client test also invokes the actual directory crawl and verifies complete, different channel/group rosters before testing message delivery and rejected methods.

A live correctness proof must separately retain signed HTTP acceptance, native Slack run/session/LLM rows, actual mirror/ack/delivery evidence, provider traces, full directory preservation, and cleanup. An event can be acknowledged after a run is durably accepted without leaving a staged-envelope row; do not claim durable staging occurred unless it was observed. All responder records are `qualified:false`. This one-DM endpoint does not model Slack latency/rate limits/retries, files, arbitrary tools, ambient conversations, or the measured source mix and cannot independently qualify production performance.
