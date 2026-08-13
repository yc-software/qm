# Telegram surface (long polling)

The Telegram surface, run **in-process with the agent core**: core boots it when
`TELEGRAM_BOT_TOKEN` is present in its env and hands it a direct client into
core's services. **Long polling** means no public URL, ingress, domain, or TLS —
the plugin polls `getUpdates` over an outbound HTTPS connection, so you can run
it from a laptop or any box with internet.

```
Telegram ⇄ (HTTPS long poll)  telegram surface (in core)  ── direct calls ──▶  core services
```

## 1. Create the bot (one paste)

1. Open BotFather in Telegram: <https://t.me/BotFather> → **/newbot**.
2. Name it, copy the token (`123456:ABC-…`) → `TELEGRAM_BOT_TOKEN`.
3. Optionally restrict the bot to specific chats with
   `TELEGRAM_ALLOWED_CHAT_IDS=123456,789012` (comma-separated chat ids).

## 2. Run

One process — core boots the Telegram surface itself when the token is in its env:

```bash
cd ~/qm
HARNESS=pi ORG_ID=acme ANTHROPIC_API_KEY=… \
TELEGRAM_BOT_TOKEN=123456:ABC-… \
npm start
```

(Or put the token in the repo-root `.env` — `npm start` loads it via
`node --env-file-if-exists`.) It logs `[qm] telegram plugin started` when live;
without the token, core simply runs without Telegram.

## 3. Use it

- **DM the bot** anything → it replies in the DM (one continuous session per DM,
  keyed on `dm:<chatId>`; replying to one of the bot's messages continues that
  thread as `dm:<chatId>:<replyToMessageId>`).
- Replies longer than 4096 characters are split across multiple messages.
- **Background deliveries** (cron reports, monitors, agent-initiated posts) are
  claimed by the plugin as `type: "telegram"` deliveries and sent to the chat
  that originated the turn.
- Files the agent produces are uploaded back into the chat as documents.
- **Group chats aren't handled yet** — the bot stays silent there.

## How it maps to the core

| Telegram                                 | Core                                              |
| ---------------------------------------- | ------------------------------------------------- |
| `message` update in a private chat       | `POST /v1/turns` with `surface: "telegram"`       |
| chat id (+ optional reply-to message id) | `threadRef` = `dm:<chatId>[:<replyToMessageId>]`  |
| `TurnResult.reply`                       | sent back to the same chat                        |
| pending `type: "telegram"` deliveries    | claimed from `/v1/deliveries`, posted, then acked |

## Notes / next

- The bot token never leaves the plugin. The plugin talks to Telegram over the
  Bot API (`api.telegram.org`, overridable with `TELEGRAM_API_URL` for tests or
  self-hosted proxies).
- `@mention` handling in group chats, approval buttons, and reaction support are
  future work; the core's surface machinery (`surfaceTools`, delivery routing)
  already speaks `telegram` as a first-class surface name.
