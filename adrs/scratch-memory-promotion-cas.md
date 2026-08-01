# Scratch-memory promotion can overwrite newer edits

I noticed a race in scratch-memory promotion.

If promotion starts from revision `r0`, then someone saves a newer revision `r1` while the model is still running, the older promotion can finish later and overwrite that newer edit.

I think promotion should only commit if the revision it started from is still current. Otherwise it should discard the stale result and retry from the latest state.

Does it make sense to make atomic compare-and-set part of the memory store contract?
