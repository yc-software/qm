---
name: email-draft-in-voice
description: Draft Gmail in the user's own voice from the voice profile built by email-voice-profile. Drafts only; the user reviews and sends.
requiredCapabilities:
  - egress:gmail.googleapis.com
---

# Draft email in the user's voice

Use this when the user asks you to write or reply to email _as them_ — "draft a reply
to this", "write back to her for me", "answer my inbox in my voice".

## Load the profile first — never freehand

Read `voice/email-voice-profile.md` from the workspace. If it doesn't exist, run the
`email-voice-profile` skill first (personal DM only) — do not improvise a voice from
memory or from this conversation's tone. The profile's **Hard rules** and
**Anti-patterns** sections are constraints, not suggestions.

## Draft

1. Read the full thread you're replying to with `gmail.py thread THREAD_ID --full` —
   never draft from a snippet or excerpt; a question below the fold would go silently
   unanswered. Match the register the profile prescribes for this audience.
2. Write the body to a file — plain text, one line per paragraph, blank line between.
   Plain text only — never styled HTML (fonts, colors, buttons); the gmail helper
   adds the correct unstyled HTML mirror itself.
3. Self-check against the profile before showing anything: opener and sign-off drawn
   from their real ones, sentence rhythm right, no anti-pattern present. If a sentence
   could appear in anyone's email, rewrite it or cut it.
4. Show the user the exact text and ask for approval before creating any draft.

## Gmail

Use the google-workspace skill's helper (the user's OAuth token is already on your
computer):

```bash
python3 skills/google-workspace/scripts/gmail.py draft --to a@b.com --subject '...' --body-file body.txt
python3 skills/google-workspace/scripts/gmail.py reply MESSAGE_ID --body-file body.txt [--all]
```

Sending (`send-draft`) only ever fires on a draft the user explicitly approved for
sending, per that skill's rules.

## Afterward

Tell the user where the draft landed in Gmail Drafts and keep the draft id in the
workspace so it can be updated. If they edit your text, notice what they changed —
recurring corrections belong in the voice profile as hard rules; offer to add them.
