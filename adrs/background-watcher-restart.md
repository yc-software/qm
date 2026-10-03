# Let the orchestrator relaunch background watcher jobs without a model turn

We run a background job in the sandbox that polls an external API and exits when there is
work for the agent (a monitor on the job wakes the model). It has two other exits that
carry no work at all: the injected connector token expired (roughly hourly), or its time
budget ran out. Today every one of those exits still costs a full model turn whose only
job is to relaunch the watcher and re-arm the monitor — that is ~24 no-op turns per day
per account, and the growing conversation makes each one dearer than the last. Worse, if
one of those relaunch turns ever fails (model error, sandbox recycled), watching stops
silently and nobody finds out until a user asks why the agent ignored them. We had both
happen; the no-op turns were most of a surprising token bill, and the silent stop cost us
a stranded user request.

The idea: let a job declare, when it is started, that certain exit codes mean "relaunch me
with a freshly minted connector token, no model needed" — the orchestrator does the
relaunch and re-arms the monitor itself, and only the exit that carries actual work wakes
the model. A natural extension is a declared "keep one of these running" flag so the
watcher survives sandbox recycling too. With that, model spend for a doc-watching agent
collapses to exactly the turns where a human actually wrote something.

Happy to talk through the exit-code contract we converged on (0 = work on stdout, 3 =
token stale, 4 = budget/wedged) if useful.
