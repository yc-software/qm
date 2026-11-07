# Wally as a model provider

Sanchit from RunAnywhere here. Wally is our OpenAI-compatible API for open-weight models (DeepSeek, GLM, Kimi, MiniMax). QM's custom providers already take it with no code change, so this is a heads-up and a question rather than a code PR.

What works on main today: Models settings, Add custom provider, protocol OpenAI Chat Completions, base URL `https://inference.runanywhere.ai/v1`, a key from https://console.runanywhere.ai, and models such as

```
deepseek-v4.1-flash | DeepSeek V4.1 Flash | 1048576 | 65536 | true
glm-5.3-flash | GLM-5.3 Flash | 1048576 | 131072 | true
```

Key validation, a turn and a tool call all went through QM's own path on both models.

The question: is that the path you want for providers like ours, or would you take Wally in the built-in list next to OpenRouter? Given the config-matrix section of the spec we guessed the former, in which case this file is the whole change.

One gap we hit: custom models are text-only, so image input on `deepseek-v4.1-flash` is not reachable through a custom provider.
