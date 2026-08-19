# Memory provenance for shared room memory

I've been working on an open-source project called startup-stack, where an AI works from a company's shared files and knowledge base. One of the biggest problems we ran into was not whether the agent could remember something, but whether anyone could tell where that memory came from or whether it had been checked.

The convention we use is simple. Every factual claim carries a source and one of four states: confirmed, unverified, TBD, or conflict. Anything an agent extracts starts as unverified. Only a human can promote it to confirmed. If two sources disagree, both versions stay visible instead of the agent quietly choosing one.

I think a lightweight version of this could be useful for qm's shared room memory. Multiple agents and people can write into the same memory, so over time it becomes important to distinguish something a person confirmed from something an agent inferred or copied from an old message.

This would not need to prescribe a particular storage format. It could just be a convention that room-memory implementations or skills can follow. The goal is to stop agents confidently repeating a wrong fact after everyone has forgotten where it originally came from.
