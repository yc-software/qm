---
name: email-voice-profile
description: Build (or refresh) a voice profile of how the user writes email, from their own sent Gmail. The profile is what email-draft-in-voice consumes to ghostwrite email that sounds like them.
requiredCapabilities:
  - egress:gmail.googleapis.com
---

# Email voice profile

Use this when the user asks you to learn how they write email — "learn my voice",
"build my email voice profile", "study my sent mail so you can draft for me" — or when
`email-draft-in-voice` needs a profile that doesn't exist yet.

**Personal DMs only.** Sent mail is private; refuse to run this from a channel or group
and offer to continue in the user's DM. The profile you produce lives in their personal
workspace, so only their own conversations can read it.

## 1. Pull the corpus

```bash
python3 skills/email-voice-profile/scripts/fetch_sent.py --limit 300
```

This fetches the user's sent messages (their Google OAuth token is already on your
computer; if it's missing, point them at the app-connect flow), strips quoted replies
and signatures, drops automated and trivial messages, and writes one JSON line per
email to `voice/corpus/corpus.jsonl` — each tagged `internal` or `external` by
recipient domain. It prints corpus stats; if fewer than ~50 usable emails survive,
tell the user the profile will be rough and ask whether to continue.

## 2. Study it

Read a deliberate spread, not just the top of the file: oldest and newest, internal
and external, one-liners and long emails. You are looking for what is _distinctive_ —
patterns a generic professional emailer would not share.

Watch for a signature block: only `--`-delimited signatures are stripped, so a plain
signature (name / title / phone) survives at the end of many bodies. Treat a verbatim
recurring trailing block as the mail client's signature, not a chosen sign-off — note
it in the profile so drafts never include it (Gmail appends it on send).

## 3. Write the profile

Write `voice/email-voice-profile.md` in the workspace with exactly these sections,
every claim backed by observed frequency ("uses 'Best,' in 80% of external mail"),
with 2–3 verbatim example lines each:

- **Register map** — how tone shifts by audience (internal vs external, familiar vs
  cold), and how their length tracks the situation.
- **Openers & sign-offs** — actual greetings and closings with rough frequencies,
  including when they use none.
- **Rhythm** — sentence length, paragraph shape, how they open and end a body, use of
  fragments, lists, links.
- **Vocabulary & phrases** — recurring words, pet phrases, how they hedge, how they say
  yes and no.
- **Punctuation & formatting quirks** — dashes, ellipses, casing, emoji, bolding.
- **Hard rules** — things true of nearly every email ("never opens with 'I hope this
  finds you well'", "always lowercase to teammates").
- **Anti-patterns** — what they never do, plus the generic-AI tells to avoid
  (enthusiastic adjectives, "I'd be happy to", bullet-point answers to plain questions).

## 4. Validate before declaring done

Hold out 3 real threads the profile wasn't built from. For each, draft the user's
reply using only the profile, then compare with what they actually sent. Where the
real email diverges, tighten the profile — usually a missing hard rule or register
distinction. Record `validated: <date>` at the top of the profile once the drafts read
as plausibly theirs.

Show the user the finished profile and ask what feels wrong; their corrections go in
as hard rules. Re-run this skill any time they want it refreshed — it overwrites the
corpus and profile in place.
