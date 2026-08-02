# Make approvals single-use and bound to one action

What makes me uncomfortable when I give an AI approval to act is the possibility that the same approval could be reused for other actions.

When I approve something, I mean one specific action inside a limited scope. I do not mean that the agent should keep the same authority and use it again later.

I would like an approval to be bound to the action the user reviewed, including the target, operation, and important arguments. Once that action has been executed, the approval should be consumed and no longer reusable. If the action or its scope changes, the agent should ask for a new approval.

After execution, I would also like a clear readback showing what happened before and after the action. This should remain in the audit trail so the user can verify that the approval was used only for what they intended.

A small first version could apply this only to actions that create an external side effect, while read-only actions continue to work as they do today.
