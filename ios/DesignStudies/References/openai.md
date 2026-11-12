# QM through the Codex / ChatGPT design language

Research date: November 9, 2026, Asia/Seoul. Research performed with Aside CLI session `YzcPwOb2Yb7rqzDz`; its completed report and browser captures were inspected before finalizing the study. No personal conversations or services were accessed.

## Official sources inspected

- [ChatGPT App Store listing](https://apps.apple.com/us/app/chatgpt/id6448311069): public iPhone screenshots. The visible app canvas is white; assistant output sits directly on the canvas; user turns use faint cool-blue rounded bubbles. Navigation is compact, with a menu at the upper left and conversation controls at the upper right. A rounded composer has an add control on the left and voice controls on the right. The photographed app preview includes a blue voice action. The sidebar and model picker were not open in these screenshots.
- [Official ChatGPT app workspace demo](https://learn.chatgpt.com/docs/app): navigation groups projects and recent conversations, with a primary thread and a work/output area. The composer exposes attachments, a permission control, a model label and Send.
- [Codex product page](https://openai.com/codex/): parallel agents, visible progress, steering, and review are presented as core interactions.
- [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes): model selection is discoverable near the top of mobile conversations, though controls and labels have changed between releases. The study's Auto / Thinking / Pro labels are prototype choices, not a claim about the current model catalog.

## What this implementation preserves

White space, a restrained system type hierarchy, light user-message pills, unboxed assistant prose, small neutral navigation controls, a large rounded composer, add and voice actions, a project/history surface, expandable activity and a reviewable work artifact. The voice accent and user-bubble tint follow the observed App Store treatment. The application remains named QM and does not use OpenAI's logo.

## Inferred mobile adaptations

The grouped agent checklist, approval preview, document preview and project sheet translate the observed desktop Codex workspace into QM's native mobile context. They are not claimed to be existing Codex iOS screens. Color values, font sizes, corner radii and spacing are visual estimates. No published OpenAI design-token source or exact font measurement was available; SF system typography is the native approximation. This is a close design study rather than a verified pixel-for-pixel reproduction.

## Interaction and scope

The study supports populated chat, new chat, saved sample history, editable messages and local replies, model selection, expandable activity, sample document/image attachment, attachment-only messages, an announcement preview with a distinct approval action, a document preview and a voice preview. Approval and messages affect this disposable sample UI only. Voice does not request microphone access. Product backend behavior, schema, persisted/API payloads, credentials and deployment configuration are unchanged.

Browser reference captures remain in the Aside session's temporary directory outside the checkout. They are not committed or bundled as product assets. Build and simulator verification are coordinated by the root agent for the shared gallery target.
