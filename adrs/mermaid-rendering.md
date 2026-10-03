# Suggestion
Add rendering of mermaid diagrams within the chat view. This would bring it inline with other chat UIs like Claude

## Impl Proposal
Hook into the web-ui plugin using the same mechanism as hljs currently does. In fact, mermaid md fences are currently rendered as code blocks (with language=mermaid) this way, it can just be intercept here.


