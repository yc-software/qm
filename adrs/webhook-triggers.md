Request: Webhook triggers

My company has many cases where we want to dispatch an agent on an event, not on a poll cycle (ex:  a failure in a batch analytics job, and we want an agent to go investigate). Cron and monitor cover scheduled/watched work, but there's no way to hit qm from outside and say "run now."
