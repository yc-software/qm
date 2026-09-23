# Software Factory: design brief

Build a live "assembly line" view of an automated coding pipeline. Tickets are crates. Pipeline stages are machines. A conveyor belt snakes through the machines, and crates ride along it as their work moves forward.

This brief covers the look, the motion and the overall flow. It says nothing about where the data comes from. Assume you get a stream of snapshots, and design against the view model in section 2.

---

## 1. The idea in one paragraph

A dark factory floor. Stations stand in rows of three, and each station has a machine gantry across the top with crates sitting on the belt below. The belt runs left to right on row 1, turns down, runs right to left on row 2, and keeps snaking. When a ticket moves to a later stage, its crate doesn't jump. It rides along the belt path to the new station, and sparks go off when it lands. Busy machines blink, stamp and puff smoke. Idle machines read LINE CLEAR. It should feel alive at a glance, and it should still be readable when you look closely.

---

## 2. View model (what the UI consumes)

The UI receives a snapshot. When the snapshot changes, the UI re-renders it and animates only the differences.

```
Snapshot {
  updatedAt
  tickets: [{
    id                 // e.g. "IO-1234"
    title, url, project, assignee
    status             // working | done | failed
    stages: [{ name, state: active|done, ts }]   // ordered trail
    mr?, sessionUrl?
    terminalKind?      // "ready_for_review" | "done" (when status=done)
  }]
  queue: [{ id, title, url, assignee }]          // not started yet
  feed:  [{ ts, text }]                          // human-readable activity log
}
```

A ticket's position is its **active** stage, or the furthest **done** stage if nothing is active. A `working` ticket with no stages yet is "spinning up". It goes in the intake bin, not on the line.

---

## 3. Stations

Stations appear in pipeline order, and each has a colour and a glyph. Verify appears twice, and each occurrence gets its own station (the first Verify record maps to slot 1 and the second to slot 2).

| # | Station | Colour | Glyph |
|---|---|---|---|
| 01 | Fetch | #8b93a1 | ⛏ |
| 02 | Analyze | #4ea1ff | ⚛ |
| 03 | Verify | #4ecdc4 | ⚖ |
| 04 | Design | #b58cff | ✎ |
| 05 | Plan | #ffd166 | ▤ |
| 06 | Implement | #ff6b2b | ⚒ |
| 07 | Verify | #4ecdc4 | ⚖ |
| 08 | Review | #ffb020 | ◉ |
| 09 | Proof | #f28cb0 | ✓ |
| 10 | Ship | #3ddc84 | ⛟ |
| 11 | Ready for Review *(terminal)* | #7ef29a | ★ |
| 12 | Done *(terminal)* | #3ddc84 | ✔ |

Each station's colour flows everywhere through a CSS custom property (`--c`): the machine's bottom border, the lamp, the count, the crate link colour and the progress ticks.

---

## 4. Visual language

**Palette (dark, industrial):**
```
--bg #0b0d10   --panel #1a1e25   --panel2 #151920   --line #2a303a
--ink #e8e6df  --muted #8b93a1   --dim #5a6270      --steel #3a4250
--orange #ff6b2b (brand/primary)  --amber #ffb020  --green #3ddc84
--blue #4ea1ff (links)  --red #ff5d5d (failure)
--hazard1 #e8b426  --hazard2 #15171c
```

- **Floor:** `--bg` with a faint dot grid (`radial-gradient(#161a20 1px, transparent 1px)` at 26px).
- **Type:** the system sans for prose. Monospace (`ui-monospace, SFMono-Regular, Menlo`) for everything mechanical: IDs, labels, counts, timers, the feed. Labels are UPPERCASE with wide letter-spacing (.12–.15em) at 9–11px.
- **Header:** an orange ⚙ logo, then **SOFTWARE FACTORY** with a dim `// assembly line — live stages` after it. Small outlined nav buttons (stats, done, settings). A live indicator: a green dot blinking every 2.4s, then `LIVE · updated HH:MM:SS` followed by rolling done/failed counts.
- **Summary tiles:** small panels with a 2px coloured top rule, a big mono number and a tiny uppercase label. The tiles are: in queue (dim), on the line (orange), ready for review (green), done, failed (red).
- **Filter pills:** rounded pills labelled "crew" for assignees. Hovering gives an orange border. The selected pill is filled orange with dark text.

### Machine (station header)
- Steel gradient panel (`#232936 → #1a1f28`), 1px steel border, a **3px bottom border in the station colour**, and a drop shadow.
- Two small steel "legs" under it, drawn with ::before/::after.
- Contents from left to right: glyph, the name in uppercase with `station 07` under it, a count in the station colour or a `LINE CLEAR` tag, a status lamp and a hidden piston.

### Crate (ticket card)
- 225px wide, dark gradient body, 4 rivets in the corners.
- A **hazard-stripe top edge**: a 6px `border-image` of 45° repeating stripes (yellow/black). The stripes are **red** when the ticket failed and **green** once it's terminal.
- Line 1: a ⚙ (or a green ✔ when terminal), the ID as a link in the station colour, and the project in dim text, truncated.
- Line 2: the title, clamped to 2 lines at 85% opacity.
- Footer (mono, dim): assignee first name, `t+12m` (time at the current stage), `MR↗`, `SESSION↗`.
- Bottom: a **progress rail** with one thin segment per non-terminal station. Segments up to the current station are lit in the station colour.
- Hovering adds a 1px ring in the station colour.

### Belt (SVG, drawn behind the rows)
- Build one path that snakes through all the rows. Horizontal runs alternate direction, joined by vertical drops at the ends.
- Stroke it three times on top of itself:
  1. **frame**: steel `#3a4250`, width 44
  2. **bed**: `#171c24`, width 36
  3. **slats**: `#2b323e`, width 36, `stroke-dasharray: 4 18`, with the dash offset animated so the tread visibly moves
- A **turn plate** at every corner: a circle of r27 with an r7 hub.
- The belt's Y position on each row is measured from the DOM (just below the machine bar), so it always runs through the crate zone. Redraw it on resize and after any layout change.

### Around the line
- **Bins** below the line, in two columns: *Intake queue* (amber, chips, including "spinning up") and *Rejects: failed runs* (red chips).
- **Ticker** fixed along the bottom edge: a marquee of `⚙ IO-123 @ Implement · ✔ IO-456 ready for review · ✗ IO-789 failed`, scrolling for 45s on a linear loop.
- **Live feed drawer** on the left: a vertical orange `▸ FEED` tab halfway down the page opens it. The drawer slides in over .28s and pushes the page right. Its width is resizable with a drag grip, which highlights orange on hover. Each feed entry is a card with a coloured left rule for health (green healthy, amber neutral, red when the text mentions fail/error/stall/down), a clock and "ago" time, and a mono body. Bullet or action lines are amber, and concierge/conflict lines are blue. Slack-style `:emoji:` shortcodes are rendered as emoji.

---

## 5. Layout

- Rows of **3 stations**. Odd rows use `direction: rtl` (with each station's contents set back to ltr) so the physical order follows the snake.
- Twelve stations make **4 rows**, so the two terminal stations end up at the tail of the last row.
- The line has a min-width of about 1100px and scrolls horizontally inside its wrapper. Nothing else on the page may overflow sideways.
- Crates in a station are sorted newest-activity-first.

---

## 6. Motion (this is most of the charm)

| Effect | Trigger | Spec |
|---|---|---|
| **Belt tread** | always | slat dash offset from 0 to -22 over 1.5s, linear, infinite |
| **Lamp blink** | machine has crates | glow in station colour; opacity down to .3 at 50%, 1.1s loop |
| **Piston stamp** | machine busy | 10px nub under the gantry, height 6→16→6px, 1.8s ease-in-out loop |
| **Smoke puffs** | busy machines, randomly | every 1.8s, each busy machine has a ~35% chance: a 6px grey dot rises 34px, scales to 2.6× and fades out over 2.6s |
| **Crate rides the belt** | a ticket's station changes | see below |
| **Landing flash** | on arrival | 3px ring in station colour plus a green-tinted background, fading over 1.6s |
| **Sparks** | on arrival | 8 amber 3px dots burst up to ±30/±20px and fade over .7s |
| **Live dot** | header / drawer | 2–2.4s blink |
| **Loading cog** | loading history | ⚙ spins at 1.2s per turn with "pulling shift records…" |

### The crate ride (the main animation)
Use the FLIP pattern, but make the crate follow the belt instead of a straight line:

1. **Before** re-rendering, record the bounding box of every crate by ID.
2. Re-render. Compare each ticket's new station with its previous one. Skip this on the first render so the page doesn't animate on load.
3. For each crate that moved: clone it as a fixed-position `flying` element (z-index 99, heavy shadow) and hide the real one.
4. Find the belt path length nearest the old centre and nearest the new centre. Sample the path every 14px, then refine to ±2px.
5. Animate the clone along the path between those two lengths with `requestAnimationFrame` and an ease-in-out quad. Duration is `clamp(1100ms, distance × 2.4, 3400ms)`. Re-read the line's position every frame so the ride survives scrolling.
6. When it arrives, remove the clone, show the real crate, then flash and throw sparks.
7. If there's no belt path, fall back to a straight 1.1s glide with `cubic-bezier(.4,.1,.2,1)`.

If a crate changed station but has no previous box (for example, it was hidden by a filter), just flash it.

---

## 7. Views and navigation

- **Shift log bar** (pills): `LIVE · 24H` · `TODAY` · `YESTERDAY` · the last 5 weekdays · `RANGE ▾`.
- **Live**: the full line plus filters, bins and ticker, updated from the stream.
- **Single day**: stat tiles, a "Stations worked" grid of per-station counts, and dashed-separator rows of tickets. No belt motion.
- **Range**: date pickers plus 7d / 30d / 90d presets. It shows the line layout again, with one crate per ticket (latest run wins).
- Keep the selected view in the URL so links are shareable.
- History data is cached client-side for about 60s. If the user switches views mid-load, drop the stale result.
- Separate pages share the same chrome: **Done** (finished work) and **Stats** (analytics).

---

## 8. Process and behaviour rules

- **Push, not poll.** The page subscribes to a server event stream and re-renders on each snapshot. If the stream drops, reconnect after 5s. A slow timer keeps the ambient effects (smoke) going between snapshots.
- **Terminal placement is authoritative.** Once a ticket is done, it goes to *Ready for Review* or *Done* based on its tracker state. Don't leave it parked at Ship.
- **Failed tickets** leave the line for the Rejects bin and get red stripes wherever they appear.
- **Filters are view-only.** The assignee filter hides crates and adjusts the counts, but it doesn't change placement. It only offers names that are actually on the line, plus "unassigned".
- **Honest labels.** Use "Ready for review", not "MR opened". Keep counts literal. Show nothing a user could mistake for verification that didn't happen.
- **Degrade gracefully.** Show a red one-line error in the header when the snapshot carries an error. Show `connecting…` before the first snapshot. Show "line idle" in the ticker when nothing's moving.
- `?debug` mode: fetch one snapshot and render it without streaming, then print a JSON layout report (elements overflowing the viewport, stations per row, whether the belt path exists). This is useful for catching layout regressions.

---

## 9. Acceptance checks

- Four rows of three that snake correctly. The belt passes under every station's crates and turns at plates.
- Moving a ticket forward makes its crate ride the belt path (including around corners), then land with a flash and sparks. Nothing animates on first load.
- Busy machines blink, stamp and smoke. Idle ones read LINE CLEAR.
- Nothing overflows the page horizontally. The line scrolls within its own wrapper.
- The drawer opens and closes smoothly, resizes by drag, and the page reflows to match.
- Colours, stripes and progress rails are correct for working, failed and terminal crates.
