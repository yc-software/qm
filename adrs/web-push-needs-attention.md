# Web Push when an agent needs you

QM already shows "needs attention" in the browser, but that only helps if the tab is open. With chat bridges turned off, there's no lock-screen ping when an agent stops or is waiting on an answer.

I'd like optional first-party Web Push for those existing attention moments. Opt-in only. Small payload: title, short body, deep link into the session. No prompts, secrets, or tool output in the notification. Reuse the attention signals you already have rather than inventing a parallel event bus. VAPID keys as deploy config. Chat connectors stay for teams that want them; this is for people who live in the web UI.

What I'm not asking for: replacing Slack or email, rich media, action buttons that mutate agent state, pushing transcripts, or promising every OS and browser on day one.

Open calls if you're aligned: which statuses should fire (waiting vs failed vs both), whether multi-device users get one notification per subscription or a short coalescing window, and what to document for iOS home-screen install. Happy for you to implement once the direction looks right.
