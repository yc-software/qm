# Use service accounts for Google access in shared rooms

Given a Slack channel where the following is true:
- Alice and Bob are both in a slack #finance channel
- Alice has approved a standing grant for Google Drive to use her OAuth
- Alice has a doc in her personal Google Drive called `AlicePersonalDoc`

Bob can ask QM agent (in Slack, or in the Project on QM dashboard) to "summarise `AlicePersonalDoc`". The bot will access `AlicePersonalDoc`

# Proposed fix

Support Service Accounts alongside the current Grant Approval flow for shared channels. 
This means that the agent scoped to that channel, would only have access to files that it has actually been invited to on Google Drive (enforcing Google-managed ACLs) for shared details. Automatic grant approvals when a file a user has access to could still be used afterwards. 

Allow the QM admin to upload a Google Service Account JSON with scoped permissions intended for shared use. A logical boundary could be an agent per channel.

The credential should belong to the organization or scope, not to the admin who happened to configure it, so changing admins does not change or orphan the security boundary.

## Alternative fix

Support uploading and using Service Accounts. Allow an admin switch which disables "standing" grants in channels. All future requests would need approved, and the only "standing" access would be through linked service accounts to a given channel
