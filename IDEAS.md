# Reckon — Engagement & Mastery-Grid Ideas

> Captured 2026-06-02. **Problem to solve:** the daily 5-session goal and the
> gauntlet get "completed" quickly, and after that there's no pull to keep
> playing. We want open-ended, intrinsic reasons to open the app and run
> sessions — and the mastery grid is the obvious substrate.
>
> This doc is a backlog. Each idea has *what it is*, *why it matters*, and
> *build notes* (what existing code it reuses). The code map at the bottom has
> verified file/line anchors so any of these is fast to start.

---

## The core idea (the "why" behind all of this)

The current loop is a **maintenance loop** — by design it has an ending. Five
sessions, gauntlet cleared, done for the day. Nothing wrong with it, it's just
*finite*.

What's missing is a **campaign loop** (no finish line, about *getting better*
rather than *showing up*) and **novelty** (new ways to play).

The mastery grid already is a campaign waiting to happen: ~312 reachable fact
cells across the four ops, most still grey — not because they're hard, but
because sessions generate *random* problems in a range, so the grid fills in by
accident. Today the grid is a **read-out**. The highest-leverage move is to make
it the **engine** you play from.

> Note on the denominator: `masteryGrid` folds each grid commutatively (it swaps
> so `a <= b`, see `app-logic.js:255`), so only the upper triangle is reachable
> — ~78 cells per op at `maxN=12` (12+11+…+1), ~312 total, **not** 4×144=576.
> Any "green the grid" count should be computed from reachable cells, not
> hardcoded.

---

## Direction 1 — Make it *stay* green (decay)  *(✓ SHIPPED 2026-06-02)*

> Built as a **freshness overlay**, not a change to `cellLevel`: pure
> `cellFreshness` + `masteryView` in `app-logic.js` (unit-tested) compute a
> per-cell `decay` (0→1) and a `displayLevel`. Only Strong cells fade; fresh ≤7d,
> wilting to "needs tending" by 21d. The grid blends green→amber with CSS
> `color-mix(var(--decay))`. Wilted cells leave the Strong % (return pressure)
> but re-green on one good practice. Also shipped the tap-to-inspect popover.

Right now `cellLevel()` ignores recency: green once, green forever, nothing to
return for. Add gentle **decay** — a fact untouched for a while fades from green
toward amber. The grid becomes a **garden you tend** instead of a trophy you
earned. This is the real structural answer to "the loop ends": it gives the
streak's *return pressure*, but spatial and skill-based. Pairs perfectly with
the Frontier drill (faded cells *are* the frontier).

- **Build:** the `problems` records carry `timestamp`, so per-cell recency is
  derivable without new storage. Decision needed on the decay curve and whether
  decay lowers `level` directly or is a separate "freshness" overlay. Touches
  the core grading path (`cellLevel` / `masteryGrid`, `app-logic.js:235`/`246`)
  — keep it pure and add tests.
- **Open question:** does a faded cell *lose* campaign credit (1c count drops)
  or just visually dim? Losing credit is more motivating but more punishing.

---

## Direction 2 — New ways to play (novelty)

`genProblem(config, rng)` (`app-logic.js:67`) is a clean pure generator, so new
modes are mostly new controllers around the existing session loop
(`beginGame`/`endGame`, `index.html:1186`/`1343`). All single-player (the app is
a local PWA — IndexedDB only, no backend; "compete" = against your own past).

- **Survival / sudden death** *(Low–Medium)* — no timer; one wrong (or too-slow)
  answer ends the run. Score = streak length. Totally different nerves than the
  count-up timed mode.
- **Nemesis** *(Low–Medium)* — surface your single worst fact ("Your nemesis:
  7×8") and make beating it a ritual: nail it fast N times in a row to "retire"
  it. Reuses `computeWeakFacts()` (`app-logic.js:296`). Personal and sticky.
- **Ladder** *(Low–Medium)* — ranges widen as you survive; "how high can you
  climb?" before it outpaces you.
- **Zen endless** *(Low)* — untimed, calm, no score, just a quiet stream. Fits
  the Zen palette; for days you don't want a race.
- **Daily Seeded 20** *(Low)* — same 20 problems on a given date (reuse the
  gauntlet's date-seeded RNG, `buildGauntlet` `app-logic.js:356`) so you can
  chase your *own* time on an identical set, day over day.

---

## Direction 3 — Give XP a destination  *(✓ SHIPPED 2026-06-02)*

> Shipped as **Ranks + a Trophy Case** (folded together with the open "trophies/
> shapes/wall" TODO — same wish). Lifetime XP now climbs a 9-rung named ladder
> (`RANKS`/`rankForXp`, unit-tested); the home XP line became a tappable **rank
> row** (polygon insignia that gains a side per rank, progress bar, trophy tally).
> The **Trophy Case** sheet is the wall: rank hero + ladder + a grouped grid of
> 28 collectible SVG **emblems** (`TROPHY_DEFS`/`evaluateTrophies`/
> `reconcileTrophies`, monotonic & persisted on `progress.trophies`). Emblems
> span ranks, streaks, gauntlet medals, volume, speed **records** (← the records-
> wall idea, as chase-able tiles), and mastery, plus **secret** ones hidden as
> "???" until earned (the surprise). Reveal = a NEW badge + a home-row dot + a
> rank-up confetti. Perf: a cheap reconcile (sessions + progress, no scan) runs on
> the home screen; the mastery/fastest-answer full scan only runs when the Mastery
> sheet or the Case opens. **Not** done: ranks unlocking new *palettes* — designing
> a whole palette's colours is a "render-options-and-let-me-pick" call, left as a
> follow-up; the reward today is ranks + the emblem collection.

`xpLifetime` was vanity with nothing attached; XP only bought freezes
(`FREEZE_COST=1000`, `awardXp`/`buyFreeze` `app-logic.js:183`/`192`).

- **Belts / ranks** *(Low)* — map `xpLifetime` to named tiers (white → black
  belt suits the Zen palette). Pure, testable. Let ranks **unlock palettes** —
  theming is already `data-palette × data-theme` with tokenized colors, so new
  palettes are the natural reward (current palettes: Instrument, Zen).
- **Records wall** *(Low–Medium)* — most problems in a session, fastest single
  answer, longest survival streak, biggest gauntlet streak. Personal records are
  intrinsically chase-able; most of the data is already in `sessions`/
  `problems`.

---

## Appendix — code map (verified 2026-06-02)

**Data model** — IndexedDB `reckon` (`openDB` ~`index.html:973`): stores
`sessions`, `problems` (indices `sessionId`, `operation`, `timestamp`), `meta`.
Problem record: `{id, sessionId, timestamp, operation, operand1, operand2,
correctAnswer, userAnswer, wasCorrect, msToAnswer}`.

**Mastery logic** (`app-logic.js`, pure/exported via the `Z` object):
- `gridFactors(p)` `:220` — TIMES/PLUS → `[o1,o2]`; DIV → `[o2, answer]`;
  MINUS → `[o2, answer]`.
- `masteryBaseline(problems)` `:230` — median of all correct `msToAnswer`
  (the speed yardstick).
- `cellLevel(cell, baseline)` `:235` — 0 unseen · 1 weak (<0.7 acc, or >2×
  baseline) · 3 strong (≥0.9 acc and ≤1.3× baseline) · 2 otherwise.
- `masteryGrid(problems, op, maxN=12, baseline)` `:246` — folds `a<=b` (`:255`),
  returns `{op, maxN, baseline, cells}` where each cell is
  `{count, correct, totalMs, avgMs, accuracy, level}` or null.

**Grid render** (`index.html`): `renderGrid(g)` `:2096` (emits per-cell `<td>`,
classes `LEVEL_CLASS=['m0','m1','m2','m3']` `:2095`, native `title` tooltip);
`masteryTally(g)` `:2115`; `renderMastery()` `:2123`; ops list
`MASTERY_OPS` `:2094`.

**Gauntlet / weak facts** (`app-logic.js`): `computeWeakFacts(problems, topN)`
`:296` (miss-rate + slowness, skips n<2); `buildGauntlet(problems, nowMs, rng,
opts)` `:356`; `canonFact` `:45` / `factKey` `:50`; clear tracking
`recordGauntletClear` `:392`. Daily build + shuffle: `renderHome` `:1678`,
`beginGauntlet` `:1252`.

**Problem gen / session loop**: `genProblem(c, rng)` `app-logic.js:67`;
`fillQueue`/`nextFromQueue` `index.html:1137`/`1138`; `beginGame(cfg,ghost)`
`:1186`; `endGame()` `:1343`; `showScreen(name)` `:1141`.

**Progression / XP** (`app-logic.js`): `currentStreak` `:107`; `awardXp` `:183`;
`buyFreeze` `:192`; `opStats` `:275`. XP = 1/problem; gauntlet = `GAUNTLET_REWARD`
50 on first clear/day.

**Constants** (`app-logic.js`): `DAILY_GOAL=5` `:23`, `FREEZE_COST=1000` `:24`,
`MAX_FREEZES=2` `:25`, `GAUNTLET_SIZE=10` `:26`, `GAUNTLET_REWARD=50` `:27`,
`GAUNTLET_WINDOW_DAYS=21` `:28`.

**Tests**: `npm test` → `node --test`; pure logic lives in `app-logic.js` and is
covered in `tests/logic.test.js`. New logic (frontier ranking, decay, belts)
goes here with tests.

**Theming**: `data-palette × data-theme`, all colors are tokens; palettes
Instrument + Zen. Palette-as-unlock fits this cleanly.

**Deploy gotcha**: new runtime files must be added to `deploy.yml`'s `cp`
allowlist or they 404 in prod. (This app is largely single-file `index.html`, so
usually N/A — but relevant if a mode gets split out.)

---

## Open design questions

- ~~Does decay subtract from the "green the grid" count, or only dim?~~
  **Answered (Dir 1):** *aging* cells dim but still count; once fully *stale* they
  drop from the Strong count — credit lost but instantly reclaimable.
- ~~Does the gauntlet's 21-day weak-fact window and the grid's all-time view need
  to agree?~~ **Answered:** the grid stays all-time for *quality*; decay's stale
  horizon is set to 21 days so the two systems rhyme (a fact that drops out of the
  gauntlet window is also fully wilted on the grid).
- Where do new modes live in the UI — extra presets in Settings, or a new "Play"
  hub alongside Stats / Mastery / Settings?
