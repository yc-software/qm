# Let apps built by QM use QM as their agent backend

I'd like QM to build and deploy apps that have agentic features backed by QM
itself. The use case is internal apps for signed-in QM users: an app should be
able to ask QM to do work, show its progress, and let the user interact with that
work through the app's own UI.

[AG-UI](https://docs.ag-ui.com/introduction) looks like a good fit for the connection
between the app and QM. For example, QM could update a form or dashboard, ask the
browser to run a UI action, and continue once the browser returns a result. That
would let apps use a standard client rather than each inventing their own agent
API.

I'd like this to be an optional plugin, with Pi as the first harness. The goal is
the full published AG-UI spec, currently 1.0, including shared state, frontend
tools, and human-in-the-loop interactions. Model-dependent capabilities would
still need to reflect what the selected model actually supports.

Calls should run as the person using the app, through QM's authenticated gateway,
with conversations private to that user and app. QM would keep enforcing its
existing permissions and approvals. A browser-tool handoff should survive a
backend restart so the user can return a result and continue.

This probably needs some core support as well as a plugin: typed conversation
input, state, and a way to pause for a frontend tool without inventing a tool
result. I'd keep those runtime pieces generic and the AG-UI protocol handling in
the plugin. An app example and a skill would give QM a starting point for building
against it.

Would this be useful upstream, and does that plugin/core split sound right? I'd
like to align on the direction before starting implementation.
