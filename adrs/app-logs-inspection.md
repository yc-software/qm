# App log inspection

Building apps in qm is painful right now because I can't get the app's logs
to the agent without copy-pasting. Publish fails (or the live app misbehaves),
I dig out the logs by hand, paste them into chat, repeat.

I'd like the agent to be able to pull recent logs for a deployment on its own —
"show me the last N lines from this app." A Logs tab in the Apps UI would be
nice, but v1 can just be the API/agent path.

Don't need streaming or long retention to start. Just stop the copy-paste loop.
