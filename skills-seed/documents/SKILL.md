---
name: documents
description: Create or revise workspace documents and PDF deliverables, including branded reports, proposals, handouts, and audience variants. Preserve approved content and assets, apply revisions, and visually review exported pages.
---

# Documents

## Preserve the source

Read the supplied material and identify the latest approved version before editing.
Preserve its substantive content, terms, and factual detail unless the user requests a
change. A request to improve layout does not authorize shortening or rewriting approved
content. Use provided logos and other brand assets; inspect the actual asset rather than
replacing it with styled text or an invented mark. Keep an editable source alongside the
export so later revisions change the document itself.

## Apply revisions to the deliverable

Make requested changes in the source and regenerate the affected exports before replying.
Check exact details such as contact information, dates, and durations against the request.
Do not substitute a promise to revise for the revised file.

For audience variants, keep shared content consistent with the latest approved changes.
Apply a shared correction to each affected variant while retaining intentional audience
differences. Before recommending or attaching a variant, reconcile it with the current
source and the latest revision requests, then inspect that exact exported file.

## Render and inspect

Use available sandbox tools to generate the requested format. For PDFs, extract text
with `pdftotext` to check substance and render pages with Poppler, for example:

```bash
mkdir -p preview
pdftoppm -png -scale-to 1568 document.pdf preview/page
```

Read each rendered page with `files({ action: "read", path: "preview/page-1.png" })`, using
the filenames the renderer produced. The reader accepts PNG, JPEG, GIF, and WebP up to
5 MB and returns visual content; it does not render PDFs, resize images, or repair them.
For other image inputs, use an available tool such as ImageMagick or Pillow to convert or
resize a preview first. Keep previews in the workspace and preserve the original assets.

Inspect layout, clipping, page breaks, readable text, logo placement, and the requested
changes. Text extraction and a successful export do not prove the pages look right. If a
whole-page preview makes text unreadable, render at higher resolution and inspect crops
or sections that stay below the image size limit. Fix defects, regenerate, and review the
affected pages again. If rendering or image inspection fails, say what remains unverified
instead of claiming visual approval.

Deliver the requested final file or selected audience variant and identify what changed.
Keep internal previews separate from the deliverable unless the user asks for them.
