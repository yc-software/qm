# Feishu as another way to talk to QM

My company uses Feishu for day-to-day communication, so Slack isn't where we'd
actually use QM. We'd like to add QM to our existing Feishu chats instead of asking
everyone to move to another tool.

A useful first version for us would be pretty small: DMs, mentioning the bot in a
group, replies in the same thread, and scheduled updates back to that chat. Text is
enough to start; files and interactive cards can come later.

Feishu has an official Node SDK and a WebSocket event mode, which sounds close to
the way QM connects to Slack without needing a public callback URL. I'm happy to
test this in our real Feishu tenant.

Would Feishu be in scope as another agent surface? If so, would you rather keep it
as its own deployment plugin or support it alongside Slack in the main project?
