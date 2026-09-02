# Configurable scope list for the Google OAuth keychain provider

The Google keychain provider ships a fixed scope list. Our deployment wants two extra
read-only scopes on the same grant — `drive.activity.readonly` and `directory.readonly` —
because together they let a tool verify which account actually wrote a Drive comment
(activity's legacyCommentId joins the comments API id, and People resolves the actor to an
email). Without them, comment authorship is just display-name text that anyone can fake,
and we currently run that feature degraded. There is no way to add scopes today short of
patching core.

The ask: let deployment config extend (or replace) a keychain provider's scope list, with
the usual re-consent flow when the list changes. Fine if additions are gated somehow —
scope creep on a shared grant is worth being deliberate about — but the list being
compiled in means any deployment with a slightly different need has to fork the provider.
