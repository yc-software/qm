# The Slack text splitters can cut an emoji or a link in half

`slackSectionBlocks` in `src/slack/mrkdwn.ts` chops a long reply into 2900-character section
blocks with a plain `text.slice` at fixed offsets. That's a UTF-16 code-unit cut, so anything
above the basic plane gets guillotined at the boundary. An emoji that lands across the 2900
mark comes out as two lone surrogates, one stranded at the end of one block and the other at the
start of the next, and Slack renders a replacement box in both. Any reply longer than 2900
characters can trip this, and long agent replies aren't exactly rare.

The same offset cut also runs straight through a Slack entity like `<https://…|label>` or a
`*bold*` run, so a link can turn into a raw `<https://…` fragment and a stray asterisk leaks
into the text.

The naive slice shows up in a couple of neighbours too. `clip` and `inlineCode` in
`src/slack/util.ts` both truncate with `text.slice(0, max)` and can leave a dangling half-emoji
sitting right before the `…`. It feels like these want one small shared helper that cuts on a
safe boundary (a whole code point at minimum, and for the block splitter ideally a newline or
space, and not inside a `<…>` entity) instead of a raw character offset.

Nothing here is a logic bug, it just produces output that looks broken to whoever's reading in
Slack, which is the kind of rough edge people notice. Cheap to close. Happy to send the change
if you want it.
