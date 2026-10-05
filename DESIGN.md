---
name: HashRammers
description: A line-printer listing on a black screen, in the pixel ram's own 1-bit world; amber only for what is live.
colors:
  bg: "#000000"
  ink: "#ffffff"
  ink-2: "#a8a8a8"
  ink-3: "#7b7b7b"
  ink-press: "#d4d4d4"
  rule: "#3a3a3a"
  rule-2: "#1c1c1c"
  live: "#ffb000"
typography:
  display:
    fontFamily: "Jersey 10, Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(2.8rem, 6vw, 5rem)"
    fontWeight: 400
    lineHeight: 0.95
    letterSpacing: "0"
  headline:
    fontFamily: "Jersey 10, Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(2rem, 4vw, 3rem)"
    fontWeight: 400
    lineHeight: 0.95
    letterSpacing: "0"
  title:
    fontFamily: "Jersey 10, Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0"
  banner:
    fontFamily: "Jersey 10, Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(4rem, 12vw, 9rem)"
    fontWeight: 400
    lineHeight: 0.85
    letterSpacing: "0"
  wordmark:
    fontFamily: "Jersey 10, Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(5rem, 22vw, 16rem)"
    fontWeight: 400
    lineHeight: 0.8
    letterSpacing: "0"
  figure:
    fontFamily: "Jersey 10, Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "2rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0"
  id:
    fontFamily: "Jersey 10, Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0"
  id-small:
    fontFamily: "Jersey 10, Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0"
  lead:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(1rem, 1.3vw, 1.15rem)"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  body:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  body-small:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  fine:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "Silkscreen, Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.08em"
    textTransform: "uppercase"
rounded:
  none: "0"
spacing:
  unit: "4px"
  nav-h: "4rem"
  gutter: "clamp(1rem, 4vw, 3rem)"
  max: "1200px"
  banner-top: "clamp(2rem, 4vw, 3rem)"
  section-top: "clamp(4rem, 8vw, 6.5rem)"
  section-head: "1.8rem"
  spray-gap: "1.4rem"
  tile-gap: "2.6rem 2rem"
  tile-gap-narrow: "2.2rem"
  panel-min-height: "36rem"
  panel-pad: "1.3rem 1.4rem"
  foot-top: "clamp(4rem, 8vw, 7rem)"
  ram-page-top: "clamp(2rem, 5vw, 4rem)"
  slip-part-top: "clamp(3rem, 6vw, 4.5rem)"
components:
  pill:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "48px"
    padding: "0 24px"
  pill-hover:
    backgroundColor: "{colors.ink-press}"
  pill-disabled:
    backgroundColor: "{colors.ink-3}"
  pill-ghost:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "48px"
    padding: "0 24px"
  pill-ghost-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg}"
  pill-small:
    height: "40px"
    padding: "0 20px"
  control:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    height: "48px"
    padding: "0.6rem 0.9rem"
  control-disabled:
    textColor: "{colors.ink-3}"
  panel:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    height: "36rem"
    padding: "1.3rem 1.4rem"
  panel-bar:
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    padding: "0.7rem 1.1rem"
  screen:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.none}"
    width: "100%"
  screen-live:
    textColor: "{colors.live}"
  screen-full:
    width: "1104px"
  judge-mark:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 8px"
  judge-score:
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
  blocks:
    backgroundColor: "{colors.ink}"
    height: "12px"
  spray:
    textColor: "{colors.ink}"
    width: "min(100%, 640px)"
    height: "40px"
  tile:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    typography: "{typography.body-small}"
    padding: "0.9rem 0 0"
  fund-line:
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    padding: "0.95rem 0"
  fund-value:
    textColor: "{colors.ink}"
    typography: "{typography.figure}"
---

# Design System: HashRammers

## Overview

**Creative North Star: "The Line-Printer Listing"**

HashRammers's page is a line-printer listing on a black screen: a banner page in giant pixel letters, then one appended line per thing that happened, every line permanent. The world it is printed in is the operator's pinned brand asset (`src/brand/ram-smashing-hash-main.png`): a pixel ram charging a HASH block, binary digits scattering off the impact, monochrome, 1-bit. Everything the page draws is drawn the way that asset is drawn: on a 4px pixel unit, in white on pure black, with corners that step instead of curve. The five reference sites (chordpf.com, nearos.io, trykyoto.ai, dexora.tech, homefi.space) supplied structure only: black ground, an oversized headline, a filled pill beside a ghost pill, a small mark with a centred nav, generous negative space, and one subtle glow. Nothing of their gloss carried over: no soft cards, no blur, no neon.

The page is dense where it reports and empty where it persuades. The banner page gives the headline, the event line, two pills and the plate room to breathe; below it the listing takes over, and from there the page is rules, lines and frames. Three things carry hierarchy: the display face at banner size, the frame (a one-unit white rule with notched corners) around anything that is a screen or a control, and inverse video for the one stamp that matters. Colour does almost nothing. One amber exists, and it means "live right now"; the judge's state is never a colour, it is a white block with black text, the way a terminal highlights the line the cursor is on.

Motion is the print. A changed line prints left to right in fourteen hard steps; the running glyph flips between two pixel frames once a second; the Herder's live dot blinks the same way. Nothing eases, fades or slides, and under reduced motion changes simply appear. The glow the references share is executed as an ordered dither: three concentric rings of single amber pixels behind the plate, masked with hard stops, no smooth gradient anywhere. The board sits on a scatter of 0 and 1 glyphs so faint they read as texture, and every section opens with a "spray": a rule that breaks into scattering digits, the asset's motif turned into the page's divider.

**Key Characteristics:**
- Pure black ground, white 1-bit ink, one amber for the live; nothing else is a colour.
- One 4px pixel unit governs borders, stepped corners, pills, glyphs, block bars, the dot-leader, the dither and the spray.
- Three self-hosted faces with fixed jobs: Jersey 10 displays, Silkscreen labels (caps only), Archivo reads.
- Status is a pixel glyph, a Silkscreen word and a clock; the judge's state is inverse video.
- Frames are notched, pills are stair-stepped, nothing is rounded, nothing casts a shadow.
- One motion, the print: stepped, never eased; the running glyph and the live dot blink in two frames.
- Append-only listing: a changed line prints a new one, history is never rewritten, the first paint is never animated.

## Colors

A 1-bit palette with four greys for distance, one amber for the live signal, and nothing else.

### Primary
- **Phosphor Ink** (`ink`, #ffffff): everything that is drawn or printed in full strength. Headlines, RAM ids, fund values, frames, pills, the spray's rule, the glyphs, the judge's block, the newest history line, the filled slots of a block bar, the focus outline.

### Secondary
- **Live Amber** (`live`, #ffb000): the single accent, reserved for what is live at this moment. The Herder's live dot and its "updated" clock, a live stream's frame, badge and caption rule, and the amber pixels of the dither glow behind the plate. It appears nowhere else: not on a running RAM's glyph, not on hover, not on errors, not on focus.

### Neutral
- **Ground** (`bg`, #000000): the screen. Also the text colour on anything inverse (a filled pill, the judge's block, the OPEN label, the skip link, `::selection`).
- **Ink, second strength** (`ink-2`, #a8a8a8, 8.8:1 on the ground): the reading voice at rest. Nav links, the event line, section leads, activity sentences, the Herder's answers, fund terms, facts terms, an idle screen's HASH block and NO DESK RUNNING badge, history rows that are not the newest.
- **Ink, third strength** (`ink-3`, #7b7b7b, 4.9:1, the floor): tertiary text and the stale state. Clocks, candidate paths, approaches, the score term, placeholders, hints, part numbers, the spray's digits, log marks, the key, an unticked block's outline, a disabled pill, a stale tile's id and status line. Nothing dimmer than this ever carries words.
- **Pressed Ink** (`ink-press`, #d4d4d4): a filled pill under the pointer, and nothing else.
- **Rule** (`rule`, #3a3a3a): the dot-leader on a fund line. Non-text only.
- **Hairline** (`rule-2`, #1c1c1c): the 2px dividers between listing rows (fund lines, herd lines, log entries, facts, history, the slip's index and summary), the top bar's bottom edge, the foot's top edge, and the 0/1 specks behind the board.

### Named Rules
**The Amber Is Live Rule.** Amber means a thing is live right now: the Herder's dot and clock, a live stream's frame, badge and caption rule, the dither behind the plate. A running RAM's status glyph is white like every other glyph; "running" is a state, not a stream. Amber never marks hover, focus, error, emphasis or success.

**The Inverse Video Rule.** The stamp is a white block with black text, set in the label voice: HashSmash's review state ("in review") on the board, in the facts and in the key, and on the entry slip the signing state ("Not live yet"). It is never a colour, never outlined, never iconed. Anything else that goes inverse is a control under the pointer (a ghost pill on hover, the OPEN label) or the skip link.

**The Four Greys Rule.** Text is `ink`, `ink-2` or `ink-3`, and `ink-3` (4.9:1) is the floor; `rule` and `rule-2` draw lines and specks and never carry a word. Distance between lines is made by stepping down a grey, not by adding a tint, a band or a box.

## Typography

**Display Font:** Jersey 10 (self-hosted, `fonts/jersey10.woff2`; with Archivo, Helvetica Neue, Arial fallback)
**Body Font:** Archivo variable (self-hosted, `fonts/archivo-variable.woff2`, weight 100 to 900, width 62% to 125%; with Helvetica Neue, Arial fallback)
**Label Font:** Silkscreen (self-hosted, `fonts/silkscreen.woff2`; same fallback chain)

**Character:** Three faces, three jobs, no overlap. Jersey 10 is the pixel display voice: a condensed bitmap face set tight (line-height 0.95, zero tracking) that reads as a banner page even at 1.25rem. Silkscreen is the label voice: a 3-pixel bitmap caps face set small, tracked and uppercase, the voice of nav links, pills, status words and clocks, column terms and stamps. Archivo is the reading voice, plain and antialiased, with tabular figures on the body so a rewritten number never shifts its neighbours. Jersey 10 and Silkscreen are single-weight (400); Archivo's only weight above 400 in use is 600 on `strong` in the slip's terms.

### Hierarchy
- **Display** (400, `clamp(2.8rem, 6vw, 5rem)`, 0.95, balanced): the h1 on the banner page ("Fees fund RAMs. RAMs ram hashes.") and the slip's h1, at 20ch and 16ch respectively.
- **Banner** (400, `clamp(4rem, 12vw, 9rem)`, 0.85): a RAM's id as the first line of its own page (`.ram-banner`).
- **Wordmark** (400, `clamp(5rem, 22vw, 16rem)`, 0.8): "HashRammers" across the foot (`.foot-mark`), cropped at the bottom, unselectable, decorative.
- **Headline** (400, `clamp(2rem, 4vw, 3rem)`, 0.95): every h2 opening a section; on the slip, each part's h2 at `clamp(2rem, 4vw, 3rem)` with its number in `ink-3`.
- **Title** (400, 1.5rem, 1): h3 inside a part (the notice, the two rules columns, the terms, the preview); also the `>` prompt (`.prompt`) and the counts in the Herder (`.herd-counts .n`), the brand name at 1.75rem (1.5rem below 640px).
- **Figure** (400, 2rem, 1): fund values on the banner page (`.fund-value`); 1.5rem on the slip. The only place a number grows past reading size.
- **Id** (400, 1.75rem, 1): a RAM's id on its tile (`.tile-id`), underlined 3px on hover.
- **Id, small** (400, 1.25rem, 1): a RAM's id in the Herder's lines (`.h-id`) and the slip's index terms (`.slip-index dt`).
- **Lead** (400, `clamp(1rem, 1.3vw, 1.15rem)`, 1.55): the event line under the h1, in `ink-2`, 70ch.
- **Body** (400, 1rem, 1.55, tabular figures): prose at 66ch, controls, the RAM page's now-line; the Herder's summary one step up at the lead size, clamp(1rem, 1.3vw, 1.15rem).
- **Body, small** (400, 0.95rem): activity sentences at 46ch, herd lines, the log, the notice, the rules columns, the foot row, the confirm slip, hints' siblings.
- **Fine** (400, 0.85rem, 1.45): fund sub-lines, round and model lines, the key, the feed and mock notes, a full screen's caption, hints, choice sub-lines.
- **Label** (400, 0.75rem, 1.5, +0.08em, uppercase): the Silkscreen voice. Nav links, pills, status words and clocks, the judge mark and score, fund terms, the panel bar, counts, log marks, field labels and legends, history time and word, facts terms, the crumb, the desk badge, the OPEN label, the slip's index states and summary terms. In the open mobile nav the links step up to 0.85rem.

### Named Rules
**The Caps-Only Rule.** Silkscreen has no lowercase, so it never sets an identifier: model slugs (`anthropic/claude-opus-5.5`), lane paths (`lanes/exploratory/candidates/sha256-r31/`), round ids, addresses and anything a reader might copy are set in Archivo at reading size. Silkscreen labels; it never names.

**The Display Is a Word Rule.** Jersey 10 sets short things: a headline, an id, a figure, a count, a prompt, the wordmark. It never sets a sentence; the moment a line needs to be read rather than seen, it is Archivo.

**The Tabular Figures Rule.** `font-variant-numeric: tabular-nums` is on the body and inherited everywhere, so a fund value, a clock or a score can be reprinted in place without moving the line around it.

## Layout

A single centred column, `max-width: 1440px` (`--max`), with a fluid gutter of `clamp(1rem, 4vw, 3rem)` on both sides and a sticky 4rem top bar (`--nav-h`) that scroll targets clear by one extra rem. The body is a listing: full-width rules between rows, nothing boxed unless it is a screen or a control. The listing reads across before it reads down: above 1000px every row that can be a column of a wider row is one (the banner's copy beside its plate, the three fund lines in one row, the four listing entries in one row, a part's heading beside its lead), and above 1200px a tile lays its screen beside its printed lines and a RAM's page lays its facts beside its screen, so a page is wide and short rather than narrow and long. The site is six pages on that one column, sharing the bar and the foot: the banner page (`index.html`), the Herd (`herd.html`), the Herder (`herder.html`), ideas (`submit.html`), what counts (`rules.html`) and the entry slip (`launch.html`).

**The banner page.** Above 1000px (`.banner.home`): a `1.05fr / 0.95fr` grid, the copy (h1 at 20ch, the event line at 70ch, the two pills) left-aligned on the left and vertically centred against the plate on the right (full column width, the dither glow inset 10% above and below it); under both, the three fund lines as three columns of one row between two 2px `rule-2` rules, each column stacked (term, value, sub-line or block bar) with no leader; then the feed note at 72ch. At 1440 the banner, the fund row and the feed note sit above the fold. At 1000px and below it is the centred stack: h1, event line, pills, the plate at `min(100%, 600px)`, then the fund lines at `min(100%, 760px)`, each a three-column grid (term / dot-leader / value) on a 2px `rule-2` rule with its sub-line or block bar underneath spanning the full width; below 640px the dot-leader is dropped and the value drops under the term, left-aligned.

**The listing (`index.html`).** After the fund lines, `padding-top: clamp(4rem, 8vw, 6.5rem)`, the spray and the head, then one entry per page: the page's name in Jersey 10 at 2rem (a link) over a label-voice tag in `ink-3`, then a 60ch line in `ink-2`; the Herd's entry also carries the herd-counts row. Four entries across one row above 1000px, two columns to 641px, one column of rows below, every row closed by a 2px `rule-2` rule under a `rule-2` rule at the top.

**Sections.** The Herder, the board, ideas and rules each head their own page: they open with the spray (40px tall, `min(100%, 640px)` wide, 1.4rem above the h2) and carry `padding-top: clamp(2.5rem, 5vw, 4rem)` under the bar; the section head has 1.8rem beneath it. Above 1000px the head is a `2fr / 3fr` grid: the spray across both columns, the h2 on the left, the lead (still 70ch) on the right. The board alone is textured with the speck tile (`--speck`, `rule-2` digits on a 96px tile).

**The Herder's panel.** By contract the biggest element on the page: a 4px frame with notched corners, `min-height: 36rem`, a bar across the top (name / live dot + clock / tag), then a 3fr : 2fr body, herd view on the left behind a 4px divider, chat on the right. Below 1000px it stacks (divider moves to the bottom of the herd view); below 640px the minimum height is released and the inner padding tightens to 1rem.

**The board.** Above 1200px, two columns of wide tiles (gap 2.4rem by `clamp(2rem, 3vw, 3rem)`), each tile a `7fr / 8fr` grid with its 16:10 screen on the left and its printed lines beside it, so six RAMs are three short rows; at 1001 to 1200px three columns of stacked tiles, two at 641 to 1000px, one at ≤640px, gap 2.6rem by 2rem (2.2rem in one column), the printed lines 0.9rem below the frame. The key beneath the board wraps freely.

**Ideas.** 1.2fr : 0.8fr, the slip on the left and the notice on the right, gap `clamp(1.6rem, 4vw, 3.5rem)`; single column below 860px. **Rules:** two equal columns, gap 2.5rem; single below 860px.

**The foot.** `margin-top: clamp(4rem, 8vw, 7rem)`, a 2px `rule-2` rule, the foot row (sentence left, links right), then the wordmark overflowing the bottom edge.

**A RAM's page (`herd.html#ram/<id>`).** Opened in place over the board, which stays mounted and keeps ticking: `body.page-open` hides `.top`, `main` and `.foot`. It has its own sticky bar (the Back pill at left, the crumb at right, hidden below 640px), then `padding-top: clamp(2rem, 5vw, 4rem)`: the id at banner size, the now-line, then `.ram-page-main`: above 1200px a `3fr / 2fr` grid with the `.screen-full` (its caption along the bottom) on the left and the facts list (11rem term column) beside it on the right; below that the screen at `max-width: 1104px` with the facts under it at 760px wide (single column below 860px); then the history (6rem / 12rem / 1fr; below 1000px the text drops under the time and word).

**The entry slip (`launch.html`).** The same bar, a left-aligned banner (h1 at 16ch, lead, note, fund lines, the six-part index), then six parts each on a 17rem / 1fr grid (head on the left, body on the right with `padding-top: 2.6rem` and `max-width: 46rem`), `padding-top: clamp(3rem, 6vw, 4.5rem)` per part; single column below 860px.

**Breakpoints.** Wide (min-width): 1001px (the banner goes two-column with the fund row and the listing row across, section heads go two-column) and 1201px (tiles go wide in two columns, the RAM page's facts move beside its screen). Narrow (max-width): 1000px (board to two columns, panel stacks, history reflows), 860px (nav collapses behind the pixel toggle, ideas / rules / slip parts / facts / listing rows go single column), 640px (board to one column, pills and the ask row stack and fill, fund lines lose the leader, panel releases its height, crumb hides, brand name 1.5rem).

## Elevation & Depth

None. There are no shadows anywhere, no blur, no overlay and no lift on hover; the page is a flat screen by decision. The one `box-shadow` in the stylesheets is a pair of inset rings used as a focus indicator on pills and controls (and the invalid state on the slip), never as depth. The one "glow" is the ordered dither behind the plate: three stacked tiles of single 4px amber pixels on 12, 16 and 24px cells (`--dot-12`, `--dot-16`, `--dot-24`), each masked to a concentric circle with hard radial-gradient stops (17 / 27 / 38 percent, half a percent of transition), so density steps down in rings rather than fading. Everything that could suggest a layer is drawn as a frame instead: the panel, a screen, a control, the notice, the terms, the preview, the confirm slip.

### Named Rules
**The Flat Screen Rule.** Nothing casts a shadow and nothing is translucent. If a new element needs to read as "on top", it gets a one-unit frame with notched corners, or it goes inverse video. Depth is a frame or a block, never a shadow.

**The Hard Stop Rule.** The only gradients are masks and leaders with hard stops: the dither's radial masks and the dot-leader's `linear-gradient(90deg, rule 50%, transparent 50%)`. A smooth gradient of any kind is outside the world.

## Shapes

Everything is drawn on the 4px unit (`--u`), and corners step instead of curve. There is no `border-radius` anywhere.

- **The frame:** a one-unit (4px) solid `ink` border, clipped with `--clip-notch`, a two-unit stair at each corner (the corner pixel and the one inside it are cut). Used by the panel, every screen, every control, the nav toggle, the notice, the confirm slip, the terms and the preview.
- **The pill:** `--clip-pill`, a six-unit (24px) stair at each corner on a box twelve units (48px) tall (ten units, 40px, for `.small`). The filled pill is clipped `ink`; the ghost pill draws its outline by laying a `bg` pseudo-element inset one unit and clipped with `--clip-pill-in`, the five-unit stair that fits inside, so the ring is exactly one unit thick and stepped on both edges.
- **The rule:** dividers between listing rows are 2px (half a unit) in `rule-2`; the dot-leader on a fund line is a one-unit-tall dash pattern (4px on, 4px off) in `rule`; the top bar and the foot are edged with the same 2px hairline.
- **The glyph:** every status glyph is an 8 by 8 pixel SVG (`shape-rendering: crispEdges`) rendered at 16px, filled with `currentColor`: running (a burst in two frames), thinking (three dots), idle (an open rectangle), submitted (a tick). The chevron on a select, the toggle's bars and the slip's error mark are drawn the same way.
- **The block:** a block bar (`.blocks`) is a row of flex-equal cells three units (12px) tall with a 2px `ink-3` outline, separated by one unit; a filled block is solid `ink`. The live dot is a two-unit (8px) square of `live`. The slip's choice box is 16px with a one-unit `ink-3` border, filled `ink` when chosen.
- **The spray and the HASH block:** 1-bit SVG symbols (`#spray`, `#hash-block`) drawn in whole pixels; the spray's rule is `ink`, its digits `ink-3`; the HASH block sits in `ink-2` at 30% of its screen (max 150px; 22%, max 240px, on a full screen).
- **Rasters:** `img { image-rendering: pixelated }`, so the plate and the mark scale as pixels, never as smoothed bitmaps.

## Components

### Top
The bar of a terminal: 4rem tall, sticky, black, edged with a 2px `rule-2` hairline. The pixel ram mark (44 by 40px) and "HashRammers" in Jersey 10 at 1.75rem on the left; four centred links to the pages (The Herd / The Herder / Ideas / What counts) in the label voice in `ink-2` (hover: `ink`, 2px underline at 0.35em offset; the current page's link, `aria-current="page"`, in `ink`); X / GitHub / HashSmash and a small ghost pill ("Enter a RAM") at the right. The same markup on every page. Below 860px the links hide behind a pixel toggle, a ten-unit (40px) notched frame whose three bars are SVG paths; when expanded, the outer bars morph into an X by swapping their `d: path()` and the middle bar goes to opacity 0. The open menu drops from the bar as a black sheet with a one-unit `ink` bottom edge, links stacked at 0.85rem, the pill last. A link click closes it. The RAM page's bar is the same bar with the Back pill at left and the crumb (`HashRammers / the herd / ram-03`, current id in `ink`) at right.

### Pills
- **Shape:** the six-unit stair-stepped pill (`--clip-pill`), 48px tall, 24px side padding; `.small` is 40px tall with 20px padding.
- **Filled:** `ink` ground, `bg` text in the label voice. Hover: `ink-press`. Disabled: `ink-3` ground (the slip's disabled Sign pill, `cursor: not-allowed` there). The submit buttons change their word while working ("Handing in…").
- **Ghost:** `ink` text on a one-unit stepped `ink` ring (the inset `bg` pseudo-element). Hover: inverse video, the ring fills and the text goes `bg`.
- **Focus:** no outline; the filled pill shows two inset rings (two units of `ink`, then one unit of `bg`); the ghost pill's inner inset grows to two units so its ring doubles.
- **Where:** "Watch the Herd" filled and "Ask the Herder" ghost on the banner page (they go to `herd.html` and `herder.html`); Ask, Hand in for review, Connect Phantom, Check the entry and Sign in Phantom filled; Enter a RAM and Back to the herd small ghosts. Below 640px the banner pills and the Ask pill stretch full width.

### Banner page
Centred stack: h1 (display), event line (lead, `ink-2`, links in `ink`), the pill pair 1.2rem below, then the plate (`ram-hero.png`, 851 by 616, pixelated) with the dither glow behind it, then the fund lines and the feed note in `ink-3` at 0.85rem. The slip's banner is the same parts left-aligned, with a note under the lead and the six-part index after the fund lines.

### Fund line + Blocks
One printed row of the listing: the term in the label voice in `ink-2`, a one-unit dot-leader in `rule` filling the middle column, the value in Jersey 10 at 2rem in `ink` on the right (its "of $400.00" denominator in `ink-3`). Under the row, full width: a sub-line in `ink-3` at 0.85rem, or a block bar. The compute bar is always 24 blocks with the spent share filled from the left; the slots bar is one block per slot, the funded ones filled. Rows are divided by 2px `rule-2` rules, the last closed below. The first paint is static; a later change to a value prints.

### Spray
The section divider: an SVG symbol 480 by 32 at 40px tall and up to 640px wide, left-aligned. A 150-unit-long `ink` rule at four units thick breaks into a field of 0 and 1 digits in `ink-3` that scatter up and right, thinning toward the end. It opens every section on the page and every part of the slip (`.spray-sm`, 1rem beneath). It is never centred and never used as decoration inside a component.

### Panel (the Herder)
The biggest screen on the page. A one-unit notched frame, `min-height: 36rem`. The bar: "THE HERDER" in `ink`, then the live dot (an 8px `live` square, blinking) and "updated 42s ago" in `live`, then "read-only · Q&A" at the far right, all in the label voice on a one-unit bottom rule. The herd view (left, 3fr): a label-voice heading in `ink-2`, the summary sentence at the lead size, the counts (glyph, count in Jersey 10 at 1.5rem, word) in a wrapping row, then one line per RAM on 2px `rule-2` rules: id in Jersey 10 at 1.25rem (a link to its page on the Herd page), the status glyph and word, the activity in `ink-2`, wrapping to a second line when it must (nothing is truncated). The chat (right, 2fr): a label heading, the log as a terminal (oldest first, scrolling inside 28rem, thin `ink`-on-`bg` scrollbar), each entry a 1.4rem mark column (`>` for the question, `H` for the Herder, in `ink-3`) beside the question in `ink` and the answer in `ink-2`; a pending answer reads "Writing…" in `ink-3` and prints when it arrives. The ask row at the bottom: a `>` prompt in Jersey 10 at 1.5rem, the control, the Ask pill; the control and pill disable while a question is out.

### Control
Text input, textarea and select share `.ctl`: black ground, one-unit `ink` frame with notched corners, 0.6rem by 0.9rem padding, reading size, 48px minimum height, `ink` caret. Placeholder in `ink-3` at full opacity. Focus: no outline; two inset rings (one unit of `bg`, then one of `ink`), so the frame reads as doubled. Disabled: `ink-3` text and frame. A textarea resizes vertically from 9rem at line-height 1.5. A select hides the native arrow and draws a pixel chevron (an 8 by 8 SVG at 16px) at the right; its options are black with `ink` text. On the slip, `aria-invalid="true"` draws the same rings as focus, and the error line beneath is `ink` text led by a pixel exclamation mark; the symbol field uppercases as you type. Field labels and legends are the label voice in `ink-2`, "(optional)" in `ink-3`.

### Screen
A 16:10 frame (one unit of `ink`, notched, black, overflow hidden) with four states, each with a badge in the top-left corner (label voice, three units in from the edge, on a `bg` slab):
- **Checking:** the HASH block in `ink-2` at 30% (max 150px) and the badge "checking".
- **Idle:** the HASH block stays, the badge reads "NO DESK RUNNING" in `ink-2`. This is the resting state of every screen, not an error: the RAM works on the host.
- **Live:** the frame goes `live`, the badge reads "LIVE · VIEW ONLY" in `live`, the HASH block hides and the sandboxed, lazy, no-referrer iframe fills the frame with `pointer-events: none` and `tabindex="-1"`. The iframe is only replaced when the stream URL itself changes; a poll never reloads it.
- **Unreachable:** the HASH block and the badge "feed unreachable".
A caption line describing the state is screen-reader-only on a tile. On `.screen-full` (max 1104px, the RAM page) it is printed along the bottom edge on a one-unit rule in `ink-2` at 0.85rem (`ink` text and a `live` rule when live), and the HASH block rises above it (22%, max 240px). On a tile, an invisible `.screen-link` covers the whole frame; on hover or focus an "OPEN" label in inverse video appears at the bottom-right corner, and focus draws a 2px `ink` outline 8px inside the frame.

### Tile
A screen, then printed lines with no box (beside the screen above 1200px, under it otherwise): the RAM id in Jersey 10 at 1.75rem (a link, 3px underline on hover) beside the now-line (glyph, status word, "written 32s ago" clock in `ink-3`), the round id in `ink` with the lane path in `ink-3` (breaking only after slashes), the model slug in `ink-2` with the approach in `ink-3`, the activity sentence in `ink-2` at 0.95rem and 46ch, and the judge line. Tiles are diffed by id: a feed tick writes only the text that changed, and a changed status, activity or fresher clock prints that line. The first paint is never animated.

### Judge mark and score
The stamp: "IN REVIEW" as a white block with black text in the label voice, two units of side padding, no outline. Beside it the score term "LOG₂(T)" in `ink-3` and its value in `ink` (an em dash, `aria`-described, until HashSmash scores it). A RAM with nothing handed in shows an em dash in `ink-3` in place of the stamp. "accepted" never comes from this page.

### Stale rule
A RAM nobody has heard from for 300 seconds dims: its id, status line, round id and activity go `ink-3`, on the tile and in the Herder's line. A submitted RAM never dims however long the review takes; it is waiting on the judge, not silent.

### Key
Under the board in the reading voice at 0.85rem in `ink-3`: each glyph (in `ink`) with its word, the judge mark and the score term as they appear on a tile, and a 20 by 13px `ink` rectangle for "no desk running".

### Slip + Notice
The idea form: label-voice field labels, three controls, a filled pill, and a confirm line that appears after a hand-in (a one-unit notched frame, the tick glyph, "Received." in bold then the queue position) in `ink`. Beside it the notice: a one-unit notched frame with `clamp(1.1rem, 2.5vw, 1.6rem)` padding, an h3 and two paragraphs in `ink-2` at 0.95rem.

### Rules
Two columns of an h3 over a paragraph in `ink-2` at 0.95rem; the mock note beneath on a 2px `rule-2` rule in `ink-3` at 0.85rem.

### Foot + wordmark
A 2px `rule-2` rule, the foot row (sentence in `ink-2` with `ink` links, link list right), then "HashRammers" in Jersey 10 at `clamp(5rem, 22vw, 16rem)` with its baseline pulled 0.08em below the edge and the overflow clipped.

### RAM page
Its bar (Back pill, crumb), the id at banner size (`clamp(4rem, 12vw, 9rem)`, focused on open), the now-line at 1rem, the full screen, the facts (term in the label voice in `ink-2` over an 11rem column, value in `ink`; model and candidate path break after slashes; the review row carries the stamp; the score row reads "not scored yet"), then "History": one row per line the RAM has written, newest first, time in the label voice in `ink-3`, glyph and word in `ink-2`, text at 70ch in `ink-2`; the newest row is in full `ink`. A line is never rewritten; a change prints a new one. Escape or the Back pill returns to the board at the scroll position and focus the visitor left.

### Launch-only components
- **Slip index:** six terms in Jersey 10 at 1.25rem (links) with a label-voice state under each ("NOT CONNECTED", "NOT CHOSEN", "SWITCHED OFF") in `ink-3`, `ink` once done; auto-fit columns of 10rem on 2px rules, two columns below 640px.
- **Part:** number in `ink-3` beside the h2, the lead at 0.95rem, the body on the right.
- **Choice row:** a radio drawn as a printed line on a 2px rule: a 16px box with a one-unit `ink-3` border (hover: `ink`; checked: filled `ink`; focus: 2px `ink` outline at 3px), the main text in `ink`, a sub-line in `ink-3` at 0.85rem; two columns for the model list.
- **Summary:** label-voice terms over a 9rem column, values in `ink`, "not chosen" in `ink-3`.
- **Terms:** a one-unit notched frame, an h3, a bulleted list in `ink-2` with `ink` bold leads and `ink-3` markers.
- **Preview:** a one-unit notched frame with a source line in `ink-3`, a facts grid and an instruction list on 2px rules.
- **Sign line:** the Sign pill, disabled in `ink-3`, beside the "NOT LIVE YET" stamp; the reason beneath in `ink-2`.
- **Text button:** "Disconnect" as an underlined word in `ink` (2px underline in `ink-3`, `ink` on hover).

### Motion: the print
The one authored motion. A new or changed line gets `.printing`: `clip-path` insets from the right edge to zero over 0.5s in `steps(14, end)`, so the line appears character-block by character-block, and the class is removed on `animationend`. The running glyph has two frames (`.f1`, `.f2`) swapped by `frame-a` / `frame-b` at 1s in `steps(1, end)`; the Herder's live dot blinks on `frame-a`. All three keyframe sets are declared inside `@media (prefers-reduced-motion: no-preference)` and the script skips `.printing` under `reduce`, so changes simply appear. Nothing eases, fades, slides or scales; the only spatial change on the site is tile to RAM page, and that is a cut.

### Browser surfaces
`color-scheme: dark`; `::selection` is `ink` on `bg` inverted; `caret-color: ink`; `scrollbar-color: ink bg` (thin in the log); `:focus-visible` is a 2px `ink` outline at 3px offset except where a component draws its own rings; links underline at 2px, 0.2em offset, in `ink-3` (`currentColor` on hover); tabular figures everywhere; select options black with `ink` text; the skip link is inverse video in the label voice.

## Do's and Don'ts

### Do:
- **Do** keep amber (`live`, #ffb000) for what is live right now: the Herder's dot and clock, a live stream's frame, badge and caption rule, the dither behind the plate.
- **Do** set the judge's state, and the slip's signing state, as inverse video: a `ink` block with `bg` text in the label voice, two units of side padding.
- **Do** draw every edge on the unit: one-unit (4px) `ink` frames with the two-unit notch on screens, controls and the panel; 2px `rule-2` hairlines between listing rows; the six-unit stair on pills.
- **Do** set identifiers (model slugs, lane paths, round ids, addresses) in Archivo at reading size; Silkscreen is caps-only and only ever labels.
- **Do** write status as a 16px pixel glyph, a Silkscreen word and a "written … ago" clock, and dim a RAM to `ink-3` after 300 seconds of silence unless it is submitted.
- **Do** print a changed line (`clip-path` inset, 0.5s, `steps(14, end)`), diff tiles by id, leave the first paint static, and let changes simply appear under reduced motion.
- **Do** show the intact HASH block in `ink-2` with "NO DESK RUNNING" as every screen's resting state.
- **Do** keep `ink-3` (4.9:1) as the dimmest colour that carries a word; `rule` and `rule-2` draw lines and specks only.
- **Do** open every section with the spray, left-aligned, and texture only the board with the speck tile.

### Don't:
- **Don't** colour a running RAM's glyph amber, or use amber for hover, focus, errors, emphasis or success; "running" is a state, "live" is a stream.
- **Don't** give the judge's state a colour, an outline, an icon or a dismiss; it is a white block, nothing else.
- **Don't** round anything: no `border-radius`, no circles, no circle avatars; corners are stepped stairs on the 4px unit.
- **Don't** add a shadow, a blur, a translucent layer or a lift on hover; the only `box-shadow` is the inset focus ring.
- **Don't** use a smooth gradient; the dither's radial masks and the dot-leader are hard-stop only.
- **Don't** fade, slide, ease or re-sort anything on a feed tick; a change prints a new line and history is never rewritten.
- **Don't** set a sentence in Jersey 10 or an identifier in Silkscreen; Archivo reads, the other two display and label.
- **Don't** treat the HASH block as an error, an empty state illustration or a placeholder to be replaced; it is the screen when no desk is running.
- **Don't** add a second accent, a success green, an error red, cards, tinted bands or a second surface colour; the world is black, three greys, white and one amber.
- **Don't** replace the drawn glyphs, the spray, the HASH block or the dither with icon fonts, icon libraries, raster textures or anything antialiased.
