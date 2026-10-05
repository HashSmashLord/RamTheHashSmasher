---
name: RAMherd
description: The tournament wallchart. A felt wall, one paper sheet, three inks.
colors:
  felt: "#1e4a3a"
  felt-deep: "#16392d"
  felt-rule: "rgba(232, 240, 234, 0.16)"
  felt-ink: "#e8f0ea"
  felt-ink-soft: "#9fd1b4"
  paper: "#f7f5ee"
  paper-shade: "#ebe7da"
  rule: "#bcc9df"
  rule-strong: "#6d87b4"
  ink: "#16191f"
  ink-soft: "#4b5160"
  pen: "#1f3570"
  pen-deep: "#15265a"
  pen-soft: "#51609a"
  judge: "#b8271f"
typography:
  display:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(2.2rem, 4vw, 3.1rem)"
    fontWeight: 800
    lineHeight: 0.94
    letterSpacing: "-0.035em"
    fontVariation: "wdth 112"
  headline:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(1.45rem, 2.4vw, 1.85rem)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.02em"
    fontVariation: "wdth 100"
  title:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.01em"
    fontVariation: "wdth 100"
  body:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
    fontFeature: "tnum"
    fontVariation: "wdth 100"
  small:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.92rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
    fontFeature: "tnum"
    fontVariation: "wdth 100"
  fine:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "normal"
    fontFeature: "tnum"
    fontVariation: "wdth 100"
  figure:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 700
    lineHeight: 1.55
    letterSpacing: "normal"
    fontFeature: "tnum"
    fontVariation: "wdth 100"
  label:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.74rem"
    fontWeight: 700
    lineHeight: 1.55
    letterSpacing: "0.07em"
    fontVariation: "wdth 78"
  button:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 700
    lineHeight: 1.55
    letterSpacing: "0.06em"
    fontVariation: "wdth 85"
  name:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 800
    lineHeight: 1.55
    letterSpacing: "-0.02em"
    fontVariation: "wdth 112"
rounded:
  hairline: "2px"
spacing:
  cell-y: "0.85rem"
  cell-x: "0.7rem"
  fund-row: "1rem"
  sheet-sm: "1.2rem"
  sheet-md: "2rem"
  sheet-lg: "2.2rem"
  part-gap: "1.8rem"
  part-gap-lg: "2.4rem"
  gutter: "clamp(1rem, 3vw, 2.5rem)"
  max: "1320px"
components:
  button-pen:
    backgroundColor: "{colors.pen}"
    textColor: "{colors.paper}"
    typography: "{typography.button}"
    rounded: "{rounded.hairline}"
    padding: "0.68rem 1.15rem"
  button-pen-hover:
    backgroundColor: "{colors.pen-deep}"
    textColor: "{colors.paper}"
  button-pen-disabled:
    backgroundColor: "{colors.pen-soft}"
    textColor: "{colors.paper}"
  control-ruled:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.pen}"
    rounded: "{rounded.hairline}"
    padding: "0.65rem 0.75rem"
  control-ruled-disabled:
    backgroundColor: "{colors.paper-shade}"
    textColor: "{colors.pen-soft}"
  sheet:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.hairline}"
    padding: "{spacing.sheet-sm}"
  felt-strip:
    backgroundColor: "{colors.felt-deep}"
    textColor: "{colors.felt-ink}"
    height: "3.4rem"
  judge-mark:
    backgroundColor: "transparent"
    textColor: "{colors.judge}"
    rounded: "{rounded.hairline}"
    padding: "0.15rem 0.45rem"
  pen-meter:
    backgroundColor: "{colors.pen}"
    height: "7px"
---

# Design System: RAMherd

## Overview

**Creative North Star: "The Tournament Wallchart"**

RAMherd's page is the results chart pinned in the hall between rounds. A bottle-green noticeboard felt owns the whole ground, the strip at the top and the footer. One tall off-white paper sheet is pinned on it and owns everything else: the ruled header box with the fund printed in it, the results board, the coordinator log, the idea slip, the regulations. Nothing floats above the sheet and nothing sits beside it; every part of the page is a part of that one sheet, opened by a printed double rule.

Three inks do all the talking. Printed black is what the organiser set before the hall opened: headings, column heads, prose, regulations. Blue-black pen is what gets written live by whoever keeps the chart: the fund figures, each entrant's row, every answer in the log, and every control a visitor touches. One judge red is reserved for HashSmash's own review states and the ruled judge margin, and is used nowhere else; it never marks focus, error or emphasis. Feint blue rulings carry the grid. The scene is light: a hall under fluorescent tubes, flat colour, no gradients, no imagery, a drawn weave on the felt rather than a photographed one.

A single grotesk with a real width axis (Archivo variable, self-hosted) does the work two families would otherwise do: wide and heavy for the sheet title and the name on the strip, condensed and tracked for column heads and stamps, normal for everything else, tabular figures wherever a number sits. Status is written, not chipped: a word, a small drawn glyph, and a clock. Rows nobody has written to for a while thin their ink. The world has one motion, "the pen writes": a changed cell re-inks left to right; nothing else moves.

**Key Characteristics:**
- One sheet on one wall: felt ground, a single paper surface, no cards, no panels, no second surface colour.
- Three inks with fixed jobs: printed black, pen blue-black, judge red; no second accent.
- Feint blue rulings and printed double rules carry all structure; borders are rulings, never outlines of boxes-for-their-own-sake.
- One typeface, three widths: 112 for the title and name, 78–85 for column heads, stamps and buttons, 100 for prose.
- Written status: word plus drawn glyph plus clock; stale rows thin to a paler pen; the judge's stamp is the only red.
- One motion: a left-to-right re-ink on changed cells, off entirely under reduced motion.
- Near-square geometry: a 2px hairline radius on the sheet, controls, stamp and toggle; nothing rounder.

## Colors

A green wall, an off-white sheet, and three inks: the whole palette is the materials of a chart in a hall, with blue rulings between them.

### Primary
- **Pen Blue-Black** (`pen`): the ballpoint. Every live-written value on the sheet: fund figures, entrant ids, round names, the status word and glyph, each coordinator answer, link text, the fill of the pen meter, the button face, the control text, the caret, and the focus outline. If a value can change while the page is open, it is pen.
- **Pen Deep** (`pen-deep`): the pen pressed harder; the button's hover face and border only.
- **Pen Soft** (`pen-soft`): dried, thinning ink. Stale rows (not written for more than 300 seconds) switch their id, round, status line and activity to this; the pending "Writing…" answer in the log; the disabled button and disabled control text; the "of $400.00" denominator beside a fund figure; the log's thin scrollbar thumb.

### Secondary
- **Judge Red** (`judge`): HashSmash's stamp. The `judge-mark` text and its 1.5px border, and the 1px ruled left edge of the Judge column at every width. Nothing else on the page is red: not focus, not errors, not warnings, not emphasis.

### Neutral
- **Felt** (`felt`): the page ground behind the sheet; `html` and `body` background, overlaid with a drawn 5×7px warp-and-weft tile (white lines at 3.5% and black lines at 5% opacity).
- **Felt Deep** (`felt-deep`): the sticky strip and the opened mobile menu; also the browser `theme-color` and the scrollbar track.
- **Felt Rule** (`felt-rule`): the one hairline under the strip and under the opened menu, and the border of the menu toggle.
- **Felt Ink** (`felt-ink`): text on the felt: the name, hovered strip links, the toggle icon, footer links, and the focus outline for anything sitting on felt.
- **Felt Ink Soft** (`felt-ink-soft`): resting strip links and footer prose on the felt; the page scrollbar thumb.
- **Paper** (`paper`): the sheet, every control's background, the pen meter's trough, the button's text, selection text, the skip link's background.
- **Paper Shade** (`paper-shade`): a disabled control's background and the log scrollbar track. The only tonal step the sheet has.
- **Ruling** (`rule`): feint blue rulings: fund-row dividers, every table row rule, the log's entry rules, the by-round dividers, the board/log divider, the mock-note rule, and link underlines by default.
- **Ruling Strong** (`rule-strong`): the printed heavier rule: the header box border (1.5px), the double rules opening each part (1px + 1px with a 4px gap), the column-head rule (2px), the pen meter's border, the notice's border, and the resting border of every control.
- **Printed Ink** (`ink`): body text, all headings, column heads, the bold question lines in the log, form labels, the by-round and fund row terms.
- **Printed Ink Soft** (`ink-soft`): secondary printed text: section leads, sub-lines under fund figures, the approach under an entrant id, the lane path under a round, the "written 8s ago" clock, the key, the Q/A marks, the "(optional)" tag, placeholders, the em dash where the judge has nothing yet, by-round terms.

### Named Rules
**The Three Inks Rule.** Printed black is what the organiser set; pen blue-black is anything written live or touched by the visitor; judge red is HashSmash's verdict and the judge margin. A colour outside those three jobs is a fourth ink and does not exist.

**The Red Is The Judge Rule.** Judge Red appears only in the `judge-mark` stamp and the ruled left edge of the Judge column. It never marks focus, validation, errors, warnings or emphasis. Focus is a 2px pen outline at 3px offset on the sheet, a felt-ink outline on the felt.

**The Rulings Carry The Grid Rule.** Structure is drawn with rulings (`rule`, `rule-strong`) and printed double rules, never with background tints, filled bands, zebra stripes or boxed cards. The sheet has one tone; `paper-shade` is reserved for a disabled control.

## Typography

**Display Font:** Archivo variable (self-hosted, `fonts/archivo-variable.woff2`, wght 100–900, wdth 62–125), with Helvetica Neue, Arial fallback
**Body Font:** the same Archivo variable
**Label/Mono Font:** none distinct; tabular figures (`font-variant-numeric: tabular-nums` on `body`) do the mono's job for numbers

**Character:** One face, three widths. The width axis is the system: wide and heavy (wdth 112, wght 800) says "this was printed large on the sheet"; condensed and tracked (wdth 78–85, wght 700, uppercase) says "column head" or "stamp"; normal width says "prose". No italics are used anywhere.

### Hierarchy
- **Display** (800, `clamp(2.2rem, 4vw, 3.1rem)`, 0.94, −0.035em, wdth 112, max 15ch): the sheet title in the header box. The build sets the hook sentence here, not the product name; the name lives on the strip.
- **Name** (800, 1.15rem, −0.02em, wdth 112): "RAMherd" on the felt strip. The same wide-heavy voice as Display, small.
- **Headline** (700, `clamp(1.45rem, 2.4vw, 1.85rem)`, 1.05, −0.02em): the h2 that opens each part of the sheet (the board, the coordinator, the slip, the regulations).
- **Title** (700, 1.05rem, 1.05, −0.01em): h3 inside a part: the notice's heading, the regulation sub-heads.
- **Body** (400, 1rem, 1.55, max 68ch; section leads 60ch in `ink-soft`): prose. Inside the table and log the body steps down to 0.92rem; sub-lines (approach, path, clock, sub-notes, key) sit at 0.74–0.82rem with line-height 1.35.
- **Figure** (700, 1.35rem, tabular, `pen`): the three fund values. Secondary figures (by-round entrants, entrant ids, round ids) are 0.95rem at 600–700 in `pen`.
- **Label** (700, 0.74rem, +0.07em, uppercase, wdth 78): column heads, the by-round head and terms. The stamp (`judge-mark`) is the same voice at 0.7rem, +0.08em, wdth 80; the log's Q/A marks at 0.72rem, +0.06em, wdth 80.
- **Button** (700, 0.85rem, +0.06em, uppercase, wdth 85): the pen button only.

### Named Rules
**The Width Axis Rule.** Hierarchy is carried by width and weight, not by a second family. 112 wide for the title and the name, 78–85 condensed for column heads, stamps, marks and buttons, 100 for everything else. A second typeface is a fourth ink.

**The Column Head Rule.** The condensed, tracked, uppercase voice belongs to column heads, row heads, stamps and buttons: things that label a cell. It is never set above a headline as a kicker or eyebrow.

**The Tabular Figures Rule.** Every number sits in tabular figures so a rewritten value does not shift its neighbours. A fund figure is the only place a number grows past body size (1.35rem).

## Layout

The page is one centred column (max 1320px, side gutter `clamp(1rem, 3vw, 2.5rem)`) in three bands: the sticky felt strip (min-height 3.4rem, 1px felt-rule beneath), the sheet, and the felt footer. The sheet carries its own inset: 1.2rem below 700px, 2rem from 700px, 2.2rem from 1100px. The header box inside it uses the same steps for its title cell (1.2 / 1.8 / 2rem), and the board/log halves open their shared gutter from 1rem to 1.6rem to 2rem on the same breakpoints.

Inside the sheet, every part is opened by a printed double rule (two 1px `rule-strong` lines 4px apart) and separated by 1.8rem (board row) or 2.4rem (slip, regulations) of paper above it. The parts in order: the ruled header box (title cell 1.25fr beside the fund column 1fr, the by-round strip across the full width beneath), the board row (results 2fr, log 1fr, a 1px ruling between), the slip row (slip 1.2fr, notice 0.8fr, gap `clamp(1.4rem, 3vw, 2.6rem)`), and the regulations (two equal columns, 2rem gap, mock-note ruled off beneath).

Cells have fixed geometry across states so the states compare at a glance: table cells are 0.85rem tall-padded and 0.7rem right-padded, with 2px `rule-strong` under the column heads and 1px `rule` under each row; the Entrant column is 8.5rem wide, Round 11.5rem, Judge 6.2rem; fund rows are padded 1rem by `clamp(1rem, 2.5vw, 1.6rem)`; by-round cells 0.55rem by 0.9rem; log entries 0.85rem on a 1.5rem mark column. Above 1000px the log takes the board's height and scrolls inside it (`height: 0; min-height: 100%`), never past it; below, the log's list caps at 36rem and scrolls.

Responsive rules, widest first:
- **≤1000px**: the board row stacks; the board loses its right ruling and gains a bottom one; the log loses its left inset.
- **≤860px**: the header box stacks (title over fund, a 1.5px `rule-strong` between); the slip row and regulations go to one column; the strip's links collapse behind a 2.4rem ruled toggle and open as a full-width felt-deep panel under the strip.
- **≤640px**: table rows become ruled blocks: the thead is visually hidden, each row is a grid of Entrant / Round / Judge (5.4rem) on the first line and Now across the full width beneath, rows ruled by 1px `rule`; the Judge cell keeps its red left edge; the ask form stacks and the button goes full width; fund rows go single-column with left-aligned figures; the by-round strip stacks its head over a two-column grid of rounds.

## Elevation & Depth

Flat, with one exception: the sheet. Depth on this page is the physical fact of a paper sheet pinned on a felt wall, and nothing else lifts. The sheet carries a two-part shadow, a 1px contact edge and a long soft fall below it. The strip is sticky but flat (its edge is a 1px felt-rule, not a shadow). Controls, the notice, the stamp and the header box are drawn as rulings on the sheet, never raised. Hover and focus never add shadow. Materials are flat colour; the felt's weave is a drawn SVG tile, not a raster texture.

### Shadow Vocabulary
- **Pinned sheet** (`box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25), 0 24px 48px -20px rgba(0, 0, 0, 0.6)`): the sheet, and only the sheet.

### Named Rules
**The One Sheet Rule.** There is one surface on the wall. Nothing else casts a shadow, nothing floats above the sheet, and no part of the sheet is a second, inset surface. If a new element needs to be "on top", it is drawn as a ruled box on the sheet instead.

## Shapes

Near-square. Every corner on the page is either sharp (the sheet's header box, rulings, the notice, the confirmation, the meter, the felt strip) or a 2px hairline radius that reads as the print's slight softness (the sheet itself, every control, the pen button, the stamp, the menu toggle). Borders are rulings: 1px feint blue (`rule`) between rows, 1.5px strong blue (`rule-strong`) around printed boxes, 2px under column heads, 1.5px pen around the confirmation, 1.5px judge red around the stamp. The one filled shape is the pen meter: a 7px trough bordered in `rule-strong` with a pen fill drawn from the left. Drawn glyphs are 15px, stroked at 1.6 with round caps, one circle with a mark inside; the external-link arrow is 12px in the same stroke. No pill, no circle avatars, no chips.

## Components

### Felt Strip (`felt-strip`)
- **Character:** the board's nameplate, pinned to the top of the hall.
- **Shape:** sticky, flat `felt-deep` band, min-height 3.4rem, 1px `felt-rule` beneath.
- **Name:** "RAMherd" in Name type, `felt-ink`, no underline.
- **Links:** 0.92rem at 500 in `felt-ink-soft`, 1.4rem apart; the external link sits at the far right with a 12px drawn arrow and an sr-only "(opens in a new tab)".
- **Hover:** link turns `felt-ink` and underlines in its own colour (offset 0.22em).
- **Focus:** 2px `felt-ink` outline.
- **≤860px:** links hide behind a 2.4rem square toggle ruled in `felt-rule`, radius 2px; the toggle's three bars morph to a cross via `d: path()` when open; the menu opens as a full-bleed `felt-deep` panel under the strip, links stacked 0.9rem apart.

### Sheet (`sheet`)
- **Corner Style:** 2px hairline.
- **Background:** `paper`, text `ink`.
- **Shadow Strategy:** the pinned-sheet shadow, see Elevation & Depth.
- **Internal Padding:** 1.2rem / 2rem (≥700px) / 2.2rem (≥1100px).
- **Rule:** one per page. It holds every other component below.

### Header Box
- **Character:** the chart's printed heading: a ruled box across the full sheet width.
- **Shape:** 1.5px `rule-strong` border, square corners, two cells (title 1.25fr, fund 1fr) divided by a 1.5px `rule-strong` ruling; the by-round strip across the bottom under a 1.5px rule.
- **Title cell:** Display type (the hook sentence, max 15ch), the event line beneath at 1.02rem (max 58ch), the event note at 0.92rem in `ink-soft`.
- **Fund rows:** three rows ruled by 1px `rule`, each a term (600, 0.95rem, `ink`) beside a right-aligned Figure in `pen` with its sub-line in `ink-soft` 0.82rem beneath. The "of $X" denominator is `fund-of`: 500, 0.95rem, `pen-soft`.
- **Pen meter** (`pen-meter`): a 7px trough, 1px `rule-strong` border on `paper`, fill in `pen` scaled from the left (`transform: scaleX`), transitioned 0.6s on the standard ease-out; drawn without transition on first paint.
- **By-round strip:** a Label head on the left ("Entrants by round"), then an auto-fit grid of rounds (min 8.5rem) each ruled off on the left by 1px `rule`: term in Label `ink-soft`, entrants in 600 0.95rem `pen`.

### Results Table (signature)
- **Character:** the wallchart itself: one written row per entrant, fixed cell geometry, written status.
- **Heads:** Label type in `ink`, 2px `rule-strong` beneath; Entrant / Round / Now / Judge.
- **Rows:** 0.85rem vertical cell padding, 1px `rule` beneath, 0.92rem base size, top-aligned.
- **Entrant cell:** id in `pen` 700 0.95rem over the approach in `ink-soft` 0.8rem.
- **Round cell:** round id in `pen` 600 over the lane path in `ink-soft` 0.74rem, breakable only after a slash (each segment is `nowrap`).
- **Now cell:** the status line (drawn 15px glyph + status word, `pen` 600, + "written 8s ago" clock in `ink-soft` 400 0.82rem) over the activity sentence in `pen` 0.9rem, max 62ch.
- **Glyphs:** one circle with a mark: a clock hand (running), three dots (thinking), a dashed circle (idle), a tick (submitted). Stroke 1.6, round caps, `currentColor`.
- **Judge margin:** the last column has a 1px `judge` ruled left edge at every width; width 6.2rem.
- **Judge mark** (`judge-mark`): an inline stamp: `judge` text and 1.5px border in currentColor, radius 2px, 0.15rem × 0.45rem padding, 0.7rem 700 uppercase +0.08em wdth 80, nowrap. Where the judge has said nothing, an em dash in `ink-soft` with sr-only "nothing from the judge yet".
- **Stale ink:** a row not written to for more than 300 seconds switches its id, round, status line and activity from `pen` to `pen-soft` and drops the activity to weight 400. Nothing else changes; the geometry holds.
- **Key:** a fixed legend beneath the table at 0.82rem `ink-soft`, glyphs in `pen`, the stamp shown once as itself. It never moves.
- **≤640px:** see Layout; rows become ruled blocks.

### Coordinator Log
- **Character:** the Q&A written down the right of the chart, newest at the top, question box above it.
- **Ask form:** a ruled control and the pen button side by side, 0.5rem apart; stacks at ≤640px.
- **Entries:** an ordered list ruled by 1px `rule` top and between, each entry a 1.5rem mark column (Q / A marks: 0.72rem 700 uppercase +0.06em wdth 80 `ink-soft`) beside the text at 0.92rem: the question in `ink` 600, the answer in `pen`.
- **Pending:** the answer reads "Writing…" in `pen-soft` until the real answer is written in with the pen motion.
- **Scrolling:** above 1000px the list fills the board's height and scrolls inside it; below, it caps at 36rem. Thin scrollbar in `pen-soft` on `paper-shade`.
- **Live region:** `aria-live="polite"`.

### Ruled Controls (`control-ruled`)
- **Style:** `paper` background, 1px `rule-strong` border, 2px radius, 0.65rem × 0.75rem padding, 0.95rem text in `pen`, caret in `pen`, placeholder in `ink-soft` at full opacity.
- **Focus:** 2px `pen` outline at 1px offset and the border turns `pen`.
- **Disabled:** text `pen-soft` on `paper-shade`.
- **Textarea:** min-height 9rem, vertical resize, line-height 1.5.
- **Select:** native appearance removed, a 14px drawn pen chevron at the right (0.75rem inset), 2.4rem right padding.
- **Labels:** 600 at 0.92rem in `ink`; "(optional)" in `ink-soft` 400.

### Pen Button (`button-pen`)
- **Shape:** 2px radius, 1px border in the same colour as the face.
- **Primary:** `pen` face, `paper` text, Button type, 0.68rem × 1.15rem padding.
- **Hover:** `pen-deep` face and border, 0.15s ease on background and border only.
- **Disabled:** `pen-soft` face and border, default cursor; the label rewrites to its progressive form ("Handing in…").
- **Focus:** the global 2px `pen` outline at 3px offset.
- **Variants:** none. There is one button on this sheet and it is always the pen.

### Slip and Notice
- **Slip:** a form of ruled controls stacked 1.1rem apart under a Headline and lead; the button sits flush left.
- **Confirmation (`confirm`):** hidden until shown; a 1.5px `pen` ruled box, 0.8rem × 0.9rem padding, 0.9rem `pen` text with a 16px drawn tick, `role="status"`. It is pen, not red, because it is something written by the chart-keeper.
- **Notice:** an aside ruled in 1.5px `rule-strong`, padding `clamp(1rem, 2.5vw, 1.5rem)`, Title heading and 0.92rem prose; printed black because the organiser set it.

### Regulations
- **Style:** opened by a double rule with 1.7rem beneath it; a Headline and lead, then two equal columns of Title + 0.92rem prose; a mock-note ruled off beneath (1px `rule`, 0.82rem `ink-soft`).

### Footer
- **Style:** on the felt, 2.4rem below the sheet; two lines of 0.86rem `felt-ink-soft` prose spread to the edges, links in `felt-ink` underlined in `felt-ink-soft`.

### The One Motion: "the pen writes"
A changed cell is re-inked left to right: `clip-path: inset(0 100% 0 0)` to `inset(0 0 0 0)` over 0.55s on the standard ease-out (`cubic-bezier(0.16, 1, 0.3, 1)`), applied by adding `.writing` and removed on `animationend`. It fires on a fund figure that changed, a status line whose word, activity or clock went backwards (someone just wrote the row), a changed activity sentence, and a coordinator answer arriving. The first paint is never animated: figures and rows are drawn, not written. The table is diffed by entrant id so a tick never re-renders the sheet. The pen meter's 0.6s `transform` transition is the only other movement and is suppressed on first paint. Under `prefers-reduced-motion: reduce` the keyframes are not defined and the script skips the class entirely: changes simply appear.

## Do's and Don'ts

### Do:
- **Do** write every live or visitor-touched value in `pen` (#1f3570) and every organiser-set word in `ink` (#16191f); if a value can change while the page is open, it is pen.
- **Do** keep Judge Red (#b8271f) to the `judge-mark` stamp and the ruled Judge margin; show focus as a 2px pen outline (felt-ink on the felt).
- **Do** draw structure with rulings: 1px `rule` (#bcc9df) between rows, 1.5px `rule-strong` (#6d87b4) around printed boxes, and the printed double rule (1px + 4px + 1px) to open each part of the sheet.
- **Do** carry hierarchy on Archivo's width axis: wdth 112 at 800 for the title and name, wdth 78–85 at 700 uppercase for column heads, stamps and buttons, wdth 100 for prose; tabular figures on every number.
- **Do** write status as a word, a drawn 15px glyph and a clock in one line, with fixed cell geometry across every state, and thin a row to `pen-soft` after 300 seconds without a write.
- **Do** re-ink a changed cell left to right (0.55s, `cubic-bezier(0.16, 1, 0.3, 1)`), diff rows by key, never animate the first paint, and skip the motion under reduced motion.
- **Do** keep one surface: the paper sheet with its pinned-sheet shadow; set new elements into it as ruled boxes.
- **Do** keep the legend beneath the table fixed and in one place.

### Don't:
- **Don't** add chips, pills, badges or filled status tokens; status is written, and the judge's stamp is the only boxed word.
- **Don't** add cards, panels, tinted bands, zebra stripes or a second surface colour on the sheet; `paper-shade` is for a disabled control only.
- **Don't** introduce a second accent, a success green, a warning amber, or any colour outside the three inks and the rulings.
- **Don't** set the condensed uppercase voice above a headline as a kicker or eyebrow; it labels cells, not sections.
- **Don't** use a second typeface, a mono face for numbers, italics, or a system display face; Archivo's width and weight axes are the whole range.
- **Don't** use red for focus, validation, errors or emphasis; red is HashSmash's verdict.
- **Don't** fade, slide, re-render or re-sort the sheet on a feed tick; a change is a discrete write to the cell that changed.
- **Don't** add shadows, lifts or glows on hover or focus, or on anything other than the sheet itself.
- **Don't** round anything past the 2px hairline; no pills, no circle avatars.
- **Don't** replace the drawn felt tile or the drawn glyphs with raster textures, icon fonts or icon-library imports.
