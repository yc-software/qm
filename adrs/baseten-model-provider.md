# Baseten Model APIs from one key

Michael from Baseten here. Baseten already works in qm today: an admin can add it as a custom provider with the OpenAI protocol and `https://inference.baseten.co/v1`, then type in each model id, context size and price by hand. That list goes stale as we ship models, and the prices and context windows people type are guesses.

The small thing we'd like is `BASETEN_API_KEY`: set it and qm reads Baseten's own model list (`/v1/models`) and offers every tool-capable model with its real context window, output limit, prices and reasoning flag, refreshed every few minutes. It rides on the existing custom-provider path (models show up as `custom/baseten/<model>`), so there is no new provider id, no base-URL setting and no new code path for turns. If an admin has already registered their own `baseten` custom provider, theirs wins and the built-in one stays out of the way.
