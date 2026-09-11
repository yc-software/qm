# Telegram as another way to talk to the agent

We already have Slack and the web UI. I'd like Telegram too.

First cut can be small: private DMs only. Link your Telegram account from the web UI with a one-time code so the same person is the same principal across surfaces. Groups, files, and fancy approval buttons can wait.

I wouldn't shove this into the in-process Slack plugin. A small separate service that long-polls the bot API and talks to core like the other surface plugins feels cleaner, and keeps Telegram opt-in behind a BotFather token.

Curious if that's the shape you'd want before anyone burns tokens on it.
