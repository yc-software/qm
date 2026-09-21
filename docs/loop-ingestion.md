# Loop ingestion

A Loop can receive work from a schedule, signed webhooks, Slack Events API callbacks, or Gmail Pub/Sub. Open the Loop and use **Ingestion → Add event source**. Adding an event source leaves schedules and approval rules unchanged. No event source is enabled automatically on upgrade.

Events are acknowledged only after durable receipt. The worker transfers them to the original Loop ledger and works queued items without running the discovery stage. Duplicates reuse the same item. Paused Loops retain received work; disabled sources stop accepting new deliveries. Re-enable a source to continue pending work. Pending jobs survive restarts; completed receipt metadata is retained for 30 days. Returned items run again even when no new event arrives.

Source updates invalidate old held drafts before processing the new conversation. Human edits remain in the item thread. A shipping output or an output awaiting confirmation must settle before that conversation refreshes. Existing ship gates remain authoritative; Email and Slack reply proposals stay held for human review.

## Preview rollout

The durable `inbox_loops` feature flag defaults off. Enable it only for the intended `personal:<principal>` scopes in Admin → Feature flags. Existing Web UI `INBOX_USERS` and `LOOPS_USERS` allowlists still apply. Both the UI permissions and server routes enforce the flag; Inbox migration starts only for enabled people. Event receipt and background processing also check the source owner's flag. Revocation retains queued work without accepting or processing more events.

Slack receipt recovery covers events already persisted by QM. There is no Slack history reconciliation yet. Enable Slack's Delayed Events option for extended delivery retries; Gmail has history reconciliation as described below.

## Signed webhooks

Choose **Signed webhook** on a Loop without a source restriction. Save the signing secret shown once. POST a JSON object to the displayed endpoint with `X-Signature` containing the hexadecimal HMAC-SHA256 of the exact request body. The optional `title` property is used as the work summary. The entire JSON object is untrusted input to the Loop playbook. Payloads are limited to 64 KB.

Identical request bodies are duplicate deliveries; include a stable event ID in the JSON when otherwise-identical events should be distinct. Do not change the body during retries. An invalid signature returns 401. Disabled or nonexistent endpoints return 404. Accepted receipts return 202, which does not mean the model has finished processing.

## Slack events

Choose **Slack events**, enter the Slack app signing secret, workspace ID, and channel IDs. Configure the displayed endpoint as the app's Events API request URL and subscribe to the message events needed for those channels. The receiver handles Slack's signed URL-verification challenge. App membership and Slack OAuth scopes still determine which events Slack sends; this setting grants no additional Slack permissions.

Only human message events from the configured workspace and channels are imported. Bot messages and message subtypes, including edits and deletions, are excluded. Deliveries deduplicate by Slack event ID. Replies share their conversation's work item; DMs use the channel ID as their conversation key. A newer message refreshes that item.

This is HTTP Events API ingestion, independent of the deployment's existing Socket Mode bot. Slack has one Events API request URL per app, so use an app dedicated to this endpoint if another service already owns that URL. Slack Workflow requests can use the generic signed webhook only if the sender can produce the required HMAC signature; an unsigned workflow URL is not supported.

See [Slack HTTP request URLs](https://docs.slack.dev/apis/events-api/using-http-request-urls/) and [request signature verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/).

## Gmail Pub/Sub

An administrator must configure:

```text
GMAIL_PUBSUB_TOPIC=projects/PROJECT_ID/topics/TOPIC_ID
GMAIL_PUBSUB_AUDIENCE=https://QM_HOST/v1/loop-ingress/gmail
GMAIL_PUBSUB_SERVICE_ACCOUNT=pubsub-push@PROJECT_ID.iam.gserviceaccount.com
```

1. Create a Pub/Sub topic in the Google Cloud project associated with the Gmail OAuth application. Grant `gmail-api-push@system.gserviceaccount.com` publisher access to that topic.
2. Create an authenticated push subscription pointing to `https://QM_HOST/v1/loop-ingress/gmail`. Set its OIDC audience and push service account to match the settings above. Follow Google's service-agent/token-creator requirements for authenticated push subscriptions. Use the normal wrapped Pub/Sub message format.
3. Restart core with those settings. Set `PUBLIC_WEB_URL` to the externally reachable HTTPS origin so the UI displays the correct endpoint. The portal forwards push requests without a portal login; core verifies Google's signature, issuer, audience, and verified service-account email.
4. Connect the Loop owner's personal Gmail account, then enable **Gmail Pub/Sub** on a personal Loop. Gmail watch/history access needs an appropriate Gmail OAuth scope. Company credentials and shared-scope Loops are not used for personal mailbox ingestion.

The initial watch starts at the mailbox's current history ID; it does not import the existing mailbox. New Inbox messages and messages newly labeled Inbox become work items. Watches renew daily without advancing the saved processing cursor. Notifications trigger paginated history reads; every ten minutes a history reconciliation also checks for dropped notifications. An expired history cursor triggers a paginated Inbox resync. The cursor advances only after all discovered items are durably imported.

Disabling a source stops receipt processing and watch renewal for that registration. It does not issue Gmail's mailbox-wide stop call, because another Loop may watch the same mailbox. If every registration is disabled, the remote watch expires naturally. Re-enabling preserves the processing cursor and catches up on subsequent reconciliation.

See [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push), [watch API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch), and [authenticated Pub/Sub push](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).

## Operations

Keep background work enabled: ingestion maintenance runs alongside the scheduler, without requiring any user cron. Registration state, Gmail cursors, retry times, receipts, and queued work live in the configured durable store. Production uses Postgres; memory persistence is only suitable for disposable tests.

The Loop's Ingestion panel shows the last receipt and processing error. A 202 acknowledgment followed by an error means the event is still durable and will retry or remains represented by a queued/parked ledger item. A failed Loop may require operator attention under its existing governor and retry limits. Watch renewal errors retry after five minutes.

Do not paste webhook signing secrets into chat, playbooks, or committed configuration. The secret is returned only on creation for generic webhooks and is omitted from later listing responses.
