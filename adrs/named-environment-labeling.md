Currently the agent has the ability to promote an environment to a named environment, allowing multiple slack channels to essentially share the same VM (super useful if conversations with the same privileged group groups happen across multiple channels).

So I can:
1. create two channels: #A, and #B
2. promote #A's channel to a named environment A-permanent
3. attach #B to A-permanent
4. now the filesystem and information between #A and #B is shared.

Once this happens however, #B's original scope is fully orphaned, and in the admin panel, editing anything under #B doesn't edit any live information.
There's also no indication anywhere in the UI that #B is now attached to a different scope.

It would be super helpful if in the admin environment:
1. there was a list of shared/named environments.
2. if a an existing channel has been aliased, there is a link to the correct shared environment.
3. we lock or show a warning if an admin is attempting to edit or debug an orphaned environment.

Nice-to-have as well would be a skill to help with merging or combining two environments together. It's simple enough to prompt the agent into creating handoff docs prior to a detach & reattach, but it's a nice-to-have for teams like ours who started using qm before completely understanding the channel isolation semantics.
