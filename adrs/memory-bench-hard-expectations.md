# A hard check for memories that sound right and aren't

I've been testing long-term memory in an agent I built because I stopped
trusting how confident a remembered fact could sound. I love numbers, but a
number is only useful if I know where it came from.

I read through the memory bench and like the way the judge sees the full
conversation and scores the notebook. I also went in thinking the extraction
prompt had missed some basic rules. It hadn't. You already tell it not to keep
credentials and not to turn the assistant's guess into the user's preference.
Credit where it's due.

The gap I ran into was between asking a model to follow a rule and knowing it
did.

Say a user gives the agent a budget. Later the assistant estimates that the
user is about 40% over it. If the extractor saves 40% as a fact, the next
conversation has no way to hear the difference. It sounds just as real as the
budget the user actually gave. The judge may catch that under
`inferenceVsObservation`, but it is still one model grading another model, and
the result is a score that can move around and still clear the floor.

Would it make sense for a bench conversation to carry a couple of hard
expectations alongside the judge? Something as small as facts or patterns that
must appear and facts or patterns that must not appear. Replay the
conversation, check those first, then let the model judge the softer quality
questions. If 40% only came from the assistant, that fixture fails every time,
not just when the judge notices.

The same little mechanism could test that a changed fact really replaced the
old one, that an important fact survived, or that a piece of one-off noise did
not become memory. The LLM judge still matters because memory quality is not
just string matching. This would only give the benchmark a few non-negotiables
that do not drift.

I'm not suggesting a new memory backend or a storage format. I just think a
benchmark should be able to say, "Whatever score you gave this notebook, this
specific thing is wrong." I have run into that enough in real work that an
empty memory sometimes feels safer than a confident one with the wrong
number.
