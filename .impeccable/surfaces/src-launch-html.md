---
version: 1
slug: "src-launch-html"
primary_target: "src/launch.html"
related_targets: ["src/launch.js","src/styles.css"]
---

# Surface brief: src/launch.html (Create a RAM: the entry form)

Scope: one page, a form a visitor fills to fund and launch their own RAM. Visitor mode:
**Operate** (complete a task: connect a wallet, choose one hash family, describe an approach,
name a token, review, sign). Not live: the signing step is shown but disabled.

Audience and job: memecoin-side visitors with a Phantom wallet; some know cryptanalysis words.
Task: fill the slip in order, read honest terms (0.2 SOL to treasury, 100% of creator fees
locked to the treasury, prizes recorded and paid by hand, no promise of results), sign once.
Constraints: one hash family per RAM (radio, never checkboxes); no key ever leaves the wallet;
mock responses labeled as mock; red stays the judge's stamp ("Not live yet" is a stamp).

Decision round: direction pinned by the lead agent's brief (extend the tournament wallchart as
its entry form); run unattended as a subagent with no question tool, so concept-seed was not
run and no surface tournament was held. The world is inherited, not re-rolled.

## Direction contract

THESIS: the tournament's entry form, pinned on the same felt as the wallchart: one paper sheet,
numbered printed parts down the left like an entry slip, the visitor's answers written in pen.
It refuses the crypto launchpad wizard (dark modal, stepper dots, gradient CTA).

OWN-WORLD: inherited unchanged from DESIGN.md: felt ground and strip, one paper sheet, three
inks, ruled controls, double rules opening each part, Archivo widths, pen button, red only for
the judge stamp, which here stamps "Not live yet" on the signing line.

STORY: the visitor connects Phantom, picks one family and a round, says what their RAM should
try and which model runs it, names the token, reads the terms set in a ruled box, and sees the
signing line stamped not live with the reason.

FIRST VIEWPORT (desktop 1440): strip with name and "Back to the board"; ruled header box with
the title "Enter a RAM" and the fee in the fund column; part 1 (wallet) starts in view.
Mobile 390: header stacks, parts stack, controls full width.

FORM: the entry slip, sections numbered because order carries information (signing needs the
earlier parts). Seed key: none (pinned direction).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review,
the verdict, DESIGN.md, and every shipping raster carrying its provenance.
