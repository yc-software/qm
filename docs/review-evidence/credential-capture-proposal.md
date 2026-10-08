# Historical credential-capture proposal

The following excerpts preserve a rejected proposal and the objection to it. No implementation of this proposed browser-marker exception was recovered; this is original proposal text, not reconstructed code. Unrelated incident details and the discussion of a separate backstop change are omitted.

## Proposal

> **The recommended core fix (owed, ~one condition + a test):** inside the capture script, skip any `.config` subdirectory containing Chrome's *marker files* (`Local State`, `SingletonLock`, `Default/Preferences`) — detection by structure, not by name, so all five current offenders and any future browser die with one rule, on the box, before any bytes move.

## Objection

> This is a classic band-aid on a broken system. I think the proper fix here is actually for the agent to have a way to point the core toward the files that should be slurped up. Our "big dumb hose" system is a little _too_ dumb. Or perhaps there is a way to only slurp up the _diff_ for specific device-code-auth turns that the agent can somehow flag.

This is historical evidence for the Wall of shame, not a proposed runtime change.
