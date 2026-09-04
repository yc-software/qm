---
name: popular-web-designs
description: 54 real-world design systems (Stripe, Linear, Vercel, Notion, Apple…) as ready-to-paste HTML/CSS — exact colors, typography, components, and spacing for styling a page after a known brand.
---

# Popular Web Designs

54 real-world design systems ready for use when generating HTML/CSS. Each template captures a
site's complete visual language: color palette, typography hierarchy, component styles, spacing
system, shadows, responsive behavior, and practical agent prompts with exact CSS values.

## Default look comes first

This skill is for when the user wants a page styled after **a specific known brand**. If they
have not named one, use your deployment's house-style skill (a `*-design` skill under
`skills/`, when installed) instead of picking from this catalog.

## Related design skills

- **The house-style skill** (`*-design`, when installed) — the org's default look as
  ready-to-apply tokens. Use it unless the user asks for a specific brand below.
- **`taste-skill`** — use for the design _process and taste_ (reading the brief,
  producing variants, verifying the result, avoiding AI-design slop).
  Pair it with this skill when the user wants a thoughtfully-designed page styled
  after a known brand: `taste-skill` drives the workflow, this skill supplies
  the visual vocabulary.

## How to Use

1. Pick a design from the catalog below
2. Read it: `read skills/popular-web-designs/templates/<site>.md`
3. Use the design tokens and component specs when generating HTML
4. Build with `write`, then serve the result with the `publish` skill (`skills/publish/SKILL.md`)

Each template includes an **Implementation Notes** block at the top with:

- CDN font substitute and Google Fonts `<link>` tag (ready to paste)
- CSS font-family stacks for primary and monospace
- Reminders to use `write` for HTML creation and local headless Chromium for verification

## HTML Generation Pattern

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Page Title</title>

    <link href="https://fonts.googleapis.com/css2?family=..." rel="stylesheet" />
    <style>
      :root {
        --color-bg: #ffffff;
        --color-text: #171717;
        --color-accent: #533afd;
      }

      body {
        font-family: "Inter", system-ui, sans-serif;
        color: var(--color-text);
        background: var(--color-bg);
      }
    </style>
  </head>
  <body></body>
</html>
```

Write the file with `write`, verify the result locally (`curl -fsS http://localhost:<port>`,
then `chromium --headless --no-sandbox --disable-gpu --screenshot=/tmp/page.png http://localhost:<port>`
when a render check matters), and serve it with the `publish` skill to confirm visual
accuracy and hand over a stable link.

## Font Substitution Reference

Most sites use proprietary fonts unavailable via CDN. Each template maps to a Google Fonts
substitute that preserves the design's character. Common mappings:

| Proprietary Font          | CDN Substitute               | Character                      |
| ------------------------- | ---------------------------- | ------------------------------ |
| Geist / Geist Sans        | Geist (on Google Fonts)      | Geometric, compressed tracking |
| Geist Mono                | Geist Mono (on Google Fonts) | Clean monospace, ligatures     |
| sohne-var (Stripe)        | Source Sans 3                | Light weight elegance          |
| Berkeley Mono             | JetBrains Mono               | Technical monospace            |
| Airbnb Cereal VF          | DM Sans                      | Rounded, friendly geometric    |
| Circular (Spotify)        | DM Sans                      | Geometric, warm                |
| figmaSans                 | Inter                        | Clean humanist                 |
| Pin Sans (Pinterest)      | DM Sans                      | Friendly, rounded              |
| NVIDIA-EMEA               | Inter (or Arial system)      | Industrial, clean              |
| CoinbaseDisplay/Sans      | DM Sans                      | Geometric, trustworthy         |
| UberMove                  | DM Sans                      | Bold, tight                    |
| HashiCorp Sans            | Inter                        | Enterprise, neutral            |
| waldenburgNormal (Sanity) | Space Grotesk                | Geometric, slightly condensed  |
| IBM Plex Sans/Mono        | IBM Plex Sans/Mono           | Available on Google Fonts      |
| Rubik (Sentry)            | Rubik                        | Available on Google Fonts      |

When a template's CDN font matches the original (Inter, IBM Plex, Rubik, Geist), no
substitution loss occurs. When a substitute is used (DM Sans for Circular, Source Sans 3
for sohne-var), follow the template's weight, size, and letter-spacing values closely —
those carry more visual identity than the specific font face.

## Design Catalog

### AI & Machine Learning

| Template         | Site             | Style                                                   |
| ---------------- | ---------------- | ------------------------------------------------------- |
| `claude.md`      | Anthropic Claude | Warm terracotta accent, clean editorial layout          |
| `cohere.md`      | Cohere           | Vibrant gradients, data-rich dashboard aesthetic        |
| `elevenlabs.md`  | ElevenLabs       | Dark cinematic UI, audio-waveform aesthetics            |
| `minimax.md`     | Minimax          | Bold dark interface with neon accents                   |
| `mistral.ai.md`  | Mistral AI       | French-engineered minimalism, purple-toned              |
| `ollama.md`      | Ollama           | Terminal-first, monochrome simplicity                   |
| `opencode.ai.md` | OpenCode AI      | Developer-centric dark theme, full monospace            |
| `replicate.md`   | Replicate        | Clean white canvas, code-forward                        |
| `runwayml.md`    | RunwayML         | Cinematic dark UI, media-rich layout                    |
| `together.ai.md` | Together AI      | Technical, blueprint-style design                       |
| `voltagent.md`   | VoltAgent        | Void-black canvas, emerald accent, terminal-native      |
| `x.ai.md`        | xAI              | Stark monochrome, futuristic minimalism, full monospace |

### Developer Tools & Platforms

| Template        | Site       | Style                                           |
| --------------- | ---------- | ----------------------------------------------- |
| `cursor.md`     | Cursor     | Sleek dark interface, gradient accents          |
| `expo.md`       | Expo       | Dark theme, tight letter-spacing, code-centric  |
| `linear.app.md` | Linear     | Ultra-minimal dark-mode, precise, purple accent |
| `lovable.md`    | Lovable    | Playful gradients, friendly dev aesthetic       |
| `mintlify.md`   | Mintlify   | Clean, green-accented, reading-optimized        |
| `posthog.md`    | PostHog    | Playful branding, developer-friendly dark UI    |
| `raycast.md`    | Raycast    | Sleek dark chrome, vibrant gradient accents     |
| `resend.md`     | Resend     | Minimal dark theme, monospace accents           |
| `sentry.md`     | Sentry     | Dark dashboard, data-dense, pink-purple accent  |
| `supabase.md`   | Supabase   | Dark emerald theme, code-first developer tool   |
| `superhuman.md` | Superhuman | Premium dark UI, keyboard-first, purple glow    |
| `vercel.md`     | Vercel     | Black and white precision, Geist font system    |
| `warp.md`       | Warp       | Dark IDE-like interface, block-based command UI |
| `zapier.md`     | Zapier     | Warm orange, friendly illustration-driven       |

### Infrastructure & Cloud

| Template        | Site       | Style                                              |
| --------------- | ---------- | -------------------------------------------------- |
| `clickhouse.md` | ClickHouse | Yellow-accented, technical documentation style     |
| `composio.md`   | Composio   | Modern dark with colorful integration icons        |
| `hashicorp.md`  | HashiCorp  | Enterprise-clean, black and white                  |
| `mongodb.md`    | MongoDB    | Green leaf branding, developer documentation focus |
| `sanity.md`     | Sanity     | Red accent, content-first editorial layout         |
| `stripe.md`     | Stripe     | Signature purple gradients, weight-300 elegance    |

### Design & Productivity

| Template       | Site      | Style                                               |
| -------------- | --------- | --------------------------------------------------- |
| `airtable.md`  | Airtable  | Colorful, friendly, structured data aesthetic       |
| `cal.md`       | Cal.com   | Clean neutral UI, developer-oriented simplicity     |
| `clay.md`      | Clay      | Organic shapes, soft gradients, art-directed layout |
| `figma.md`     | Figma     | Vibrant multi-color, playful yet professional       |
| `framer.md`    | Framer    | Bold black and blue, motion-first, design-forward   |
| `intercom.md`  | Intercom  | Friendly blue palette, conversational UI patterns   |
| `miro.md`      | Miro      | Bright yellow accent, infinite canvas aesthetic     |
| `notion.md`    | Notion    | Warm minimalism, serif headings, soft surfaces      |
| `pinterest.md` | Pinterest | Red accent, masonry grid, image-first layout        |
| `webflow.md`   | Webflow   | Blue-accented, polished marketing site aesthetic    |

### Fintech & Crypto

| Template      | Site     | Style                                                   |
| ------------- | -------- | ------------------------------------------------------- |
| `coinbase.md` | Coinbase | Clean blue identity, trust-focused, institutional feel  |
| `kraken.md`   | Kraken   | Purple-accented dark UI, data-dense dashboards          |
| `revolut.md`  | Revolut  | Sleek dark interface, gradient cards, fintech precision |
| `wise.md`     | Wise     | Bright green accent, friendly and clear                 |

### Enterprise & Consumer

| Template     | Site    | Style                                                 |
| ------------ | ------- | ----------------------------------------------------- |
| `airbnb.md`  | Airbnb  | Warm coral accent, photography-driven, rounded UI     |
| `apple.md`   | Apple   | Premium white space, SF Pro, cinematic imagery        |
| `bmw.md`     | BMW     | Dark premium surfaces, precise engineering aesthetic  |
| `ibm.md`     | IBM     | Carbon design system, structured blue palette         |
| `nvidia.md`  | NVIDIA  | Green-black energy, technical power aesthetic         |
| `spacex.md`  | SpaceX  | Stark black and white, full-bleed imagery, futuristic |
| `spotify.md` | Spotify | Vibrant green on dark, bold type, album-art-driven    |
| `uber.md`    | Uber    | Bold black and white, tight type, urban energy        |

## Choosing a Design

Match the design to the content:

- **Developer tools / dashboards:** Linear, Vercel, Supabase, Raycast, Sentry
- **Documentation / content sites:** Mintlify, Notion, Sanity, MongoDB
- **Marketing / landing pages:** Stripe, Framer, Apple, SpaceX
- **Dark mode UIs:** Linear, Cursor, ElevenLabs, Warp, Superhuman
- **Light / clean UIs:** Vercel, Stripe, Notion, Cal.com, Replicate
- **Playful / friendly:** PostHog, Figma, Lovable, Zapier, Miro
- **Premium / luxury:** Apple, BMW, Stripe, Superhuman, Revolut
- **Data-dense / dashboards:** Sentry, Kraken, Cohere, ClickHouse
- **Monospace / terminal aesthetic:** Ollama, OpenCode, x.ai, VoltAgent
