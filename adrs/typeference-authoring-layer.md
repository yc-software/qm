Hey there, I’ve been working independently on a tool that seems to share a pretty exact seam with QM. It’s called TypeFerence. I didn’t build it for QM or write any QM code. I saw your release and realized the two projects may solve complementary halves of the same problem.

My read is that QM handles runtime layering well: an org soul, scoped skills, and narrower scopes that can shadow broader ones. TypeFerence handles the authoring side before that runtime resolution happens. It treats Markdown roughly how TypeScript treats raw JavaScript, letting organizational intent be assembled from typed, reusable enterprise, team, and role definitions with inheritance, controlled overrides, versioned packages, provenance, and conflict checking.

I’m not proposing that you merge a giant implementation as-is. It’s a fairly built-out independent project with enough specification, examples, and conformance work that you could point your agents at it and decide what, if anything, you want to take from it. It could become QM’s authoring layer, stay separate as an upstream compiler that feeds QM, or just contribute ideas. The fit seemed too close not to send it your way.

[buchk/TypeFerence](https://github.com/buchk/TypeFerence)
