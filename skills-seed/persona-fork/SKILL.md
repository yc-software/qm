---
name: persona-fork
description: Fork a persona — copy its instructions, icon and skills into a new persona the asker owns, then help them attach their own credentials. Use when someone asks to fork, copy, clone or "make my own version of" a persona.
---

# Forking a persona

A fork is a snapshot the asker owns. It copies what the source _is_ (instructions, icon,
description, skills) and never what it is _allowed to do_ (credentials, sharing). Anyone
with any role on the source can fork it.

All calls use `$AGENT_API_URL` with `-H "x-agent-capability: $AGENT_API_TOKEN"`; the
routes are listed in `GET /v1/apis` when personas are enabled for the asker.

1. **Find the source.** `GET /v1/personas` and match the name the person used; if two
   match, ask which. `GET /v1/personas/<id>` gives its instructions, access list and the
   service names of attached credentials.
2. **Confirm the name** in one line (default: `<source name> (fork)`) unless they gave one.
3. **Create it:** `POST /v1/personas` with `name`, the source's `description`,
   `instructions` and `icon`. Mention the source in the description if they want the
   lineage kept. The asker becomes its sole owner.
4. **Copy skills.** The source's skills live in `persona:<source id>`. List them with the
   skills tool (`list` with `source: "persona:<source id>"`) and `read` each one, then
   create the copy directly in the fork with `POST /v1/skills` and
   `scopeId: "persona:<new id>"`. Copy only what they want if they said
   so; otherwise copy all. Skills are copies: later edits to the source don't flow through.
5. **Credentials.** Tell them which services the source had attached (from step 1), that
   those were not copied, and offer to attach their own. Attaching needs a credential the
   asker owns and a turn they sent: `POST /v1/personas/<new id>/credentials
{credentialId}`. Find their credential ids with `GET /v1/keychain/credentials`.
   Never attach someone else's credential and never re-use the source's grants.
6. **Sharing.** The fork starts private. If they want others to use it, set roles with
   `PUT /v1/personas/<new id>/access` — always keep them as an owner.

Finish with one short message: the new persona's name, what was copied, what wasn't,
and that they can chat with it from the Personas page or by asking to switch this
conversation to it (`PUT /v1/sessions/<this session id>/persona`).
