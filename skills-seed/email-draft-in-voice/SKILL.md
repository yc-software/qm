---
name: email-draft-in-voice
description: Draft Gmail in the user's own voice from the voice profile built by email-voice-profile. Drafts only; the user reviews and sends.
---

# Draft email in the user's voice

Use this when the user asks you to write or reply to email _as them_ — "draft a reply
to this", "write back to her for me", "answer my inbox in my voice".

## Load the profile first — never freehand

The profile lives in the user's Files, never on a particular computer. Find it by the
memory fact "Email voice profile is Files <id>", or failing that
`GET $AGENT_API_URL/v1/files?q=email-voice-profile` (header
`x-agent-capability: $AGENT_API_TOKEN`; take the newest match), then download it with
`GET $AGENT_API_URL/v1/files/<id>/content`. A missing file on disk means nothing; only
when memory and Files both come back empty does the profile not exist, and then run
the `email-voice-profile` skill first (personal DM only). Do not improvise a voice from
memory or from this conversation's tone. The profile's **Hard rules** and
**Anti-patterns** sections are constraints, not suggestions.

## Draft

1. Read the full thread you're replying to through the selected email access skill —
   never draft from a snippet or excerpt; a question below the fold would go silently
   unanswered. Match the register the profile prescribes for this audience.
2. Write the body to a file — plain text, one line per paragraph, blank line between.
   No styled HTML (fonts, colors, buttons); the email access skill sets the draft's format.
3. Self-check against the profile before showing anything: opener and sign-off drawn
   from their real ones, sentence rhythm right, no anti-pattern present. If a sentence
   could appear in anyone's email, rewrite it or cut it.
4. Show the user the exact text and ask for approval before creating any draft.

## Save the draft

Use the selected email access skill to create or update the Gmail draft, preserving
reply threading and recipients. Sending is a separate action and requires explicit
approval of the draft for sending.

## Afterward

Tell the user where the draft landed in Gmail Drafts and keep the draft id in memory
(one fact naming the thread and draft id) so a later turn on any computer can update it.
If they edit your text, notice what they changed — recurring corrections belong in the
voice profile as hard rules; offer to add them and republish the profile.
