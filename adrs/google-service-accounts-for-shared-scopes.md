# Use service accounts for Google access in shared rooms

I ran into an uncomfortable permission boundary with the current Google connector.

Google is connected through one person's OAuth account. In a shared room, that person can grant the room use of the credential. That sounds reasonable until Alice and Bob are both in a finance room: if Alice grants her Google credential there, Bob can ask QM to read anything that Alice's token can read, not just the files Alice had in mind when she approved the grant. The grant's purpose is useful context for the agent, but it is not a Google permission boundary.

This gets especially risky for people like a CFO. A standing Drive grant to one finance room is effectively a standing grant to the CFO's whole Google account for every member of that room. The safe operational advice would be "never keep anything private in an account you grant to a shared room," which feels like the wrong answer.

I'd like QM to support an organization-owned Google service account as a first-class connected identity for shared scopes. An admin could connect it to an organization, channel, or project, and Google itself would limit it to the Shared Drives or folders that room should be able to reach. The room would use that identity instead of borrowing a participant's personal OAuth token.

I don't think domain-wide delegation should be the default here, since impersonating a human would recreate the same problem. The useful boundary is a service account that is explicitly a member of the relevant Shared Drive or folders. Reads and writes would then be limited by Google ACLs, while QM's existing write approvals and audit trail would still apply.

The credential should belong to the organization or scope, not to the admin who happened to configure it, so changing admins does not change or orphan the security boundary.

Per-user Google connections would still make sense in personal conversations. The missing piece is a separate, admin-managed Google identity for collaborative scopes, so sharing access to the finance drive doesn't mean sharing the CFO's drive.
