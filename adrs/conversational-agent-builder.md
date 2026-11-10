# Conversational agent builder

I want something inside the web UI that makes it really easy for future users to build new agents.

Right now, I use a coding agent to help build them, but users should be able to describe what they want inside their own dashboard and be consulted and guided on what is needed. Since there is already a chat interface in the web UI, maybe we can give that chat the ability to build agents in the user's dashboard instead of adding a separate builder.

It should use whichever API key and LLM provider already powers their app. The experience should feel like working with a knowledgeable person: the user describes the agent, the chat asks useful follow-up questions, and wherever the app can configure something for them, it does. If something requires the user, such as connecting a service or choosing how approvals should work, it guides them through that step and then continues.

The goal is for someone to be able to build, test, and improve their own agents conversationally without needing to edit files or know how the underlying agent system works.
