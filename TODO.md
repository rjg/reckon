
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

- [ ] How can I bring XP into this?  I think that's a really important
  mechanic too but I don't totally knwo how to engage with it.  I kind of like
  the idea of having trophies or shapes or whatever that I woudl unlock over
  time.  I would have AI generate these (maybe use nanobanana if Opus can't do
  it.  I could just have Opus give me the prompts).  But anyway, I could do that
  and then have these images loaded into the app and I could unlock them.  I
  would want them to be a surprise to me effectively. And I'd have some sort of
  trophy case or something. 

- [ ] I want to tweak the gauntlet.  I love the mode but it needs something
  else.  Liek why do I keep engaging with it?  How can I make use of those
  problems?  What is the point?  What do I get if I keep getting quicker?  If I
  beat the clock...?
