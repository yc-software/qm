# Talk to qm out loud: a voice surface for huddles, calls and the phone

Jake from CargoLabs here again. We run qm on Fly via the deployment repo and our team lives in the Slack bot. The next thing people ask for, every week, is "can I just get on a call with it?" Someone is in a Slack huddle debugging a customer problem and wants to ask the bot a question without alt-tabbing to type it and then reading a wall of text back to the room.

We went looking for a way to do that today and the short version is: there isn't one, and the two obvious hacks are bad.

- Slack has no API that lets a bot hear or speak in a huddle. Third-party meeting bots can't be admitted. Even Recall.ai, whose whole business is meeting bots, lists Slack Huddles as the one platform where a bot can listen but not speak.
- The projects that "work" (claw-huddle, an unmerged OpenClaw plugin) drive a headless Chrome signed in as a real human's Slack account with a virtual microphone. That is a stolen session cookie and a fake user. We won't run that against our workspace and we don't think qm should ship it.
- Buzz, on the other hand, was built for this. Agents join huddles as first-class peers with their own keys. But that only helps if qm can be one of those peers.

So the ask is a first-class voice surface in core, with the same shape as the Slack and web surfaces: a live audio conversation becomes ordinary turns in an ordinary session, and the transport is pluggable so the same code serves a Buzz huddle, a phone call, a Zoom meeting, and a Slack call.

## Shape

One new surface, `voice`, that owns a live session per room or call:

- Audio in goes through speech-to-text, and each completed utterance is posted as a turn on the room's thread through the same `POST /v1/turns` path the Slack plugin uses, with `surface: "voice"` and the speaker as the actor.
- The reply streams out sentence by sentence through text-to-speech, so the first audio lands before the model finishes. Barge-in stops playback when a human starts talking.
- The session stays warm for the life of the room. This matters: the public Buzz voice experiments report "brutal" latency because every reply spun up a fresh agent harness. A huddle should be one long-lived session with one warm harness, not a harness per sentence.
- While a tool runs longer than a couple of seconds, the surface speaks a short filler ("checking Stripe now") driven by the same run activity the Slack live-activity ADR asks for. Silence on a voice call reads as a dropped line.
- Voice is a lossy medium, so long or structured results are summarised aloud and the full result is posted to the room's text thread (the Buzz channel, the Slack channel, or a web session link read out on the phone). Nothing the agent produces exists only as audio.
- Asks and approvals are spoken and can be answered by voice ("yes, go ahead"), with the same audit record as a text approval. Anything that needs a link or a form is deferred to the text thread.
- The transcript is persisted as session entries so the web timeline shows the call like any other conversation. Join, leave and end are audit events.
- Speech providers are pluggable and configured like model providers: `VOICE_STT_PROVIDER`, `VOICE_TTS_PROVIDER` with keys in the admin credential store. Deepgram, OpenAI and ElevenLabs cover what most teams already have. When the harness grows a realtime speech-to-speech model, it can replace the STT/TTS pair behind the same surface.

Identity is the part that needs care, because a microphone has no login. Each transport maps speakers to qm principals or refuses:

- Buzz: the participant's Nostr key maps to a qm user.
- Slack call: the Slack user ids on the call map to qm users as they do for messages.
- Zoom: the joined participant's email when the meeting exposes it, otherwise an unnamed guest with the lowest permission and no credentials.
- Phone: an allowlist of numbers to users, nothing else answers.

Budgets and per-user metering follow the speaker, not the room.

## Transports

**Buzz huddle (native, and the first one to build).** The relay exposes `wss://<relay>/huddle/{channel_id}/audio`. A client authenticates with a NIP-42 challenge using its own key, passes channel membership, and is admitted to the room. Frames are Opus with an 8-byte header (`seq` u16, 48 kHz timestamp u32, level dBov i8, flags u8); received frames carry a 1-byte peer index so the receiver knows who is talking. The relay emits Nostr events for participant joined, participant left and huddle ended, and the room ends when the last peer leaves. qm would hold its own Buzz key, the way buzz-acp gives Goose, Codex and Claude Code one, so this is: subscribe to huddle lifecycle events for channels the agent is a member of, join the audio socket when invited (or when a channel opts in), decode Opus, run the loop above, encode Opus, send. No SFU, no third party, no impersonation. Buzz marks huddle lifecycle events as still being wired up, so we'd track that and start with explicit invites.

**Telephone.** A SIP or PSTN number via Twilio Media Streams or LiveKit SIP, terminating on the same voice session. Caller id is checked against the allowlist before a word is spoken. This is the transport that works from a truck stop.

**Zoom (and Meet, Teams).** A meeting bot. Recall.ai supports output audio on Zoom, Google Meet, Microsoft Teams and Webex, so one integration covers all four: the human pastes a meeting link to the bot in Slack or the web UI ("join this zoom"), qm creates a Recall bot pointed at the voice session, and the bot's transcript stream and output-audio endpoint are the audio in and out. The Zoom Meeting SDK is the no-vendor alternative for teams that want it, behind the same interface.

**Slack.** Since Slack won't let a bot into a huddle, qm hosts the call instead and Slack shows it natively. "@qm hop on a call" or `/qm call` creates a room (a Buzz huddle, or a LiveKit room qm runs itself) and registers it with the Slack Calls API. `calls.add` posts a native call block with a Join button and a participant list in the channel, and `calls.participants.add` keeps the list in sync as people join. Teammates click Join and land in the browser room with the bot already in it; the transcript and results post back to the Slack thread the call started from. This needs `calls:read` and `calls:write` in the manifest. If Slack ever opens huddle audio to apps, the same session plugs in behind a Slack transport. We would rather wait for that than ship the headless-browser hack.

## What we are not asking for

- No headless-Chrome or fake-user tricks for Slack huddles.
- No recording of rooms the bot wasn't invited to. It joins when invited or when a channel has opted in, and says so when it joins.
- No reasoning text or tool arguments read aloud. Same trust boundary as the Slack surface: high-level activity and results.

We can test the Buzz and Slack-call transports against our live workspace and report back; the phone transport is cheap to trial on a single Twilio number.
