---
version: 1
slug: "src-index-html"
primary_target: "src/index.html"
related_targets: ["src/styles.css","src/app.js","src/sandbox-viewer.js","src/mock-data.js"]
---

# Surface brief: src/index.html (the public HashRammers page)

Scope: the single public page, plus the RAM full-page view it opens as an in-page route
(`#ram/<id>`). Visitor mode: **Persuade** (a first-time visitor must know what this is, why it
is real, and what to do within seconds); the board, the Herder panel and the idea slip inside
it are operate-register parts of that one surface.

Audience and job: people arriving from the memecoin side asking "is this real?"; a smaller
group of cryptanalysis-curious viewers who will ask the Herder a question or hand in an idea.
Action: ask the Herder (working input in the first scroll); hand in an idea. Proof: the live
board: fees collected, compute this epoch, RAMs funded, one tile per RAM with its real
HashSmash track, what it is doing now, and its screen (a view-only desk stream when one runs).
Constraints: every figure is a mock feed until the backend is wired and the page says so; no
token, price, holders or chart may be invented; the Herder is Q&A only; no idea reaches a RAM
before a human approves it; nothing claims a hash is broken; the desk stream is only ever the
server's `viewOnly: "server"` E2B noVNC page, never anything looser.

Pinned by the operator (2026-10-05, directly): the whole site reads as pixel-art, monochrome
black/white with at most one accent, in the exact style of the supplied brand asset
(`src/brand/ram-smashing-hash-main.png`: a pixel ram charging a HASH block, binary digits
scattering off it); the scattering-digits motif recurs throughout. Five reference sites
(chordpf.com, nearos.io, trykyoto.ai, dexora.tech, homefi.space) supply structure only: black
ground, oversized bold headline type, generous negative space, pill buttons (one filled, one
ghost), a small mark plus a minimal centred nav, a subtle accent glow. Three new requirements:
a live screen-preview thumbnail on every RAM tile with a calm "no desk running" idle state; a
full-page view per RAM (preview larger plus its full status history); a Herder panel on the
main page visibly bigger than any RAM tile.

Unresolved: final product name; whether an approved idea attaches to a RAM or spins one up.
Decision round: run unattended (background job, no structured question tool, nobody to open
the decision page); the roll was acknowledged and the assigned direction built as dealt with
the pinned materials winning field by field; telemetry ping not sent because the round was
not attended.

## Direction contract

THESIS: HashRammers's page is a line-printer listing on a black screen: a banner page in giant
pixel letters, then one appended line per thing that happened, every line permanent. It
refuses the glossy dark-SaaS template (centred headline over a row of soft cards with a neon
glow) and the paper wallchart it replaces alike. Pixel-art monochrome is pinned; the listing
is what the pixels are organised into.

OWN-WORLD: Pure black ground (#000, the asset's own black, so the plate sits on it with no
seam). White 1-bit pixel ink for everything drawn: a 4px pixel unit governs borders, stepped
corners, glyphs, the dither and the spray. One accent, amber, reserved for what is live right
now (a live stream's frame and badge, the Herder's live dot and clock) and nothing else;
the judge's state is inverse video (white block, black text), never a colour. The glow the
references share is executed as an ordered dither: three concentric density rings of amber
pixels behind the hero burst, no smooth gradient anywhere. Three faces with fixed jobs: Jersey
10 (self-hosted) is the display voice (the banner headline, section heads, RAM ids, fund
figures), Silkscreen (self-hosted) is the label voice (nav, pills, column heads, status words,
stamps, uppercase, tracked), Archivo (already self-hosted) is the reading voice (prose,
activity sentences, the log). Pills are pixel pills: stair-stepped 24px corners cut with
clip-path polygons on the unit, one filled white, one ghost outline; ghost hover is inverse video. Frames
are 1-unit white rules with stepped 2-unit corners. Status is a pixel glyph plus a Silkscreen
word plus a clock. Section openings are a "spray": a rule that bursts into scattering 0/1
digits, the asset's motif as the page's divider. A RAM's screen with no desk shows the intact
HASH block in pixels and the words NO DESK RUNNING; when a stream arrives the block gives way
to the live frame and digits fly.

STORY: The visitor reads the banner (fees fund RAMs, RAMs ram hashes), sees the ram hit the
block, reads three printed fund lines and a block bar of funded slots, meets the Herder's
panel (what the whole herd is doing, and a prompt to ask it), scrolls to six screens each
named for a real HashSmash track, opens one to its full page and history, reads that nothing
counts until HashSmash's judge says so, and hands in an idea knowing a person reads it first.

FIRST VIEWPORT (desktop 1440): a thin black nav: pixel ram mark and HashRammers at left, four
centred links, X / GitHub / HashSmash and a ghost pill "Enter a RAM" at right. Below, centred:
the headline in Jersey 10 at 5rem on two lines, the event line beneath at reading size,
two pixel pills ("Watch the board" filled, "Ask the Herder" ghost), and the brand plate (ram,
HASH block, digit spray) 600px wide with the dithered amber glow behind the burst (built smaller
than first written so the plate's bottom edge and the first fund line meet the 900px fold). The
plate's bottom edge and the first printed fund lines sit at the fold. Mobile 390: the nav
collapses behind a pixel toggle; headline at about 2.8rem; pills stack; the plate fills the
width; fund lines follow.

FORM: the dot-matrix tournament printout, candidate 7 of 7 on my ordered list, assigned by
the roll; seed key cbda8d1b (scope direction, mode persuade); its materials translated into
the pinned pixel-monochrome world, its topology kept (banner then listing; append-only lines;
dot-leader label/value lines; every RAM page opens with its own banner). Raises taken from the
dealt hand, by donor: a fixed grid where every unit means something, one 4px pixel unit for
all geometry (oscilloscope, competitive); append-only permanence, a change prints a new line
and never rewrites history (ebru, declined); every pixel load-bearing, no decorative pixel
art (Tanaka, declined); the budget meter is a block bar in RAM-slot units, a bold graphic
argument not a thin progress line (Du Bois, declined); one named transformation, tile to full
page, and no other spatial motion (drawcord cape, declined); the single accent marks only
what is live (neon circuit, declined). Signature interaction: "the print": a new or changed
line appears left to right in character steps (`steps()`, never eased), the running glyph
blinks between two pixel frames, nothing fades or slides; under reduced motion changes simply
appear. Tiles are diffed by id so a feed tick never re-renders the board.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review,
the verdict, DESIGN.md, and every shipping raster carrying its provenance.
