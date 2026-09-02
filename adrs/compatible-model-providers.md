# OpenAI / Anthropic-compatible providers

Hey — undergrad in China here. Same person as the Chinese docs note. I've been
getting into agents a lot, and qm pulled me in on the distributed agent
collaboration side.

Quick thought on models. Today the product surface is basically anthropic /
openai / openrouter. Fine if you already live there. A lot of folks around me
can't use Anthropic cleanly, already have some other coding plan or gateway, or
want a local / self-hosted OpenAI-compatible box. OpenRouter helps for variety,
but it doesn't cover "I need my own base URL" or "my team's model only speaks
this compatible API."

What I'd actually want is closer to CC Switch's idea: not an endless hard-coded
vendor list, but a couple of wire protocols you can point at anything that
speaks them.

Rough ask (you own the design — just the shape that would help):

- Org admin registers a provider as OpenAI-compatible or Anthropic-compatible,
  with base URL + API key, plus which model ids should show up.
- A few presets to make setup less painful — DeepSeek, Kimi/Moonshot, MiniMax,
  xAI/Grok as examples, not the whole universe.
- Once admin turns them on and the org allowlist includes those models, people
  just use the existing web-ui model picker. No new switcher UI needed.
- Regular users shouldn't paste arbitrary base URLs — admin-only keeps that
  safer.

That way it's easier to try qm with keys or endpoints people already have,
including places where Anthropic isn't an option, without waiting for every new
vendor to become a first-class enum.

Text only from me. If the direction sounds right, happy to help test against
real compatible endpoints once something's there.

---

# OpenAI / Anthropic 兼容供应商

你好——我是一名来自中国的本科生，和中文文档那条是同一个人。最近对 agent 很
感兴趣，qm 是冲着分布式 agent 协作这一块吸引我来的。

关于模型的一个想法。现在产品面上基本是 anthropic / openai / openrouter。如果
你本来就用这三家，没问题。但我身边不少人用不了 Anthropic、已经有别的 coding
plan 或网关，或者想接本地 / 自建的 OpenAI 兼容服务。OpenRouter 能增加可选模型，
但盖不住「我要自己的 base URL」或「团队模型只认这个兼容 API」。

我真正想要的更接近 CC Switch 的思路：不要无尽的硬编码厂商列表，而是少量线
路协议，能指向任何讲这种协议的端点。

大致诉求（设计归你们——只说有用的形状）：

- 由 org admin 登记供应商：OpenAI 兼容或 Anthropic 兼容，填 base URL + API key，
  以及要露出的 model id。
- 若干预设降低配置成本——例如 DeepSeek、Kimi/Moonshot、MiniMax、xAI/Grok，
  只是例子，不是全部宇宙。
- admin 启用、且 org allowlist 包含这些模型后，大家继续用现有的 web-ui 模型
  选择器即可，不必再做一个切换 UI。
- 普通用户不要随便填任意 base URL——仅 admin 配置更安全。

这样别人更容易用已有的 key 或端点来试用 qm，包括用不了 Anthropic 的环境，也
不用等每个新厂商都先做成一等 enum。

我这边只交文字。如果方向对，等有实现了我可以帮忙用真实兼容端点测。
