
- [x] Have more visual feedback for the ghost.  It's hard to see the numbers
  scrolling by but I think it would be nice to see like a progress bar or some
  other visual indicator of how I'm doing against the ghost.  This is the same
  for the timer as well.  It would be nice to have some visual indicator without
  looking at the numbers which is distracting when i'm trying to solve mental
  math problems.
  → DONE: timer is now a depleting ring (green→amber→red, pulses when critical),
    ghost is a centre-out tug-of-war meter (green-right = ahead, amber-left =
    behind). The distracting per-problem numbers are dropped; only the seconds
    remain, inside the ring. Gauntlet ring fills with fact progress. Pure
    scale/threshold logic (ghostMeter, timeRingState) lives in app-logic.js + is
    unit-tested.

- [x] I want to make the mastery grid more interactive.  At the very least, I'd
  like to be able to tap a square, see what problem it represents, and see my
  data for that square (number of errors, completions, %, times, etc).   

  I would also like to develop the grid down the path we have in the
  IDEAS.md file (Direction #1).  The most attractive to me is the "garden that needs tending."
  I like the idea of seeing things turn yellow over time and having to keep them
  up.  I'm a little unclear on implementation for this but it seems like an
  awesome way to have ongoing engagement. 
  → DONE (both halves):
    • Tap any cell → a popover with the fact it stands for (e.g. 4 × 6 = 24, and
      both forms for ÷/−), a Strong/OK/Weak badge, "last practiced N days ago",
      and Attempts / misses / Accuracy / Avg / Best. Tap around freely; tap
      again / elsewhere / Esc to dismiss.
    • Direction #1 "garden" decay: a Strong (green) fact fades green→amber when
      left unpracticed — fully fresh for 7 days, wilting to "needs tending" by
      21 (aligned with the gauntlet's 21-day window). Wilted cells get a dot and
      drop out of the Strong %, but re-green instantly on one good practice.
    Decisions I made (were open Qs in IDEAS.md): freshness is an OVERLAY — the
    underlying level/data is untouched, so it's honest and instantly reversible;
    only green cells decay (never fade toward red); a wilted fact DOES lose
    "green-the-grid" credit (more motivating) but reversibly. Pure
    cellFreshness/masteryView live in app-logic.js + are unit-tested; the grid
    blends the colour with CSS color-mix (graceful fallback if unsupported).

- [x] How can I bring XP into this?  I think that's a really important mechanic
  too but I don't totally knwo how to engage with it.  I kind of like the idea
  of having trophies or shapes or whatever that I woudl unlock over time.  I
  could do that and then have these images loaded into the app and I could
  unlock them.  I would want them to be a surprise to me effectively. And I'd
  have some sort of trophy case or wall or something.
  → DONE: **Ranks + a Trophy Case** (this is also IDEAS.md Direction #3 — the two
    were the same wish, so they're built as one thing).
    • **Ranks** — your *lifetime* XP (which was pure vanity) now climbs a 9-rung
      ladder, Novice → … → Reckoner → … → Luminary. The home XP line became a
      tappable **rank row**: rank name + a violet progress bar + "N XP to <next>"
      + your trophy tally + spendable-XP. Each rank's insignia is a polygon that
      gains a side as you climb (triangle → … → 11-gon), so it visibly sharpens.
    • **Trophy Case** (tap the rank row) — the "wall." A rank hero + a scrollable
      rank ladder, then a grid of collectible **emblems** (the "shapes," done as
      our monochrome SVG line-icons, not raster images — scalable, themeable, no
      deploy/404 risk) grouped by Streak · Gauntlet · Volume · Records · Mastery ·
      Secret. Earned tiles light up in a per-group accent + a check; locked tiles
      are quiet graphite with a live progress bar (e.g. "26 / 100").
    • **Surprise** — the **Secret** group stays hidden ("???", a padlock) until
      you trip it, and any freshly-earned emblem flashes a **NEW** badge with a
      dot on the home rank row until you visit the case. A rank-up throws confetti.
    • Emblems span everything you already do, so XP/play *pays out*: ranks, 7/30/
      100-day streaks, first-gauntlet / gold / 10-golds / 7-day-gauntlet, 100/1k/
      10k problems answered, sub-1s & sub-0.6s answers, 100-in-a-game, 25/100
      strong facts, a fully-green table, all-four-ops, + secrets (flawless game,
      midnight play, a freeze that saved your streak).  28 in all.
    Decisions I made: rewards are **ranks + collectible emblems** (NOT new
    palettes — Direction #3 floated palette-unlocks, but designing a whole new
    palette's colours is a "show-me-options" call I didn't want to make while you
    slept; teed up as a follow-up). Earned-state is **monotonic & persisted** —
    once earned, never lost, even if a mastered fact later wilts. Perf: a cheap
    reconcile (no full DB scan) runs on the home screen; the heavier mastery/
    fastest-answer scan only runs when the Mastery sheet or the Case opens, so the
    cold-launch path you optimised stays fast. Pure rankForXp / bestGauntletStreak
    / TROPHY_DEFS / evaluateTrophies / reconcileTrophies live in app-logic.js with
    11 new unit tests (71 pass). Verified end-to-end in headless Chrome across both
    palettes × light/dark (earned / locked / progress / secret / reveal states).
    Open choices for you: the rank **names** & XP **thresholds**, and the emblem
    **shapes/wording** — all just data, easy to tweak; see the screenshots.

- [x] I want to tweak the gauntlet.  I love the mode but it needs something
  else.  Liek why do I keep engaging with it?  How can I make use of those
  problems?  What is the point?  What do I get if I keep getting quicker?  If I
  beat the clock...?
  → DONE: **Par + medals.** The point was hiding in plain sight — the set changes
    every day (always your *current* weakest), so the raw clear-time was never
    comparable day to day, and "get faster" paid nothing. Fixes:
    • **Par** — a per-day target built from how long THESE facts actually take you
      (per-fact median of your recent solves, weak-default where unseen; sums to
      ~your honest pace on the set). Now "beat the clock" means the same thing on
      every set, easy or brutal. Shown on the card: "Par 22.5s · gold under 18.0s".
    • **Medals** grade each run vs par — gold (par −20%) · silver (beat par) ·
      bronze (clear it). The medal is the payoff for speed, and it's *collectable*:
      a lifetime gold/silver/bronze tally on the card turns the gauntlet from a
      maintenance loop into a campaign (chase gold today, grow the collection
      forever). Results sheet now leads with the medal you earned + par delta.
    • **XP follows speed** — first clear pays the tier's value (30/50/75); a later
      run that *upgrades* the day's medal pays only the difference, so chasing gold
      mid-day still rewards but re-clearing can't farm XP. (Replaces the flat +50.)
    Why it answers the Qs: you keep engaging to chase gold + grow the tally; the
    weak problems now *pay out* when you get fast on them (and still get evicted as
    you improve); beating the clock = a real, named target (par) with a medal.
    Pure gauntletPar / medalForTime / medalTargets / medalCounts + medal-aware
    recordGauntletClear live in app-logic.js, unit-tested; medal metals are theme
    tokens (gold/silver/bronze × 4 palettes). Verified end-to-end in headless
    Chrome (pre-clear / gold·silver·bronze results / cleared, dark + light).
    Open choice for you: the medal *colours* (I picked metallic tones per theme) —
    happy to tweak; see the screenshots.
