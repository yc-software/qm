# Sensitivity labels for scoped memory

qm already has a clear model for controlling what an agent is allowed to do inside a room or personal scope. I think there may be a related question around what information is allowed to leave that scope.

In startup-stack, each file can be marked public, internal, or restricted. When an agent creates something shareable, it builds that output from the private master rather than sharing the master itself. Public material can be used freely, internal material needs explicit approval, and restricted material is never included.

A similar convention could fit qm's room and person scopes. A room might contain information that is fine for everyone in that room but should not appear in another room, a public response, or an exported file. The agent could check the sensitivity label before moving or summarising content outside its original scope.

This feels complementary to qm's existing security postures. Those control what actions the agent may take. Sensitivity labels would control where the information involved in those actions may travel.
