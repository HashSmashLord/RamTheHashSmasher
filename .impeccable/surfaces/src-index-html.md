---
version: 1
slug: "src-index-html"
primary_target: "src/index.html"
related_targets: ["src/styles.css","src/app.js"]
---

# Surface brief: src/index.html (the public RAMherd page)

Scope: the single public page. Visitor mode: **Persuade** (a first-time visitor must know
what this is, why it is real, and what to do within seconds); the board, the coordinator log
and the idea slip inside it are operate-register parts of that one surface.

Audience and job: people arriving from the memecoin side asking "is this real?"; a smaller
group of cryptanalysis-curious viewers who will ask a question or hand in an idea.
Action: ask the coordinator a question (working input in the first viewport); hand in an
idea on the slip. Proof: the live board itself — fees collected, compute this epoch, RAMs
funded, and one written row per RAM with its real HashSmash track and what it is doing now.
Constraints: every figure is a mock feed until the backend is wired and the page says so;
no token, price, holders or chart may be invented; the coordinator is Q&A only; no idea
reaches a RAM before a human approves it; nothing claims a hash is broken.

Unresolved: final product name; whether an approved idea attaches to a RAM or spins one up.
Decision round: run unattended (background job, no question tool, nobody to open the
decision page); the assigned direction was built as dealt, no re-roll, telemetry ping not
sent because the round was not attended.

## Direction contract

THESIS: RAMherd's page is the tournament wallchart pinned in the hall between rounds: one
ruled results sheet, entrants down the side, HashSmash's rounds across, the fund printed in
its header, written in live by whoever keeps the chart. It refuses the dark status-card
dashboard with neon chips and the centred-headline-over-cards landing page alike.

OWN-WORLD: A bottle-green noticeboard felt owns the page ground, header strip and footer;
one tall off-white paper sheet pinned on it owns everything else, with an offset soft shadow.
Three inks on the paper: printed black for what the organiser set (rulings headings, column
heads, regulations), blue-black ballpoint for what is written live (fund figures, each RAM's
row, the Q&A log), and one red reserved for HashSmash's own judge states (in review,
accepted, rejected) and the ruled judge margin, used nowhere else. Feint blue rulings carry
the grid. One grotesk family with a real width axis (Archivo variable, self-hosted) set
condensed for column heads, wide and heavy for the sheet title, normal for prose; tabular
figures everywhere a number sits. Status is written, not chipped: a word plus a drawn
clock glyph for a running entrant; stale rows thin their ink. Controls are set into the
sheet as ruled boxes with a pen-ink caret and a pen-ink focus rule; red never marks focus. Light scene: a hall under
fluorescent tubes.

STORY: The visitor reads the fund lines, sees nine entrants each on a named HashSmash
round doing a specific thing, understands that fees buy entrants and entrants buy attempts,
reads that nothing counts until HashSmash's judge says so, asks the coordinator something,
and hands in an idea knowing a person reads it first.

FIRST VIEWPORT (desktop 1440): felt strip with name and four links. The sheet starts at
once: a ruled header box across the full sheet width — sheet title "RAMherd" wide and heavy
on the left with the event line beneath it, and on the right three ruled fund rows (fees
collected, compute this epoch with a drawn pen-rule meter, entrants funded 9 of 12) plus the
entries-by-round strip. Directly below, still on the same sheet, two columns divided by a
rule: the results table (left, two thirds) with column heads Entrant / Round / Now / Judge
and its first rows visible, and the coordinator log (right, one third) opening with the
working "Ask" input, the primary action, live in the first viewport, newest Q&A written at
the top beneath it. Mobile 390: the header box stacks, the table rows become ruled blocks,
the log and its input follow.

FORM: the tournament wallchart, candidate 6 of 7 on my ordered list, assigned by the roll;
seed key 4c815091 (scope direction, mode persuade). Raises taken from the declined hand,
by donor: committed stock colour as the ground (soundsystem poster); fixed cell geometry
across every state so states compare at a glance (botanical folio); every live change is a
discrete write, never a fade or a re-render, and stale ink thins (depot blind); one fixed legend
that never moves (gravity-rain garden); one stamp colour reserved for the external judge
(akari). Competitive alternate: particle-detector event display (holds identification,
loses clarity). Signature interaction: "the pen writes" — a changed cell re-inks
left-to-right with an exponential ease-out from a visible default; nothing else animates,
and the table is diffed by key so an update never re-renders the sheet.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review,
the verdict, DESIGN.md, and every shipping raster carrying its provenance.
