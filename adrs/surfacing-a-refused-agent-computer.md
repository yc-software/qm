# Surfacing a refused agent computer

Vishnu from Agent37 again, short one.

A free-plan user asked his qm for something that needed an agent computer.

What we sent back:

> HTTP 402 `insufficient_balance`
> This instance costs $0.0070 per hour, metered per minute; creating it requires at least one day of balance ($0.17). Add balance to your workspace (a new workspace can add a card to unlock $5 of free credit) and try again.

What he saw:

> That turn failed and couldn't be completed. The details are in the operator error log.

He has no operator error log. He tried twice more and stopped.

What we would like him to see:

> Agent37 refused this agent computer: This instance costs $0.0070 per hour, metered per minute; creating it requires at least one day of balance ($0.17). Add balance to your workspace (a new workspace can add a card to unlock $5 of free credit) and try again.

Our fault: our backend throws a plain `Error` for every non-2xx, so the run retries a 402 that can never succeed and then falls back to the generic string, since only a `NonRetryableTurnError` is shown. That default is right for an internal failure, but not for a refusal we wrote for a human to read.

One helper now builds the error for every failed call in `src/sandbox/agent37-sandbox.ts`. Our permanent refusal codes become a `NonRetryableTurnError` carrying our message; everything else keeps its exact text, request id included.

The same swallow exists in every sandbox backend, so this probably belongs in the shared layer. We left the others alone rather than guess at each provider's error shape. Happy to follow your lead if you want it hoisted.
