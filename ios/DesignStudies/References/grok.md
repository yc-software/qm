# QM × Grok

This is a native SwiftUI visual study with local, disposable sample conversations. It does not connect to Grok or a QM server and does not represent a production redesign.

## Aside research

Dedicated read-only Aside CLI session: `LzUEw8ZDE06u4oe8`.

The session was asked to inspect actual visual references on [Grok](https://grok.com), [xAI’s Grok product page](https://x.ai/grok), and official iOS App Store screenshots. Aside completed its inspection of the live dark grok.com interface, x.ai/grok, and all four iPhone previews on the [official App Store listing](https://apps.apple.com/us/app/grok/id6670324846). The iPhone previews show a near-black screen, white text, gray labels, broad rounded dark composer, add control, Auto/Expert control and a light Speak pill. Assistant answers sit on the background; prompts and source cards use rounded outlined surfaces. The header shows a hamburger, Ask/Imagine/Build tabs, and compose action. The web interface also showed Fast/Auto/Expert/Heavy model choices.

## Design decisions

The implemented direction uses a near-black canvas, graphite composer and user bubbles, off-white type, restrained thin borders, capsule suggestion buttons, a centered product/model selector, and a mostly unboxed assistant answer. These choices follow the observed monochrome surface and conversation hierarchy. The gallery uses a QM model menu and work-related shortcuts instead of copying creative-product modes. Exact colors and radii are visual interpretations, not measured native brand tokens.

The orbital symbol is an original geometric study motif for QM, not an official Grok logo. Typography uses the iOS system font with Dynamic Type. Exact original brand typefaces and spacing tokens have not been independently verified.

## QM-specific adaptations

The home screen adds recent and working conversations. The assistant response exposes three sample agent checks and an interactive release checklist document. These are QM work concepts, not features copied from Grok. Model and response-mode controls change local UI state; send produces a local sample answer. Document attachment is explicitly a demo context action. The share action uses the native iOS share sheet.

## Scope

Configuration, API payloads, persisted data shapes, and live schema are unchanged. The study is isolated in `ios/DesignStudies/Sources/GrokStudy.swift`.
