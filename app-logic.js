/* =====================================================================
   Reckon — pure logic (no DOM, no IndexedDB).

   Lives in its own file so it can be unit-tested under `node --test`
   while also loading as a browser global. index.html pulls the names it
   needs off the global `Z` object; tests `require('./app-logic.js')`.

   Everything here is a pure function of its arguments — in particular
   the streak/freeze functions take an explicit `today` Date so tests are
   deterministic (no hidden `new Date()`).
   ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // node
  else root.Z = api;                                                         // browser
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PLUS = '+', MINUS = '−', TIMES = '×', DIV = '÷';
  const OP_ORDER = [PLUS, MINUS, TIMES, DIV];

  /* ---- gamification constants ---- */
  const DAILY_GOAL = 5;     // completed games per local day to "meet" the day
  const FREEZE_COST = 1000; // XP to buy one streak freeze
  const MAX_FREEZES = 2;    // most you can hold at once
  const GAUNTLET_SIZE = 10;        // problems in the daily gauntlet
  const GAUNTLET_REWARD = 50;      // flat XP for the first clear of a day (placeholder)
  const GAUNTLET_WINDOW_DAYS = 21; // recent-history window the weak-fact set is drawn from

  /* ---- skill-weighted XP ----
     Base XP stays 1 per solved problem, so a no-combo run on the easiest preset
     earns exactly its score — nothing is ever worth LESS than it is today. Two
     pure multipliers reward playing SHARP on top of that base:
       · combo      — consecutive first-try-correct solves ramp a live multiplier
                      that RESETS on any miss, so accuracy (not just volume) pays.
       · difficulty — bigger operand ranges earn a gentle bonus (floor 1.0, never a
                      penalty), so challenge isn't out-earned by grinding Easy. */
  const COMBO_STEP = 5;       // every N clean solves in a row...
  const COMBO_BONUS = 0.10;   // ...lifts the live multiplier by this...
  const COMBO_MAX = 0.50;     // ...up to +50% (the multiplier tops out at 1.50)
  const DIFF_MIN = 1.0, DIFF_MAX = 1.5;  // difficulty-weight band; the 1.0 floor means never a penalty

  /* ---- survival / sudden death ----
     No overall timer: each problem has its OWN shrinking budget, and a single
     miss (wrong, or the budget running out) ends the run. The budget starts
     generous and tightens with every solve, so the run is self-limiting — the
     escalation comes from the clock, not from the number ranges (that's the
     separate "ladder" idea). All pure + unit-tested. */
  const SURVIVAL_START_MS = 8000;  // time budget for the first problem
  const SURVIVAL_FLOOR_MS = 2000;  // tightest the budget ever gets — low enough that a deep run truly races the clock
  const SURVIVAL_STEP_MS = 200;    // shaved off the budget per solve (floors at solve 30, so the clock keeps biting far longer)

  /* ---- dates (local-time day keys) ---- */
  function dayKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
           '-' + String(d.getDate()).padStart(2, '0');
  }
  function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

  /* ---- facts (commutative folding for +,×) ---- */
  function answerFor(op, o1, o2) {
    if (op === PLUS) return o1 + o2;
    if (op === MINUS) return o1 - o2;
    if (op === TIMES) return o1 * o2;
    return o1 / o2;
  }
  function canonFact(op, o1, o2) {
    if (op === PLUS || op === TIMES)
      return { operation: op, operand1: Math.min(o1, o2), operand2: Math.max(o1, o2) };
    return { operation: op, operand1: o1, operand2: o2 };
  }
  function factKey(p) {
    const c = canonFact(p.operation, p.operand1, p.operand2);
    return c.operation + ':' + c.operand1 + ':' + c.operand2;
  }

  /* ---- problem generation ----
     Subtraction is addition reversed and division is multiplication reversed,
     so answers are always whole and never negative by construction. `rng` is
     injectable (defaults to Math.random) purely so tests are deterministic;
     the challenge-pool path lives in index.html and is not generated here. */
  function randInt(rng, a, b) {
    if (a > b) { const t = a; a = b; b = t; }
    return Math.floor(rng() * (b - a + 1)) + a;
  }
  function makeProblem(op, o1, o2, ans) {
    return { operation: op, operand1: o1, operand2: o2, correctAnswer: ans, display: o1 + ' ' + op + ' ' + o2 };
  }
  function genProblem(c, rng) {
    rng = rng || Math.random;
    const pool = [];
    if (c.ops.add) pool.push('add'); if (c.ops.sub) pool.push('sub');
    if (c.ops.mul) pool.push('mul'); if (c.ops.div) pool.push('div');
    if (!pool.length) return null;   // no op enabled — don't fall through to a bogus division (callers guard upstream)
    const kind = pool[Math.floor(rng() * pool.length)];
    const a = c.add, m = c.mul;
    if (kind === 'add') {
      const x = randInt(rng, a.min1, a.max1), y = randInt(rng, a.min2, a.max2);
      return makeProblem(PLUS, x, y, x + y);
    }
    if (kind === 'sub') {            // x + y = sum  ->  sum - one = other
      const x = randInt(rng, a.min1, a.max1), y = randInt(rng, a.min2, a.max2), sum = x + y;
      return rng() < 0.5 ? makeProblem(MINUS, sum, x, y) : makeProblem(MINUS, sum, y, x);
    }
    if (kind === 'mul') {
      const x = randInt(rng, m.min1, m.max1), y = randInt(rng, m.min2, m.max2);
      return makeProblem(TIMES, x, y, x * y);
    }
    // div: x * y = prod  ->  prod / one = other
    // operands are clamped to >= 1 so the divisor is never 0 (no 0 / 0)
    const x = randInt(rng, Math.max(1, m.min1), Math.max(1, m.max1)),
          y = randInt(rng, Math.max(1, m.min2), Math.max(1, m.max2)), prod = x * y;
    return rng() < 0.5 ? makeProblem(DIV, prod, x, y) : makeProblem(DIV, prod, y, x);
  }

  /* ---- streak ---- */
  /* date string -> count of completed games that local day */
  function dayCounts(sessions) {
    const m = {};
    for (const s of sessions) { const k = dayKey(new Date(s.endedAt)); m[k] = (m[k] || 0) + 1; }
    return m;
  }
  /* a day "counts" toward the streak if the goal was met OR a freeze covers it */
  function daySatisfied(counts, freezeDays, key, goal) {
    return (counts[key] || 0) >= goal || !!(freezeDays && freezeDays[key]);
  }
  /* consecutive satisfied days ending today; today-in-progress doesn't break
     the run — we start the walk from yesterday when today isn't met yet */
  function currentStreak(counts, freezeDays, goal, today) {
    let d = new Date(today);
    if (!daySatisfied(counts, freezeDays, dayKey(d), goal)) d = addDays(d, -1);
    let n = 0;
    while (daySatisfied(counts, freezeDays, dayKey(d), goal)) { n++; d = addDays(d, -1); }
    return n;
  }
  /* longest run of consecutive satisfied days, ever */
  function bestStreak(counts, freezeDays, goal) {
    const set = new Set();
    for (const k in counts) if (counts[k] >= goal) set.add(k);
    if (freezeDays) for (const k in freezeDays) if (freezeDays[k]) set.add(k);
    const days = [...set].sort();
    let best = 0, run = 0, prev = null;
    for (const k of days) {
      run = (prev && dayKey(addDays(parseKey(prev), 1)) === k) ? run + 1 : 1;
      if (run > best) best = run;
      prev = k;
    }
    return best;
  }

  /* ---- streak freeze auto-consume ----
     Walk back from yesterday spending owned freezes to bridge missed days,
     but ONLY when the gap reconnects to an earlier satisfied day (so we never
     waste a freeze on an unbridgeable gap or on pre-history days). Mutates
     `progress` (freezes, freezeDays); returns the number of freezes spent. */
  function reconcileFreezes(counts, progress, today, goal) {
    goal = goal || DAILY_GOAL;
    progress.freezeDays = progress.freezeDays || {};
    // earliest satisfied day — past it there's nothing to bridge back to
    let earliest = null;
    const consider = k => { if (earliest === null || k < earliest) earliest = k; };
    for (const k in counts) if (counts[k] >= goal) consider(k);
    for (const k in progress.freezeDays) if (progress.freezeDays[k]) consider(k);
    if (earliest === null) return 0; // no streak exists at all

    let d = addDays(today, -1);   // never freeze today (still in progress)
    let avail = progress.freezes || 0;
    let pending = [];             // missed days awaiting a reconnect
    let spent = 0;
    while (true) {
      const k = dayKey(d);
      if (k < earliest) break;    // nothing earlier to connect to
      if (daySatisfied(counts, progress.freezeDays, k, goal)) {
        for (const pk of pending) { progress.freezeDays[pk] = true; spent++; } // commit bridge
        pending = [];
        d = addDays(d, -1);
        continue;
      }
      if (avail > 0) { pending.push(k); avail--; d = addDays(d, -1); continue; } // tentatively cover
      break;                      // out of freezes mid-gap — streak breaks here
    }
    // pending left uncommitted = gap that never reconnected -> discard (no waste)
    progress.freezes -= spent;
    return spent;
  }

  /* ---- progress / XP ---- */
  function defaultProgress() {
    return {
      xp: 0, xpLifetime: 0, freezes: 0, freezesBought: 0, freezeDays: {}, gauntletClears: {}, gauntletMedals: {},
      survivalBest: 0,
      trophies: {}, trophiesSeenAt: 0, stats: { probs: 0, fastestMs: 0 }, v: 1,
    };
  }
  /* running aggregates that need every problem (so trophies can be judged without
     a full DB scan): lifetime problem count + fastest correct solve. Kept best-
     effort up to date by the glue; the Trophy Case recomputes authoritatively. */
  function normalizeStats(s) {
    if (!s || typeof s !== 'object') return { probs: 0, fastestMs: 0 };
    return { probs: Math.max(0, Math.floor(s.probs) || 0), fastestMs: Math.max(0, Math.floor(s.fastestMs) || 0) };
  }
  /* normalize a loaded record so older/partial shapes don't crash callers */
  function normalizeProgress(p) {
    const d = defaultProgress();
    if (!p || typeof p !== 'object') return d;
    return {
      xp: Math.max(0, p.xp | 0),
      xpLifetime: Math.max(0, p.xpLifetime | 0),
      freezes: Math.max(0, Math.min(MAX_FREEZES, p.freezes | 0)),
      // freezes only ever come from buying, so a held freeze proves a past purchase — seed the
      // lifetime "bought" counter from whatever's held, so existing savers earn the Insured emblem
      freezesBought: Math.max(p.freezesBought | 0, p.freezes | 0),
      freezeDays: (p.freezeDays && typeof p.freezeDays === 'object') ? p.freezeDays : {},
      gauntletClears: (p.gauntletClears && typeof p.gauntletClears === 'object') ? p.gauntletClears : {},
      gauntletMedals: (p.gauntletMedals && typeof p.gauntletMedals === 'object') ? p.gauntletMedals : {},
      survivalBest: Math.max(0, p.survivalBest | 0),
      // trophies map values are earn-timestamps (ms) — keep verbatim (never |0; that truncates ms)
      trophies: (p.trophies && typeof p.trophies === 'object') ? p.trophies : {},
      trophiesSeenAt: Math.max(0, Number(p.trophiesSeenAt) || 0),
      stats: normalizeStats(p.stats),
      v: 1,
    };
  }
  function xpForSession(session) { return Math.max(0, (session && session.score) | 0); }
  function awardXp(progress, amount) {
    amount = Math.max(0, amount | 0);
    progress.xp += amount; progress.xpLifetime += amount;
    return amount;
  }

  /* XP multiplier for a clean solve that already had `run` clean solves before
     it: 1.0 for the first COMBO_STEP in a row, then +COMBO_BONUS per further
     step, capped at 1 + COMBO_MAX. A miss (handled by the caller) resets `run`. */
  function comboMultiplier(run) {
    const steps = Math.floor(Math.max(0, run | 0) / COMBO_STEP);
    return 1 + Math.min(COMBO_MAX, steps * COMBO_BONUS);
  }
  /* Walk a played session's problems IN ANSWER ORDER and total the combo-weighted
     base XP: every completed problem banks at least 1 (today's value), a clean
     first-try solve also earns its live combo multiplier and extends the run, and
     a fumble (wasCorrect=false) banks its 1 but breaks the run. Returns the pieces
     so the results sheet can explain the number. */
  function comboBreakdown(problems) {
    let run = 0, best = 0, base = 0, bonus = 0;
    for (const p of (problems || [])) {
      base += 1;
      if (p && p.wasCorrect) { bonus += comboMultiplier(run) - 1; run++; if (run > best) best = run; }
      else run = 0;
    }
    return { base, bonus, bestRun: best, bestMult: comboMultiplier(Math.max(0, best - 1)) };
  }
  /* A gentle XP weight from the configured operand ranges, so harder settings
     aren't out-earned by grinding Easy. Uses the midpoint of each enabled op's
     range as a stand-in for "how big are these numbers", on a log curve
     calibrated so the built-in Easy preset sits at the 1.0 floor and Normal/Hard
     reach ~1.2; clamped to [DIFF_MIN, DIFF_MAX]. Pure function of config. */
  function difficultyWeight(config) {
    if (!config || !config.ops) return DIFF_MIN;
    const a = config.add || {}, m = config.mul || {}, mids = [];
    const mid = (lo, hi) => (Math.max(0, lo || 0) + Math.max(0, hi || 0)) / 2;
    if (config.ops.add || config.ops.sub) mids.push(mid(a.min1, a.max1), mid(a.min2, a.max2));
    if (config.ops.mul || config.ops.div) mids.push(mid(m.min1, m.max1), mid(m.min2, m.max2));
    if (!mids.length) return DIFF_MIN;
    const typical = mids.reduce((s, x) => s + x, 0) / mids.length;
    const w = 0.75 + 0.122 * Math.log(Math.max(1, typical));
    return Math.max(DIFF_MIN, Math.min(DIFF_MAX, w));
  }
  /* Total XP for a freshly played session: combo-weighted base × difficulty,
     rounded. `sessionXpInfo` returns the pieces (for the results sheet); `sessionXp`
     is the number. A run with no combo and the easiest ranges == its score. */
  function sessionXpInfo(problems, config) {
    const cb = comboBreakdown(problems);
    const diff = difficultyWeight(config);
    const xp = Math.max(0, Math.round((cb.base + cb.bonus) * diff));
    return { xp, base: cb.base, comboBonus: cb.bonus, diff, bestRun: cb.bestRun, bestMult: cb.bestMult };
  }
  function sessionXp(problems, config) { return sessionXpInfo(problems, config).xp; }
  /* Survival's whole run is one clean chain (a miss ends it), so its XP is the
     same combo curve summed over the streak, × difficulty — counted directly from
     the streak length so the terminal miss problem isn't double-handled. */
  function survivalXp(streak, config) {
    streak = Math.max(0, streak | 0);
    let combo = 0;
    for (let k = 0; k < streak; k++) combo += comboMultiplier(k);
    return Math.max(0, Math.round(combo * difficultyWeight(config)));
  }
  function canBuyFreeze(progress) {
    return progress.xp >= FREEZE_COST && progress.freezes < MAX_FREEZES;
  }
  /* spend XP for a freeze; returns true on success, false if not allowed */
  function buyFreeze(progress) {
    if (!canBuyFreeze(progress)) return false;
    progress.xp -= FREEZE_COST; progress.freezes++;
    progress.freezesBought = (progress.freezesBought | 0) + 1;   // lifetime tally (drives the Insured emblem; never decremented)
    return true;
  }

  /* ---- survival ---- */
  /* time budget (ms) for the survival problem at 0-based index `solved` — the
     player has already cleared `solved` problems, and each one tightens the
     clock by SURVIVAL_STEP_MS down to a SURVIVAL_FLOOR_MS floor. */
  function survivalTimeLimit(solved) {
    solved = Math.max(0, solved | 0);
    return Math.max(SURVIVAL_FLOOR_MS, SURVIVAL_START_MS - solved * SURVIVAL_STEP_MS);
  }
  /* fold a finished run's streak into the lifetime best (monotonic). Mutates
     progress; returns {best, isBest, prev}. */
  function recordSurvival(progress, streak) {
    streak = Math.max(0, streak | 0);
    const prev = Math.max(0, progress.survivalBest | 0);
    const isBest = streak > prev;
    if (isBest) progress.survivalBest = streak;
    return { best: Math.max(prev, streak), isBest, prev };
  }

  /* ---- ghost (steady pace = your best rate for this preset) ---- */
  function pickGhost(sessions, presetName) {
    let best = null;
    for (const s of sessions) {
      if (s.presetName !== presetName) continue;
      if (!(s.rate > 0)) continue;
      if (!best || s.rate > best.rate) best = s;
    }
    return best ? { rate: best.rate, score: best.score, sessionId: best.sessionId } : null;
  }
  function ghostScoreAt(rate, elapsedMs) {
    if (!(rate > 0) || !(elapsedMs > 0)) return 0;
    return Math.floor(rate * (elapsedMs / 1000));
  }

  /* ---- in-game gauges (pure; drive the ring + ghost meter) ---- */
  // How far ahead/behind the ghost, as a 0..1 bar fraction off centre. `range`
  // is the lead (in problems) that fills the bar to its end; bigger gaps pin.
  const GHOST_METER_RANGE = 6;
  function ghostMeter(your, ghost, range = GHOST_METER_RANGE) {
    const diff = (your || 0) - (ghost || 0);
    const r = range > 0 ? range : GHOST_METER_RANGE;
    const frac = Math.min(1, Math.abs(diff) / r);
    return { diff, side: diff > 0 ? 'ahead' : diff < 0 ? 'behind' : 'even', frac };
  }
  // Time remaining as a 0..1 ring fraction plus an urgency level. Thresholds are
  // on the fraction (not absolute seconds) so they scale to any game length.
  function timeRingState(remainingMs, totalMs) {
    const frac = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
    const level = frac <= 0.08 ? 'crit' : frac <= 0.2 ? 'warn' : 'ok';
    return { frac, level };
  }

  /* ---- mastery grids ----
     Map every problem onto one of two fluency fact-families viewed per op:
       ×  : the two factors            (operand1, operand2)
       ÷  : divisor & quotient         (operand2, answer)
       +  : the two addends            (operand1, operand2)
       −  : subtrahend & difference    (operand2, answer)
     Cells are folded commutatively (min,max) within a maxN×maxN grid. */
  function gridFactors(p) {
    switch (p.operation) {
      case TIMES: return [p.operand1, p.operand2];
      case DIV:   return [p.operand2, p.correctAnswer];
      case PLUS:  return [p.operand1, p.operand2];
      case MINUS: return [p.operand2, p.correctAnswer];
      default:    return null;
    }
  }
  /* median of all correct answer times — the speed yardstick for cell levels */
  function masteryBaseline(problems) {
    const ok = problems.filter(p => p.wasCorrect).map(p => p.msToAnswer).sort((a, b) => a - b);
    return ok.length ? ok[Math.floor(ok.length / 2)] : 0;
  }
  /* 0 unseen · 1 weak · 2 ok · 3 strong */
  function cellLevel(cell, baseline) {
    if (!cell || cell.count === 0) return 0;
    const accuracy = cell.correct / cell.count;
    const avgMs = cell.correct ? cell.totalMs / cell.correct : Infinity;
    if (accuracy < 0.7) return 1;
    if (baseline && avgMs > 2 * baseline) return 1;
    if (accuracy >= 0.9 && (!baseline || avgMs <= 1.3 * baseline)) return 3;
    return 2;
  }
  /* returns { op, maxN, baseline, cells } where cells[i][j] (1-indexed via
     i-1,j-1) is {count,correct,totalMs,avgMs,accuracy,level} or null */
  function masteryGrid(problems, op, maxN, baseline) {
    maxN = maxN || 12;
    if (baseline == null) baseline = masteryBaseline(problems);
    const cells = Array.from({ length: maxN }, () => Array(maxN).fill(null));
    for (const p of problems) {
      if (p.operation !== op) continue;
      const f = gridFactors(p);
      if (!f) continue;
      let [a, b] = f;
      if (a > b) { const t = a; a = b; b = t; }
      if (a < 1 || b < 1 || a > maxN || b > maxN) continue;
      let c = cells[a - 1][b - 1];
      if (!c) c = cells[a - 1][b - 1] = { count: 0, correct: 0, totalMs: 0, minMs: Infinity, lastTs: 0 };
      c.count++;
      const ts = p.timestamp || 0;          // recency = most recent attempt (drives decay)
      if (ts > c.lastTs) c.lastTs = ts;
      if (p.wasCorrect) {
        c.correct++; c.totalMs += p.msToAnswer;
        if (p.msToAnswer < c.minMs) c.minMs = p.msToAnswer;  // personal best on this fact
      }
    }
    for (let i = 0; i < maxN; i++) for (let j = 0; j < maxN; j++) {
      const c = cells[i][j];
      if (!c) continue;
      c.avgMs = c.correct ? c.totalMs / c.correct : Infinity;
      c.accuracy = c.correct / c.count;
      c.level = cellLevel(c, baseline);
    }
    return { op, maxN, baseline, cells };
  }

  /* ---- mastery decay (the "garden you tend") ----
     cellLevel grades a fact green once and forever; decay adds recency on top so
     a mastered fact left untouched fades green → amber and asks to be practiced
     again. Pure: the caller passes `now` (ms) — no hidden clock — so it stays
     unit-testable. Freshness is a 1 → 0 ramp: full inside a grace window, linear
     down to 0 at the stale horizon (aligned with the gauntlet's 21-day recent
     window, so a fact that drops out of the gauntlet is also fully wilted here). */
  const MASTERY_FRESH_DAYS = 7;    // a fact stays fully green this long after practice
  const MASTERY_STALE_DAYS = 21;   // ...then fades, fully wilted (needs tending) by here
  function cellFreshness(lastTs, nowMs, freshDays, staleDays) {
    freshDays = freshDays != null ? freshDays : MASTERY_FRESH_DAYS;
    staleDays = staleDays != null ? staleDays : MASTERY_STALE_DAYS;
    if (!lastTs) return { stage: 'none', frac: 0, days: Infinity };   // never practiced (or pre-timestamp data)
    const days = Math.max(0, (nowMs - lastTs) / 86400000);
    if (days <= freshDays) return { stage: 'fresh', frac: 1, days };
    if (days >= staleDays) return { stage: 'stale', frac: 0, days };
    return { stage: 'aging', frac: 1 - (days - freshDays) / (staleDays - freshDays), days };
  }
  /* Fold a cell's quality (level) and its freshness into what the grid shows.
     ONLY strong (3) cells decay — weak/ok/unseen are already "go practice me", so
     fading them adds nothing. A strong cell's `decay` ramps 0 → 1 as it ages (the
     render blends green → amber by it); once fully stale it drops to displayLevel
     2 and is flagged `tending`, so it leaves the "strong" count and gets a marker.
     A strong cell with no timestamp (old imported data) can't be aged, so it
     stays green. */
  function masteryView(cell, nowMs, opts) {
    opts = opts || {};
    const level = cell ? cell.level : 0;
    const f = cellFreshness(cell ? cell.lastTs : 0, nowMs, opts.freshDays, opts.staleDays);
    let displayLevel = level, decay = 0, tending = false;
    if (level === 3 && (f.stage === 'aging' || f.stage === 'stale')) {
      decay = 1 - f.frac;                          // 0 (just past grace) → 1 (fully wilted)
      if (f.stage === 'stale') { displayLevel = 2; tending = true; }
    }
    return { level, displayLevel, decay, tending, stage: f.stage, days: f.days };
  }

  /* ---- mastery progress (the "green the grid" campaign) ----
     Fold all four ops into one progress read: how many cells are strong (after
     decay) out of every REACHABLE cell — the upper triangle per op (12·13/2 = 78,
     ×4 = 312 at maxN=12). The denominator is ALL reachable cells (grey ones count
     against you), so 100% means a fully-tended garden — a real completion target
     that decay keeps alive. `tablesGreen` counts ops whose whole table is green.
     Pure (caller passes `now`); the glue's Trophy Case + Mastery sheet both read it. */
  function masteryProgress(problems, nowMs, maxN) {
    maxN = maxN || 12;
    const baseline = masteryBaseline(problems || []);
    let strong = 0, seen = 0, reachable = 0, opsWithStrong = 0, tablesGreen = 0;
    const perOp = [];
    for (const op of OP_ORDER) {
      const g = masteryGrid(problems || [], op, maxN, baseline);
      let s = 0, sn = 0, reach = 0;
      for (let i = 0; i < maxN; i++) for (let j = i; j < maxN; j++) {   // i<=j: the folded upper triangle
        reach++;
        const c = g.cells[i][j];
        if (c) sn++;
        if (masteryView(c, nowMs).displayLevel === 3) s++;
      }
      strong += s; seen += sn; reachable += reach;
      if (s > 0) opsWithStrong++;
      if (s === reach) tablesGreen++;
      perOp.push({ op, strong: s, seen: sn, reachable: reach, full: s === reach });
    }
    return { strong, seen, reachable, pct: reachable ? strong / reachable : 0, opsWithStrong, tablesGreen, baseline, perOp };
  }

  /* ---- per-operation aggregate (results & stats tables) ----
     One row per operation that occurred, in OP_ORDER; the row with the
     highest average solve time is flagged `slowest` (first one wins ties). */
  function opStats(problems) {
    const map = {};
    for (const op of OP_ORDER) map[op] = { op, count: 0, totalMs: 0, errors: 0 };
    for (const p of problems) {
      const s = map[p.operation];
      if (!s) continue;
      s.count++; s.totalMs += p.msToAnswer; if (!p.wasCorrect) s.errors++;
    }
    const rows = OP_ORDER.map(op => map[op]).filter(s => s.count > 0)
      .map(s => ({ ...s, avgMs: s.totalMs / s.count }));
    let slow = null;
    for (const r of rows) if (!slow || r.avgMs > slow.avgMs) slow = r;
    if (slow) slow.slowest = true;
    return rows;
  }

  /* ---- accuracy: share of solves answered right on the first try ----
     A problem counts as correct only when it was answered with no wrong
     attempt first (wasCorrect). Returns the clean count, the total solved,
     and a rounded percent; an empty game is 0/0 → 0%. */
  function accuracy(problems) {
    let correct = 0;
    for (const p of problems) if (p.wasCorrect) correct++;
    const total = problems.length;
    return { correct, total, pct: total ? Math.round(correct / total * 100) : 0 };
  }

  /* ---- challenge: rank your historically hardest facts ----
     Blend miss-rate and slowness (median solve vs your overall median) into one
     difficulty score. Robust to small samples: facts seen <2 times are skipped;
     a fact that's never been solved correctly is treated as a 4s solve so it
     still ranks as hard. Returns the topN highest-scoring facts. */
  function computeWeakFacts(problems, topN) {
    const anyCorrect = problems.some(p => p.wasCorrect);
    if (!anyCorrect) return [];
    const baseline = masteryBaseline(problems);   // overall median correct time
    const m = {};
    for (const p of problems) {
      const k = factKey(p);
      if (!m[k]) { const c = canonFact(p.operation, p.operand1, p.operand2); m[k] = { ...c, times: [], errors: 0, count: 0 }; }
      const f = m[k]; f.count++;
      if (p.wasCorrect) f.times.push(p.msToAnswer); else f.errors++;
    }
    const facts = [];
    for (const k in m) {
      const f = m[k]; if (f.count < 2) continue;
      f.times.sort((a, b) => a - b);
      const med = f.times.length ? f.times[Math.floor(f.times.length / 2)] : 4000;
      const missRate = f.errors / f.count;
      const score = (med - baseline) / 1000 + missRate * 2.5;
      const ans = answerFor(f.operation, f.operand1, f.operand2);
      facts.push({
        operation: f.operation, operand1: f.operand1, operand2: f.operand2,
        correctAnswer: ans, display: f.operand1 + ' ' + f.operation + ' ' + f.operand2,
        _score: score, _medMs: med, _missRate: missRate, _count: f.count,
      });
    }
    facts.sort((a, b) => b._score - a._score);
    return facts.slice(0, topN);
  }

  /* ---- daily gauntlet ----
     The gauntlet is your N weakest facts (computeWeakFacts) drawn from a RECENT
     window of history, so getting fast on a fact actually evicts it and the
     next-weakest moves in. Cold start: top up with generated problems until
     there are N. `rng` is injectable so the cold-start fill is reproducible per
     day (index.html seeds it by date; tests pass a deterministic rng) — so the
     SET is stable for the whole day. Presentation ORDER is deliberately NOT
     fixed here: beginGauntlet shuffles the snapshot with Math.random on every
     run, so retries can't be won by memorizing the answer sequence. */
  function recentProblems(problems, nowMs, days) {
    if (!(days > 0)) return (problems || []).slice();
    const cutoff = nowMs - days * 86400000;
    return (problems || []).filter(p => (p.timestamp || 0) >= cutoff);
  }
  const GAUNTLET_FILL = {
    ops: { add: true, sub: true, mul: true, div: true },
    add: { min1: 2, max1: 50, min2: 2, max2: 50 },
    mul: { min1: 2, max1: 12, min2: 2, max2: 12 },
  };
  /* in-place Fisher–Yates; rng defaults to Math.random. Returns arr. Pulled out
     so the gauntlet can be SELECTED deterministically (buildGauntlet, seeded by
     the day) yet PRESENTED in a fresh order each run (beginGauntlet shuffles the
     day's snapshot with Math.random). */
  function shuffle(arr, rng) {
    rng = rng || Math.random;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function buildGauntlet(problems, nowMs, rng, opts) {
    opts = opts || {};
    const size = opts.size || GAUNTLET_SIZE;
    const days = opts.windowDays != null ? opts.windowDays : GAUNTLET_WINDOW_DAYS;
    const fill = opts.fillCfg || GAUNTLET_FILL;
    rng = rng || Math.random;
    const weak = computeWeakFacts(recentProblems(problems, nowMs, days), size);
    const out = weak.map(f => ({
      operation: f.operation, operand1: f.operand1, operand2: f.operand2,
      correctAnswer: f.correctAnswer, display: f.display,
    }));
    const seen = new Set(out.map(factKey));
    let guard = 0;
    while (out.length < size && guard++ < 500) {        // cold-start top-up
      const p = genProblem(fill, rng);
      const k = factKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        operation: p.operation, operand1: p.operand1, operand2: p.operand2,
        correctAnswer: p.correctAnswer, display: p.display,
      });
    }
    return out;   // weakest-first; beginGauntlet shuffles a copy per run (see shuffle)
  }
  /* consecutive days with a clear, ending today; today-not-done doesn't break it */
  function gauntletStreak(clears, today) {
    if (!clears) return 0;
    let d = new Date(today);
    if (clears[dayKey(d)] == null) d = addDays(d, -1);
    let n = 0;
    while (clears[dayKey(d)] != null) { n++; d = addDays(d, -1); }
    return n;
  }
  /* ---- par & medals ----
     The daily set changes (it's always your *current* weakest facts), so raw
     clear-times don't compare day to day — 18s on an easy set beats 22s on a
     brutal one, yet the bare number hides that, which is why "get faster" has
     felt pointless. Par fixes it: a per-day target built from how long these
     specific facts actually take YOU, so "beat the clock" means the same thing
     every day regardless of which facts are in the set. A run is then graded
     against par into a medal — gold (crush it) · silver (beat it) · bronze
     (clear it) — giving speed a concrete, collectable payoff. All pure. */
  const MEDAL_RANK = { none: 0, bronze: 1, silver: 2, gold: 3 };
  const MEDAL_TIERS = ['bronze', 'silver', 'gold'];      // ascending
  const MEDAL_XP = { bronze: 30, silver: 50, gold: 75 };  // XP credited for *reaching* a tier
  // medal cutoffs as a fraction of par: beat par → silver, par −20% → gold.
  const PAR_GOLD = 0.80, PAR_SILVER = 1.00;
  const PAR_DEFAULT_BASELINE = 2500;  // ms — yardstick when no correct times exist yet (cold start)
  const PAR_WEAK_MULT = 1.5;          // a fact with no recent samples is assumed this × baseline
  const PAR_FACT_FLOOR = 700, PAR_FACT_CAP = 9000;        // clamp each fact's expectation (ms)

  /* Expected time to clear `facts`, summed from your own recent pace on each:
     the median of your correct solve-times for that exact fact (needs ≥2
     samples), else a weak-fact default (these are your slow spots, so > median).
     Pure — pass the SAME recent-window `problems` the gauntlet was built from.
     Returns { parMs, baseline, perFact:[{key, expMs, from}] }. */
  function gauntletPar(facts, problems, opts) {
    opts = opts || {};
    const weakMult = opts.weakMult != null ? opts.weakMult : PAR_WEAK_MULT;
    let baseline = masteryBaseline(problems || []);
    if (!(baseline > 0)) baseline = PAR_DEFAULT_BASELINE;
    const times = {};                                    // factKey -> [correct msToAnswer]
    for (const p of (problems || [])) {
      if (!p.wasCorrect) continue;
      const k = factKey(p);
      (times[k] = times[k] || []).push(p.msToAnswer);
    }
    const clamp = ms => Math.max(PAR_FACT_FLOOR, Math.min(PAR_FACT_CAP, ms));
    const perFact = (facts || []).map(f => {
      const k = factKey(f), ts = times[k];
      let expMs, from;
      if (ts && ts.length >= 2) {
        ts.sort((a, b) => a - b);
        expMs = ts[Math.floor(ts.length / 2)]; from = 'history';
      } else { expMs = baseline * weakMult; from = 'default'; }
      return { key: k, expMs: clamp(expMs), from };
    });
    const parMs = Math.round(perFact.reduce((a, x) => a + x.expMs, 0));
    return { parMs, baseline, perFact };
  }

  /* Grade a clear time against par. No usable par (≤0) → bronze: a clear is a clear. */
  function medalForTime(ms, parMs) {
    if (!(parMs > 0)) return 'bronze';
    if (ms <= PAR_GOLD * parMs) return 'gold';
    if (ms <= PAR_SILVER * parMs) return 'silver';
    return 'bronze';
  }
  /* The concrete time you must beat for each medal — so the card can show real
     target seconds ("gold under 18.2s"), kept in lockstep with medalForTime. */
  function medalTargets(parMs) {
    parMs = Math.max(0, parMs || 0);
    return { silver: Math.round(PAR_SILVER * parMs), gold: Math.round(PAR_GOLD * parMs) };
  }

  /* Lifetime tally from the per-day best-medal map (the collection you grow). */
  function medalCounts(gauntletMedals) {
    const out = { gold: 0, silver: 0, bronze: 0, total: 0 };
    if (!gauntletMedals) return out;
    for (const k in gauntletMedals) {
      const m = gauntletMedals[k];
      if (out[m] != null) { out[m]++; out.total++; }
    }
    return out;
  }

  /* record a clear time (ms) for a day. Tracks the day's best time AND best
     medal, and pays XP for *upgrading* the day's medal (first clear pays the
     full tier value; a later run that earns a better medal pays only the
     difference — so chasing gold mid-day still rewards, but re-clearing doesn't
     farm XP). Called WITHOUT a medal (3-arg, e.g. tests) it falls back to the
     old flat first-clear reward. Mutates progress (gauntletClears, gauntletMedals,
     xp via awardXp). */
  function recordGauntletClear(progress, key, ms, medal) {
    progress.gauntletClears = progress.gauntletClears || {};
    progress.gauntletMedals = progress.gauntletMedals || {};
    ms = Math.max(0, Math.round(ms));
    const prev = progress.gauntletClears[key];
    const firstToday = prev == null;
    const improved = firstToday || ms < prev;
    if (improved) progress.gauntletClears[key] = ms;

    const prevMedal = progress.gauntletMedals[key] || null;
    let medalImproved = false, reward;
    if (medal) {
      medalImproved = (MEDAL_RANK[medal] || 0) > (MEDAL_RANK[prevMedal] || 0);
      if (medalImproved) progress.gauntletMedals[key] = medal;
      const gained = medalImproved
        ? (MEDAL_XP[medal] || 0) - (prevMedal ? (MEDAL_XP[prevMedal] || 0) : 0) : 0;
      reward = gained > 0 ? awardXp(progress, gained) : 0;
    } else {
      reward = firstToday ? awardXp(progress, GAUNTLET_REWARD) : 0;   // legacy flat reward
    }
    return {
      firstToday, improved, best: progress.gauntletClears[key], reward,
      medal: progress.gauntletMedals[key] || null, prevMedal, medalImproved,
    };
  }

  /* ---- ranks & trophies (give XP a destination) ----
     xpLifetime used to be vanity — it counted up with nothing attached. Two pure
     layers fix that (pure ⇒ unit-tested ⇒ the UI is just paint):
       · RANKS  — a lifetime-XP ladder, a title you climb (Novice → Luminary).
       · TROPHY_DEFS — a catalog of collectible emblems earned across systems the
         app already has (ranks, streak, gauntlet medals, volume, speed records,
         mastery) plus a few SECRET ones (hidden until earned — the "surprise").
     Each trophy is a predicate over a flat `stats` bundle the glue computes.
     evaluateTrophies returns who's satisfied; reconcileTrophies folds that into a
     persisted, MONOTONIC earned-set on `progress` (once earned, never lost — even
     if the underlying stat later regresses, e.g. a mastered fact wilting). */
  const RANKS = [
    { key: 'novice',     name: 'Novice',     xp: 0 },
    { key: 'apprentice', name: 'Apprentice', xp: 500 },
    { key: 'adept',      name: 'Adept',      xp: 1500 },
    { key: 'reckoner',   name: 'Reckoner',   xp: 4000 },
    { key: 'tactician',  name: 'Tactician',  xp: 9000 },
    { key: 'savant',     name: 'Savant',     xp: 20000 },
    { key: 'virtuoso',   name: 'Virtuoso',   xp: 40000 },
    { key: 'master',     name: 'Master',     xp: 75000 },
    { key: 'luminary',   name: 'Luminary',   xp: 150000 },
  ];
  /* current rank + progress toward the next, from lifetime XP. At the top rank
     `next` is null, `progress` pins to 1, and `xpForNext` is 0. */
  function rankForXp(xpLifetime) {
    const xp = Math.max(0, Math.floor(xpLifetime || 0));
    let i = 0;
    for (let k = 0; k < RANKS.length; k++) if (xp >= RANKS[k].xp) i = k;
    const rank = RANKS[i], next = RANKS[i + 1] || null;
    const span = next ? next.xp - rank.xp : 0;
    const into = xp - rank.xp;
    return {
      index: i, rank, next, isMax: !next,
      xpIntoRank: into, xpForNext: next ? next.xp - xp : 0,
      progress: next ? Math.max(0, Math.min(1, into / span)) : 1,
    };
  }
  /* longest run of consecutive cleared days in the gauntlet-clears map (mirrors
     bestStreak, but over clears instead of the daily goal). */
  function bestGauntletStreak(clears) {
    if (!clears) return 0;
    const days = Object.keys(clears).filter(k => clears[k] != null).sort();
    let best = 0, run = 0, prev = null;
    for (const k of days) {
      run = (prev && dayKey(addDays(parseKey(prev), 1)) === k) ? run + 1 : 1;
      if (run > best) best = run;
      prev = k;
    }
    return best;
  }

  /* trophy thresholds — pulled out so tests and the UI can reference them. */
  const TROPHY = {
    QUICKDRAW_MS: 1000, LIGHTNING_MS: 600,
    HIGH_SCORE: 100, HIGH_SCORE_MAX_SEC: 120,    // 100-in-a-game must be a standard-length game, not a stretched custom timer
    SURVIVAL: 25, SURVIVAL_TIERS: [10, 25, 50, 100],
    FLAWLESS_TIERS: [15, 30, 50],                // no-mistake game sizes — the visible accuracy ladder
    VOL: [100, 1000, 10000], STRONG: [25, 100],
    DAY_STREAK: [7, 30, 100], GAUNT_STREAK: 7, GOLDS: 10, GOLD_TIERS: [10, 25, 50, 100],
    GRID_PCT: [50, 75, 100], GRID_REACHABLE: 312,   // "green the grid" tiers (% of all reachable cells)
  };
  const fastWithin = (s, ms) => (s.fastestCorrectMs > 0 && s.fastestCorrectMs <= ms);
  /* one trophy per rank above Novice (Novice xp 0 is the START, not an unlock). */
  const RANK_TROPHIES = RANKS.slice(1).map(r => ({
    id: 'rank-' + r.key, group: 'rank', icon: 'rank', name: r.name,
    desc: 'Reach the rank of ' + r.name, rankXp: r.xp,
    reached: s => (s.xpLifetime || 0) >= r.xp,
    progress: s => ({ cur: Math.min(s.xpLifetime || 0, r.xp), target: r.xp }),
  }));
  /* the catalog. `icon` names a line-icon the UI provides; `reached(stats)` is the
     pure earn test; `progress(stats)` (optional) drives a progress bar. A stat a
     trophy needs but a cheap reconcile didn't compute is simply absent → its
     predicate reads it as 0 → not-yet-earned (and the authoritative full-scan
     reconcile the Trophy Case runs catches it). `secret` ⇒ hidden as "???" until
     earned. */
  const TROPHY_DEFS = RANK_TROPHIES.concat([
    // streak — a day-streak you held
    ...TROPHY.DAY_STREAK.map((n, i) => ({
      id: 'streak-' + n, group: 'streak', icon: 'flame', name: ['On Fire', 'Devoted', 'Unbroken'][i],
      desc: 'Hold a ' + n + '-day streak',
      reached: s => (s.bestDayStreak || 0) >= n, progress: s => ({ cur: Math.min(s.bestDayStreak || 0, n), target: n }),
    })),
    // gauntlet — the daily race
    { id: 'gaunt-first', group: 'gauntlet', icon: 'bolt', name: 'Into the Gauntlet',
      desc: 'Clear your first daily gauntlet', reached: s => (s.totalGauntlets || 0) >= 1 },
    { id: 'gaunt-gold', group: 'gauntlet', icon: 'medal', name: 'Struck Gold',
      desc: 'Earn a gold medal', reached: s => (s.golds || 0) >= 1 },
    // gold collection — a tier ladder (the original Gold Hoard=10 keeps its id)
    ...TROPHY.GOLD_TIERS.map((n, i) => ({
      id: n === TROPHY.GOLDS ? 'gaunt-gold10' : 'gaunt-gold' + n, group: 'gauntlet', icon: 'medal',
      name: ['Gold Hoard', 'Gold Rush', 'Midas Touch', 'El Dorado'][i],
      desc: 'Collect ' + n + ' gold medals',
      reached: s => (s.golds || 0) >= n, progress: s => ({ cur: Math.min(s.golds || 0, n), target: n }),
    })),
    { id: 'gaunt-streak7', group: 'gauntlet', icon: 'bolt', name: 'Relentless',
      desc: 'Clear the gauntlet ' + TROPHY.GAUNT_STREAK + ' days running',
      reached: s => (s.bestGauntletStreak || 0) >= TROPHY.GAUNT_STREAK,
      progress: s => ({ cur: Math.min(s.bestGauntletStreak || 0, TROPHY.GAUNT_STREAK), target: TROPHY.GAUNT_STREAK }) },
    // volume — problems answered, lifetime
    ...TROPHY.VOL.map((n, i) => ({
      id: 'vol-' + n, group: 'volume', icon: 'layers', name: ['Centurion', 'Thousand Sums', 'Ten Thousand Things'][i],
      desc: ['Answer 100 problems', 'Answer 1,000 problems', 'Answer 10,000 problems'][i],
      reached: s => (s.totalProblems || 0) >= n, progress: s => ({ cur: Math.min(s.totalProblems || 0, n), target: n }),
    })),
    // speed & records
    { id: 'rec-quickdraw', group: 'records', icon: 'target', name: 'Quickdraw',
      desc: 'Answer correctly in under 1.0s', reached: s => fastWithin(s, TROPHY.QUICKDRAW_MS) },
    { id: 'rec-lightning', group: 'records', icon: 'bolt', name: 'Lightning',
      desc: 'Answer correctly in under 0.6s', reached: s => fastWithin(s, TROPHY.LIGHTNING_MS) },
    { id: 'rec-highscore', group: 'records', icon: 'trophy', name: 'High Score',
      desc: 'Solve ' + TROPHY.HIGH_SCORE + '+ in a standard game', reached: s => (s.bestScoreStd || 0) >= TROPHY.HIGH_SCORE,
      progress: s => ({ cur: Math.min(s.bestScoreStd || 0, TROPHY.HIGH_SCORE), target: TROPHY.HIGH_SCORE }) },
    // accuracy — a visible ladder of clean (no-miss) games (was a single hidden "Flawless" secret)
    ...TROPHY.FLAWLESS_TIERS.map((n, i) => ({
      id: 'rec-flawless' + n, group: 'records', icon: 'sparkle',
      name: ['Spotless', 'Flawless', 'Immaculate'][i],
      desc: 'Finish a ' + n + '+ problem game with no mistakes',
      reached: s => (s.bestFlawless || 0) >= n, progress: s => ({ cur: Math.min(s.bestFlawless || 0, n), target: n }),
    })),
    // survival — a tier ladder (the original Survivor=25 keeps its id so the earned badge survives)
    ...TROPHY.SURVIVAL_TIERS.map((n, i) => ({
      id: n === TROPHY.SURVIVAL ? 'rec-survival' : 'rec-survival' + n, group: 'records', icon: 'skull',
      name: ['Steady Nerve', 'Survivor', 'Unflinching', 'Untouchable'][i],
      desc: 'Survive ' + n + ' in a row',
      reached: s => (s.bestSurvival || 0) >= n,
      progress: s => ({ cur: Math.min(s.bestSurvival || 0, n), target: n }),
    })),
    // mastery — the fluency grid
    ...TROPHY.STRONG.map((n, i) => ({
      id: 'mas-' + n, group: 'mastery', icon: 'sprout', name: ['Green Thumb', 'Cultivated'][i],
      desc: 'Make ' + n + ' facts strong',
      reached: s => (s.strongFacts || 0) >= n, progress: s => ({ cur: Math.min(s.strongFacts || 0, n), target: n }),
    })),
    { id: 'mas-table', group: 'mastery', icon: 'grid', name: 'Table Master',
      desc: 'Turn an entire table green', reached: s => !!s.tableMastered },
    { id: 'mas-allops', group: 'mastery', icon: 'star', name: 'Polymath',
      desc: 'Be strong in all four operations', reached: s => (s.opsWithStrong || 0) >= 4,
      progress: s => ({ cur: Math.min(s.opsWithStrong || 0, 4), target: 4 }) },
    // mastery — green-the-grid campaign (% of ALL reachable cells; decay keeps it alive)
    ...TROPHY.GRID_PCT.map((p, i) => ({
      id: 'mas-grid' + p, group: 'mastery', icon: ['sprout', 'sprout', 'star'][i],
      name: ['In Bloom', 'Verdant', 'Evergreen'][i],
      desc: p >= 100 ? 'Turn the entire grid green' : 'Turn ' + p + '% of the grid green',
      reached: s => (s.gridReachable || 0) > 0 && (s.gridStrong || 0) / s.gridReachable >= p / 100,
      progress: s => { const t = Math.round(p / 100 * (s.gridReachable || TROPHY.GRID_REACHABLE)); return { cur: Math.min(s.gridStrong || 0, t), target: t }; },
    })),
    { id: 'mas-alltables', group: 'mastery', icon: 'grid', name: 'Grandmaster',
      desc: 'Make all four tables fully green', reached: s => (s.tablesGreen || 0) >= 4,
      progress: s => ({ cur: Math.min(s.tablesGreen || 0, 4), target: 4 }) },
    // secret — hidden until earned (the surprise)
    { id: 'sec-nightowl', group: 'secret', icon: 'moon', name: 'Night Owl', secret: true,
      desc: 'Play between midnight and 5am', reached: s => !!s.nightOwl },
    { id: 'sec-saved', group: 'secret', icon: 'shield', name: 'Insured', secret: true,
      desc: 'Stock a streak freeze', reached: s => (s.freezesBought || 0) >= 1 },
  ]);
  const TROPHY_TOTAL = TROPHY_DEFS.length;
  const TROPHY_BY_ID = {};
  for (const t of TROPHY_DEFS) TROPHY_BY_ID[t.id] = t;

  /* ids of every trophy currently satisfied by `stats`, in catalog order (pure). */
  function evaluateTrophies(stats) {
    stats = stats || {};
    const out = [];
    for (const t of TROPHY_DEFS) { try { if (t.reached(stats)) out.push(t.id); } catch (e) {} }
    return out;
  }
  /* fold the satisfied set into progress.trophies (id → earnedAt ms), NEVER
     removing. Returns the defs newly earned THIS call (for the unlock reveal), in
     catalog order. Pure aside from mutating `progress`. */
  function reconcileTrophies(progress, stats, nowMs) {
    progress.trophies = progress.trophies || {};
    const fresh = [];
    for (const id of evaluateTrophies(stats)) {
      if (progress.trophies[id] == null) { progress.trophies[id] = nowMs || 0; fresh.push(TROPHY_BY_ID[id]); }
    }
    return fresh;
  }
  /* {earned, total} for the home hint (counts only ids still in the catalog). */
  function trophyCounts(progress) {
    const t = progress && progress.trophies;
    let earned = 0;
    if (t) for (const k in t) if (t[k] != null && TROPHY_BY_ID[k]) earned++;
    return { earned, total: TROPHY_TOTAL };
  }

  /* ---- CSV import (the inverse of index.html's downloadCSV) ----
     The export writes one row per problem with its session's metadata
     denormalized on. buildImport regroups rows by sessionId and rebuilds each
     session record — score, rate, elapsed and config are DERIVED, since the
     export doesn't carry them (elapsed is taken from the timed duration, or the
     summed solve times when untimed). Rows with no sessionDate were logged
     without a session (e.g. the daily gauntlet), so they come back as
     looseProblems: problems only, no session. Pure — the IndexedDB merge and
     dedupe live in the glue. */
  function parseCSV(text) {
    if (typeof text !== 'string') return [];
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // strip BOM
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }       // escaped quote
          else inQ = false;
        } else field += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;            // CRLF
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  function parseOpsSig(sig) {
    const ops = { add: false, sub: false, mul: false, div: false };
    String(sig || '').split('+').forEach(k => { if (k in ops) ops[k] = true; });
    return ops;
  }
  function parseRange(str) {                 // "min1-max1;min2-max2"
    const num = v => { const x = Number(v); return Number.isFinite(x) ? x : 1; };
    const pair = s => { const a = String(s).split('-'); return [num(a[0]), num(a[a.length - 1])]; };
    const parts = String(str || '').split(';');
    const p1 = pair(parts[0] || ''), p2 = pair(parts[1] || '');
    return { min1: p1[0], max1: p1[1], min2: p2[0], max2: p2[1] };
  }

  function buildImport(rows) {
    const fail = e => ({ ok: false, error: e, sessions: [], looseProblems: [], imported: 0, skipped: 0 });
    if (!Array.isArray(rows) || rows.length < 2) return fail('No data rows found');
    const col = {};
    rows[0].forEach((h, i) => { const k = String(h).trim(); if (!(k in col)) col[k] = i; });
    const required = ['sessionId', 'operation', 'operand1', 'operand2', 'correctAnswer',
      'userAnswer', 'wasCorrect', 'msToAnswer', 'problemTimestamp'];
    for (const r of required) if (!(r in col)) return fail('Not a Reckon CSV (missing "' + r + '")');

    const isOp = op => op === PLUS || op === MINUS || op === TIMES || op === DIV;
    const toInt = v => { const x = Number(v); return Number.isFinite(x) ? Math.round(x) : null; };

    const order = [], groups = {}, meta = {};
    let imported = 0, skipped = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || (row.length === 1 && row[0] === '')) continue;   // blank line
      const get = name => { const idx = col[name]; return idx == null || row[idx] == null ? '' : row[idx]; };
      const sid = String(get('sessionId')).trim();
      const op = String(get('operation'));
      const o1 = toInt(get('operand1')), o2 = toInt(get('operand2'));
      const ca = toInt(get('correctAnswer')), ua = toInt(get('userAnswer')), ms = toInt(get('msToAnswer'));
      if (!sid || !isOp(op) || o1 === null || o2 === null || ca === null || ua === null || ms === null) { skipped++; continue; }
      const ts = Date.parse(get('problemTimestamp'));
      if (!groups[sid]) { groups[sid] = []; order.push(sid); meta[sid] = { endedAt: '', presetName: '', ops: '', add: '', mul: '', durationSec: '' }; }
      groups[sid].push({
        sessionId: sid, timestamp: Number.isFinite(ts) ? ts : 0, operation: op,
        operand1: o1, operand2: o2, correctAnswer: ca, userAnswer: ua,
        wasCorrect: String(get('wasCorrect')).trim().toLowerCase() === 'true',
        msToAnswer: Math.max(0, ms),
      });
      const mt = meta[sid], set = (k, v) => { if (!mt[k] && v) mt[k] = String(v).trim(); };
      set('endedAt', get('sessionDate')); set('presetName', get('presetName'));
      set('ops', get('enabledOps')); set('add', get('addRange'));
      set('mul', get('mulRange')); set('durationSec', get('durationSec'));
      imported++;
    }

    const sessions = [], looseProblems = [];
    for (const sid of order) {
      const probs = groups[sid], mt = meta[sid];
      if (!mt.endedAt) { for (const p of probs) looseProblems.push(p); continue; }
      const durationSec = Math.max(0, toInt(mt.durationSec) || 0);
      const sumMs = probs.reduce((a, p) => a + p.msToAnswer, 0);
      const elapsedMs = durationSec > 0 ? durationSec * 1000 : sumMs;  // timed games run ~full duration
      const endedMs = Date.parse(mt.endedAt);
      const score = probs.length, errorCount = probs.filter(p => !p.wasCorrect).length;
      sessions.push({
        sessionId: sid, presetName: mt.presetName || 'Custom',
        startedAt: Number.isFinite(endedMs) ? new Date(endedMs - elapsedMs).toISOString() : mt.endedAt,
        endedAt: mt.endedAt, durationSec, elapsedMs,
        score, totalAnswered: score, errorCount,
        rate: elapsedMs > 0 ? score / (elapsedMs / 1000) : 0,
        config: { presetName: mt.presetName || 'Custom', durationSec, ops: parseOpsSig(mt.ops), add: parseRange(mt.add), mul: parseRange(mt.mul) },
        problems: probs,
      });
    }
    return { ok: true, error: '', sessions, looseProblems, imported, skipped };
  }

  /* ---- complete backup (JSON) ----
     Unlike the CSV (per-problem only), a backup is a full snapshot: sessions,
     problems AND the progress record (XP / freezes / streak-freezes / gauntlet
     clears) that the CSV never carried. parseBackup validates a backup blob and
     returns it in the same {sessions, looseProblems} shape the CSV import uses
     (so the IndexedDB merge is shared), plus a normalized progress. Sessions
     keep their stored score/rate/config verbatim — nothing is re-derived. */
  function parseBackup(text) {
    let obj;
    try { obj = typeof text === 'string' ? JSON.parse(text) : text; }
    catch (e) { return { ok: false, error: 'Not valid JSON', sessions: [], looseProblems: [], progress: null, imported: 0, skipped: 0 }; }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.sessions) || !Array.isArray(obj.problems))
      return { ok: false, error: 'Not a Reckon backup', sessions: [], looseProblems: [], progress: null, imported: 0, skipped: 0 };

    const isOp = op => op === PLUS || op === MINUS || op === TIMES || op === DIV;
    const int = (v, d) => { const x = Number(v); return Number.isFinite(x) ? Math.round(x) : (d == null ? null : d); };
    const probsBySid = {};
    let imported = 0, skipped = 0;
    for (const p of obj.problems) {
      const sid = p && p.sessionId != null ? String(p.sessionId).trim() : '';
      const o1 = int(p && p.operand1), o2 = int(p && p.operand2), ca = int(p && p.correctAnswer);
      if (!sid || !isOp(p.operation) || o1 === null || o2 === null || ca === null) { skipped++; continue; }
      (probsBySid[sid] = probsBySid[sid] || []).push({
        sessionId: sid, timestamp: int(p.timestamp, 0), operation: p.operation,
        operand1: o1, operand2: o2, correctAnswer: ca, userAnswer: int(p.userAnswer, ca),
        wasCorrect: !!p.wasCorrect, msToAnswer: Math.max(0, int(p.msToAnswer, 0)),
      });
      imported++;
    }
    const sessions = [], used = new Set();
    for (const s of obj.sessions) {
      const sid = s && s.sessionId != null ? String(s.sessionId).trim() : '';
      if (!sid || used.has(sid)) continue;
      used.add(sid);
      sessions.push(Object.assign({}, s, { sessionId: sid, problems: probsBySid[sid] || [] }));
    }
    const looseProblems = [];
    for (const sid in probsBySid) if (!used.has(sid)) for (const p of probsBySid[sid]) looseProblems.push(p);
    return { ok: true, error: '', sessions, looseProblems, progress: normalizeProgress(obj.progress), imported, skipped };
  }

  /* Non-destructive progress merge: keep the better of each side, so restoring a
     backup never lowers XP/freezes or drops a freeze-day or a faster gauntlet. */
  function mergeProgress(cur, inc) {
    cur = normalizeProgress(cur); inc = normalizeProgress(inc);
    const freezeDays = Object.assign({}, cur.freezeDays);
    for (const k in inc.freezeDays) if (inc.freezeDays[k]) freezeDays[k] = true;
    const gauntletClears = Object.assign({}, cur.gauntletClears);
    for (const k in inc.gauntletClears) {
      const v = inc.gauntletClears[k];
      if (gauntletClears[k] == null || v < gauntletClears[k]) gauntletClears[k] = v;
    }
    const gauntletMedals = Object.assign({}, cur.gauntletMedals);
    for (const k in inc.gauntletMedals) {                 // keep the higher-ranked medal per day
      const v = inc.gauntletMedals[k];
      if ((MEDAL_RANK[v] || 0) > (MEDAL_RANK[gauntletMedals[k]] || 0)) gauntletMedals[k] = v;
    }
    const trophies = Object.assign({}, cur.trophies);
    for (const k in inc.trophies) {                       // union; keep the EARLIER earn time
      const v = inc.trophies[k];
      if (v == null) continue;
      if (trophies[k] == null || v < trophies[k]) trophies[k] = v;
    }
    const probs = Math.max(cur.stats.probs, inc.stats.probs);   // best-effort; Trophy Case recomputes from a full scan
    const fastestMs = [cur.stats.fastestMs, inc.stats.fastestMs].filter(x => x > 0).sort((a, b) => a - b)[0] || 0;
    return {
      xp: Math.max(cur.xp, inc.xp), xpLifetime: Math.max(cur.xpLifetime, inc.xpLifetime),
      freezes: Math.max(cur.freezes, inc.freezes), freezesBought: Math.max(cur.freezesBought || 0, inc.freezesBought || 0),
      freezeDays, gauntletClears, gauntletMedals,
      survivalBest: Math.max(cur.survivalBest, inc.survivalBest),
      trophies, trophiesSeenAt: Math.max(cur.trophiesSeenAt, inc.trophiesSeenAt),
      stats: { probs, fastestMs }, v: 1,
    };
  }

  /* Nudge to back up when there are games played since the last backup and it's
     been a while — but not while a dismissal snooze is still active. Pure: the
     caller passes `now`, the staleness window, and the stored backup state. */
  function shouldBackupNudge(sessions, state, now, staleMs) {
    state = state || {};
    if (!sessions || !sessions.length) return false;
    if (state.snoozeUntil && now < state.snoozeUntil) return false;
    const last = state.lastBackupAt || 0;
    const hasUnbacked = sessions.some(s => new Date(s.endedAt).getTime() > last);
    return hasUnbacked && (now - last) >= staleMs;   // last=0 (never) is always stale
  }

  /* ---- html escaping ----
     Escape the five HTML-significant characters. The UI builds markup with
     innerHTML; stored strings that can carry arbitrary text — a session's
     sessionId / presetName, which CSV & JSON import accept verbatim — must pass
     through this before interpolation, or an imported file could inject markup. */
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  return {
    PLUS, MINUS, TIMES, DIV, OP_ORDER,
    DAILY_GOAL, FREEZE_COST, MAX_FREEZES,
    GAUNTLET_SIZE, GAUNTLET_REWARD, GAUNTLET_WINDOW_DAYS,
    SURVIVAL_START_MS, SURVIVAL_FLOOR_MS, SURVIVAL_STEP_MS, survivalTimeLimit, recordSurvival,
    dayKey, parseKey, addDays,
    answerFor, canonFact, factKey, genProblem,
    dayCounts, daySatisfied, currentStreak, bestStreak, reconcileFreezes,
    defaultProgress, normalizeProgress, xpForSession, awardXp, canBuyFreeze, buyFreeze,
    COMBO_STEP, COMBO_BONUS, COMBO_MAX, DIFF_MIN, DIFF_MAX,
    comboMultiplier, comboBreakdown, difficultyWeight, sessionXp, sessionXpInfo, survivalXp,
    pickGhost, ghostScoreAt, ghostMeter, timeRingState, GHOST_METER_RANGE,
    gridFactors, masteryBaseline, cellLevel, masteryGrid,
    cellFreshness, masteryView, masteryProgress, MASTERY_FRESH_DAYS, MASTERY_STALE_DAYS,
    opStats, accuracy, computeWeakFacts,
    recentProblems, buildGauntlet, gauntletStreak, recordGauntletClear, shuffle,
    gauntletPar, medalForTime, medalTargets, medalCounts, MEDAL_RANK, MEDAL_TIERS, MEDAL_XP,
    RANKS, rankForXp, bestGauntletStreak,
    TROPHY, TROPHY_DEFS, TROPHY_TOTAL, TROPHY_BY_ID, evaluateTrophies, reconcileTrophies, trophyCounts,
    parseCSV, buildImport, parseBackup, mergeProgress, shouldBackupNudge, escapeHTML,
  };
});
