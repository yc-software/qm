# Prevent personal CLI logins in shared scopes

We ran into a surprising case while adding Artifact Share as a deployment-layer skill.
The skill itself is safe to share org-wide, but running its CLI login from a Slack
channel stores that person's credential in the channel's durable computer. Other people
in the channel do not see the token, but they can ask the agent to act with the logged-in
account.

The current scope model makes this behavior understandable, but it is easy for a user to
miss the distinction between sharing a skill and sharing a resident login. Telling the
model to authenticate only in DMs helps, but it does not enforce the boundary.

Could deployment tools declare where resident login is allowed? Our desired default is:

- personal scope: a user may create and persist their own resident login;
- channel, group, and team scopes: personal login commands are denied;
- shared scopes may use only credentials deliberately registered or granted as shared;
- org policy supplies this floor, and narrower scopes cannot relax it.

It would also be useful to manage these rules declaratively in the deployment repository,
rather than applying a separate command policy to every concrete channel ID. A policy on
scope kinds such as `personal` or `channel` would avoid drift as new channels appear.

We are not attached to whether this is implemented as scope-aware command policy, a
resident-auth policy in tool descriptors, or a broker that keeps personal credentials
outside shared sandboxes. The important property is that a login performed by one person
cannot silently become ambient authority for everyone in a shared scope.
