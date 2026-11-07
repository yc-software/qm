# Wally as a model provider

Sanchit from RunAnywhere (YC W26) here. Wally is our OpenAI-compatible API for open-weight models (DeepSeek, GLM, Kimi, MiniMax). QM's custom providers already work with it without any code change, so this is a heads-up and a question, not a code PR.

## Works on main today

In Models settings, choose Add custom provider:

- Protocol: OpenAI Chat Completions
- Base URL: `https://inference.runanywhere.ai/v1`
- Key: from https://console.runanywhere.ai
- Models:

```
deepseek-v4.1-flash | DeepSeek V4.1 Flash | 1048576 | 65536 | true
glm-5.3-flash | GLM-5.3 Flash | 1048576 | 131072 | true
```

Key validation, a turn and a tool call all went through QM's own path on both models.

## Question

Is a custom provider the path you want for providers like ours, or would you take Wally as a built-in next to OpenRouter? Based on the config-matrix section of the spec we guessed the first, so this file is the whole change.

## Gaps we hit (general to custom providers)

- Custom models are text-only, so image input on `deepseek-v4.1-flash` isn't reachable.
- The settings form takes no prices, so cost shows as zero unless the provider is registered through the admin API with `input` and `output` per model.
