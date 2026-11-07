Was digging through what the audit log actually captures when an admin changes governance settings. Answer: almost nothing.

Change a scope's security posture (or command policy, egress, approval grant modes) and the event is just `security-posture.update` plus who and which scope. There's a `detail` field on the event but nothing fills it here. The config store also overwrites the old value in place, so the before state is gone. If someone asks "when did this scope get loosened to dangerous, and what was it before?" the log can only say an admin touched it at some point.

So the ask: for governance resources, put the old and new value in detail. A short summary is fine for chunky ones like command policy. Chat titles already do this, `conversation.update` logs the patch, so the pattern exists. It's just missing where it matters most.

Two things to be deliberate about. That audit call is shared with resources that carry secrets (service credentials, connectors), so this should be an explicit allowlist of governance resources rather than logging every admin write. Also the admin audit listing strips detail from responses today, so whatever gets recorded needs to be readable there too. Write-only evidence helps nobody.

SECURITY.md already admits governance changes aren't versioned or revertible. This feels like the cheapest first step. At least the timeline of what the controls actually were becomes a grep instead of guesswork.
