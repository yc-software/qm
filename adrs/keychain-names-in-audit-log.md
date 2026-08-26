Was thinking through what an actual audit of a qm deployment would look like and hit a gap.

Say someone asks "did any tool call in scope A ever have scope B's secrets available?" The audit log can't answer that today. You'd have to go back and figure out what keychain entries the sandbox resolved at the time, based on whatever the scope config and image looked like back then. Doable, but painful.

So the ask: whenever credentials get injected into the sandbox, log which keychain entries were in play for that turn and who owns them. Names only, obviously not values. Should apply in every posture, and nothing else needs to change.

Basically turns a leakage review from an archaeology project into a grep. However you want to shape the field is fine by me.
