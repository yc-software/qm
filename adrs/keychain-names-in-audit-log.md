Update after reading closer: the granted-credential path already does most of what I originally asked for. Every standing-grant injection records a `keychain.materialize` event with the credential id, grant id, and scope. So that half is covered.

What's not covered is the other two ways credentials get into a sandbox. Own-keychain credentials skip the audit record entirely, since the event only fires when there's a grantId. Connector tokens get injected into the env with no audit at all. The log can reconstruct shared-credential exposure but goes dark on the injections that happen most often.

The ask, narrowed: give own-credential and connector-token injections the same `keychain.materialize` treatment the granted path already has. Names and ids only, obviously not values. Same event shape, so nothing downstream changes.

Same goal as before. A leakage review should be a grep, not an archaeology project. This just points the grep at the paths that are currently invisible.
