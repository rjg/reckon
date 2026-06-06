'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Z = require('../app-logic.js');

const { PLUS, MINUS, TIMES, DIV } = Z;

/* ---- helpers ---- */
// build a sessions array: N games on each given dayKey
function sessionsForDays(spec) {            // spec: { '2026-05-20': 5, ... }
  const out = [];
  for (const k of Object.keys(spec)) {
    const [y, m, d] = k.split('-').map(Number);
    for (let i = 0; i < spec[k]; i++)
      out.push({ endedAt: new Date(y, m - 1, d, 12, i).toISOString() });
  }
  return out;
}
const D = (y, m, d) => new Date(y, m - 1, d, 18, 0); // a fixed "today" at 6pm local

/* ===================== date helpers ===================== */
test('dayKey / addDays / parseKey roundtrip', () => {
  assert.equal(Z.dayKey(new Date(2026, 4, 9)), '2026-05-09');           // zero-pad month/day
  assert.equal(Z.dayKey(Z.addDays(new Date(2026, 0, 31), 1)), '2026-02-01'); // month rollover
  assert.equal(Z.dayKey(Z.parseKey('2026-12-25')), '2026-12-25');
});

/* ===================== fact folding ===================== */
test('canonFact folds +,× but preserves order for −,÷', () => {
  assert.equal(Z.factKey({ operation: TIMES, operand1: 7, operand2: 5 }),
               Z.factKey({ operation: TIMES, operand1: 5, operand2: 7 }));
  assert.notEqual(Z.factKey({ operation: DIV, operand1: 56, operand2: 7 }),
                  Z.factKey({ operation: DIV, operand1: 56, operand2: 8 }));
});

/* ===================== streak ===================== */
test('currentStreak counts consecutive met days, today-in-progress is forgiving', () => {
  const counts = Z.dayCounts(sessionsForDays({
    '2026-05-27': 5, '2026-05-28': 6, '2026-05-29': 2, // today only partial
  }));
  // today (29th) not met yet, but streak through 27-28 still stands
  assert.equal(Z.currentStreak(counts, {}, 5, D(2026, 5, 29)), 2);
  // once today is met it extends
  const counts2 = Z.dayCounts(sessionsForDays({
    '2026-05-27': 5, '2026-05-28': 6, '2026-05-29': 5,
  }));
  assert.equal(Z.currentStreak(counts2, {}, 5, D(2026, 5, 29)), 3);
});

test('currentStreak breaks on a fully missed day', () => {
  const counts = Z.dayCounts(sessionsForDays({
    '2026-05-26': 5, '2026-05-28': 5, '2026-05-29': 5, // 27th missed
  }));
  assert.equal(Z.currentStreak(counts, {}, 5, D(2026, 5, 29)), 2); // only 28,29
});

test('bestStreak finds the longest historical run', () => {
  const counts = Z.dayCounts(sessionsForDays({
    '2026-05-01': 5, '2026-05-02': 5, '2026-05-03': 5, // run of 3
    '2026-05-10': 5, '2026-05-11': 5,                   // run of 2
  }));
  assert.equal(Z.bestStreak(counts, {}, 5), 3);
});

test('frozen days count toward both current and best streak', () => {
  const counts = Z.dayCounts(sessionsForDays({
    '2026-05-27': 5, '2026-05-29': 5, // 28th missed but frozen
  }));
  const freezeDays = { '2026-05-28': true };
  assert.equal(Z.currentStreak(counts, freezeDays, 5, D(2026, 5, 29)), 3);
  assert.equal(Z.bestStreak(counts, freezeDays, 5), 3);
});

/* ===================== freeze reconciliation ===================== */
test('reconcile spends a freeze to bridge a single missed day', () => {
  const counts = Z.dayCounts(sessionsForDays({
    '2026-05-27': 5,                 // prior streak
    '2026-05-29': 5,                 // today met; 28th missed
  }));
  const progress = { freezes: 1, freezeDays: {} };
  const spent = Z.reconcileFreezes(counts, progress, D(2026, 5, 29), 5);
  assert.equal(spent, 1);
  assert.equal(progress.freezes, 0);
  assert.ok(progress.freezeDays['2026-05-28']);
  assert.equal(Z.currentStreak(counts, progress.freezeDays, 5, D(2026, 5, 29)), 3);
});

test('reconcile does NOT waste a freeze on an unbridgeable 2-day gap', () => {
  const counts = Z.dayCounts(sessionsForDays({
    '2026-05-26': 5,                 // prior streak
    '2026-05-29': 5,                 // 27 & 28 both missed
  }));
  const progress = { freezes: 1, freezeDays: {} };          // only one freeze
  const spent = Z.reconcileFreezes(counts, progress, D(2026, 5, 29), 5);
  assert.equal(spent, 0);                                   // can't bridge two with one
  assert.equal(progress.freezes, 1);                        // freeze preserved
  assert.deepEqual(progress.freezeDays, {});
});

test('reconcile bridges a 2-day gap when two freezes are held', () => {
  const counts = Z.dayCounts(sessionsForDays({
    '2026-05-26': 5, '2026-05-29': 5,
  }));
  const progress = { freezes: 2, freezeDays: {} };
  const spent = Z.reconcileFreezes(counts, progress, D(2026, 5, 29), 5);
  assert.equal(spent, 2);
  assert.equal(progress.freezes, 0);
  assert.equal(Z.currentStreak(counts, progress.freezeDays, 5, D(2026, 5, 29)), 4);
});

test('reconcile never touches today and never invents a streak from nothing', () => {
  const counts = Z.dayCounts(sessionsForDays({ '2026-05-29': 2 })); // only a partial today
  const progress = { freezes: 2, freezeDays: {} };
  const spent = Z.reconcileFreezes(counts, progress, D(2026, 5, 29), 5);
  assert.equal(spent, 0);
  assert.equal(progress.freezes, 2);
});

test('reconcile is idempotent across repeated renders the same day', () => {
  const counts = Z.dayCounts(sessionsForDays({ '2026-05-27': 5, '2026-05-29': 5 }));
  const progress = { freezes: 1, freezeDays: {} };
  Z.reconcileFreezes(counts, progress, D(2026, 5, 29), 5);
  const after = { freezes: progress.freezes, freezeDays: { ...progress.freezeDays } };
  Z.reconcileFreezes(counts, progress, D(2026, 5, 29), 5);   // run again
  assert.equal(progress.freezes, after.freezes);
  assert.deepEqual(progress.freezeDays, after.freezeDays);
});

/* ===================== XP / freezes ===================== */
test('xpForSession is the score; awardXp tracks balance + lifetime', () => {
  const p = Z.defaultProgress();
  assert.equal(Z.xpForSession({ score: 42 }), 42);
  Z.awardXp(p, 42); Z.awardXp(p, 8);
  assert.equal(p.xp, 50);
  assert.equal(p.xpLifetime, 50);
});

test('buyFreeze enforces cost (1000) and the max-held cap (2)', () => {
  const p = Z.defaultProgress();
  p.xp = 900;
  assert.equal(Z.canBuyFreeze(p), false);
  assert.equal(Z.buyFreeze(p), false);                 // too poor
  p.xp = 2500;
  assert.equal(Z.buyFreeze(p), true);
  assert.equal(p.xp, 1500); assert.equal(p.freezes, 1);
  assert.equal(Z.buyFreeze(p), true);
  assert.equal(p.xp, 500); assert.equal(p.freezes, 2);
  assert.equal(Z.canBuyFreeze(p), false);              // at cap, even if affordable
  p.xp = 5000;
  assert.equal(Z.buyFreeze(p), false);
  assert.equal(p.freezes, 2);
});

test('normalizeProgress repairs partial/garbage records', () => {
  assert.deepEqual(Z.normalizeProgress(null), Z.defaultProgress());
  const fixed = Z.normalizeProgress({ xp: -5, freezes: 9, freezeDays: null });
  assert.equal(fixed.xp, 0);
  assert.equal(fixed.freezes, Z.MAX_FREEZES);           // clamped to cap
  assert.deepEqual(fixed.freezeDays, {});
});

/* ===================== ghost ===================== */
test('pickGhost returns the best-rate session for the matching preset only', () => {
  const sessions = [
    { presetName: 'Normal', rate: 0.5, score: 60, sessionId: 'a' },
    { presetName: 'Normal', rate: 0.7, score: 84, sessionId: 'b' },
    { presetName: 'Fast', rate: 0.9, score: 54, sessionId: 'c' },
  ];
  assert.equal(Z.pickGhost(sessions, 'Normal').sessionId, 'b');
  assert.equal(Z.pickGhost(sessions, 'Hard'), null);
});

test('ghostScoreAt advances at a steady rate', () => {
  assert.equal(Z.ghostScoreAt(0.5, 10000), 5);   // 0.5/s for 10s
  assert.equal(Z.ghostScoreAt(0.5, 9000), 4);     // floors
  assert.equal(Z.ghostScoreAt(0, 10000), 0);
});

test('ghostMeter reports side + a 0..1 fraction that pins past the range', () => {
  assert.deepEqual(Z.ghostMeter(5, 5), { diff: 0, side: 'even', frac: 0 });
  const ahead = Z.ghostMeter(8, 5, 6);                 // +3 of 6 → half
  assert.equal(ahead.side, 'ahead');
  assert.equal(ahead.frac, 0.5);
  const behind = Z.ghostMeter(2, 5, 6);                // -3 of 6 → half, behind
  assert.equal(behind.side, 'behind');
  assert.equal(behind.frac, 0.5);
  assert.equal(Z.ghostMeter(20, 5, 6).frac, 1);        // big lead pins at full
  assert.equal(Z.ghostMeter(0, 9, 6).frac, 1);         // big deficit pins at full
});

test('timeRingState fraction scales to any length; level escalates at 20% / 8%', () => {
  assert.deepEqual(Z.timeRingState(60000, 120000), { frac: 0.5, level: 'ok' });
  assert.equal(Z.timeRingState(30000, 120000).level, 'ok');     // 25% → ok
  assert.equal(Z.timeRingState(24000, 120000).level, 'warn');   // 20% boundary → warn
  assert.equal(Z.timeRingState(12000, 120000).level, 'warn');   // 10% → warn
  assert.equal(Z.timeRingState(9000, 120000).level, 'crit');    // 7.5% → crit
  assert.equal(Z.timeRingState(-5, 120000).frac, 0);            // clamps at empty
  assert.equal(Z.timeRingState(5000, 0).frac, 0);               // guards totalMs=0
});

/* ===================== mastery grid ===================== */
test('masteryGrid folds ×, places by factor, and skips out-of-range facts', () => {
  const baseline = 1000;
  const problems = [
    { operation: TIMES, operand1: 7, operand2: 8, correctAnswer: 56, wasCorrect: true, msToAnswer: 900 },
    { operation: TIMES, operand1: 8, operand2: 7, correctAnswer: 56, wasCorrect: true, msToAnswer: 1100 }, // folds with above
    { operation: TIMES, operand1: 7, operand2: 50, correctAnswer: 350, wasCorrect: true, msToAnswer: 900 }, // 50 > maxN -> skipped
  ];
  const g = Z.masteryGrid(problems, TIMES, 12, baseline);
  const cell = g.cells[6][7]; // 7×8 -> indices 6,7
  assert.equal(cell.count, 2);
  assert.equal(cell.correct, 2);
  assert.equal(g.cells[6][6], null); // nothing at 7×7
});

test('masteryGrid maps ÷ onto divisor/quotient and grades levels', () => {
  // 56 ÷ 7 = 8  -> factors (7,8); fast & accurate -> strong
  const problems = [];
  for (let i = 0; i < 5; i++)
    problems.push({ operation: DIV, operand1: 56, operand2: 7, correctAnswer: 8, wasCorrect: true, msToAnswer: 800 });
  const g = Z.masteryGrid(problems, DIV, 12, 1000);
  const cell = g.cells[6][7]; // (7,8)
  assert.equal(cell.count, 5);
  assert.equal(cell.level, 3); // accuracy 1.0, avg 800 <= 1.3*1000
});

test('cellLevel grades weak (inaccurate or slow), ok, strong', () => {
  assert.equal(Z.cellLevel({ count: 0 }, 1000), 0);
  assert.equal(Z.cellLevel({ count: 5, correct: 2, totalMs: 1600 }, 1000), 1); // 40% accuracy
  assert.equal(Z.cellLevel({ count: 5, correct: 5, totalMs: 15000 }, 1000), 1); // avg 3000 > 2x baseline
  assert.equal(Z.cellLevel({ count: 5, correct: 5, totalMs: 4000 }, 1000), 3);  // avg 800, perfect
  assert.equal(Z.cellLevel({ count: 5, correct: 4, totalMs: 4800 }, 1000), 2);  // 80% acc, avg 1200 -> ok
});

/* ===================== mastery decay ("garden you tend") ===================== */
const DAY = 86400000;

test('masteryGrid records minMs (fastest correct) and lastTs (most recent attempt)', () => {
  const problems = [
    { operation: TIMES, operand1: 7, operand2: 8, correctAnswer: 56, wasCorrect: true,  msToAnswer: 1500, timestamp: 1000 },
    { operation: TIMES, operand1: 8, operand2: 7, correctAnswer: 56, wasCorrect: true,  msToAnswer: 900,  timestamp: 5000 }, // folds; faster + later
    { operation: TIMES, operand1: 7, operand2: 8, correctAnswer: 56, wasCorrect: false, msToAnswer: 4000, timestamp: 9000 }, // wrong: refreshes recency, not minMs
  ];
  const cell = Z.masteryGrid(problems, TIMES, 12, 1000).cells[6][7];
  assert.equal(cell.minMs, 900);   // fastest CORRECT only
  assert.equal(cell.lastTs, 9000); // ANY attempt (even a miss) counts as practiced
});

test('cellFreshness ramps 1 inside the grace window down to 0 at the stale horizon', () => {
  const now = 100 * DAY;
  assert.equal(Z.cellFreshness(0, now).stage, 'none');                          // never practiced
  const fresh = Z.cellFreshness(now - 3 * DAY, now, 7, 21);
  assert.equal(fresh.stage, 'fresh'); assert.equal(fresh.frac, 1);
  assert.equal(Z.cellFreshness(now - 7 * DAY, now, 7, 21).stage, 'fresh');      // edge of grace is still fresh
  const aging = Z.cellFreshness(now - 14 * DAY, now, 7, 21);                    // halfway: (14-7)/(21-7)=0.5
  assert.equal(aging.stage, 'aging'); assert.equal(aging.frac.toFixed(2), '0.50');
  const stale = Z.cellFreshness(now - 30 * DAY, now, 7, 21);
  assert.equal(stale.stage, 'stale'); assert.equal(stale.frac, 0);
});

test('masteryView fades ONLY strong cells: green → amber → needs-tending', () => {
  const now = 100 * DAY;
  const strong = lastTs => ({ level: 3, lastTs });
  // fresh strong: stays green, no decay
  let v = Z.masteryView(strong(now - 2 * DAY), now, { freshDays: 7, staleDays: 21 });
  assert.equal(v.displayLevel, 3); assert.equal(v.decay, 0); assert.equal(v.tending, false);
  // aging strong: STILL counts as strong (display 3) but decay is partway (paints toward amber)
  v = Z.masteryView(strong(now - 14 * DAY), now, { freshDays: 7, staleDays: 21 });
  assert.equal(v.displayLevel, 3); assert.ok(v.decay > 0 && v.decay < 1); assert.equal(v.tending, false);
  // stale strong: demoted to amber (display 2), flagged tending, fully decayed
  v = Z.masteryView(strong(now - 30 * DAY), now, { freshDays: 7, staleDays: 21 });
  assert.equal(v.displayLevel, 2); assert.equal(v.decay, 1); assert.equal(v.tending, true);
  // defaults (7/21) are used when no opts passed: 10 days → aging
  assert.equal(Z.masteryView(strong(now - 10 * DAY), now).stage, 'aging');
});

test('masteryView leaves ok/weak/unseen untouched, and never wilts un-timestamped data', () => {
  const now = 100 * DAY;
  assert.equal(Z.masteryView({ level: 2, lastTs: now - 60 * DAY }, now).displayLevel, 2); // ok: no decay
  assert.equal(Z.masteryView({ level: 1, lastTs: now - 60 * DAY }, now).displayLevel, 1); // weak: no decay
  assert.equal(Z.masteryView(null, now).displayLevel, 0);                                 // unseen
  // a strong cell with no timestamp (pre-decay imported data) can't be aged → stays green
  const v = Z.masteryView({ level: 3, lastTs: 0 }, now);
  assert.equal(v.displayLevel, 3); assert.equal(v.decay, 0); assert.equal(v.tending, false);
});

/* ===================== opStats ===================== */
test('opStats aggregates per op, in OP_ORDER, skipping ops with no data', () => {
  const problems = [
    { operation: PLUS, msToAnswer: 1000, wasCorrect: true },
    { operation: PLUS, msToAnswer: 3000, wasCorrect: false },
    { operation: TIMES, msToAnswer: 2000, wasCorrect: true },
  ];
  const rows = Z.opStats(problems);
  assert.deepEqual(rows.map(r => r.op), [PLUS, TIMES]); // MINUS/DIV absent, order preserved
  const add = rows[0];
  assert.equal(add.count, 2);
  assert.equal(add.errors, 1);
  assert.equal(add.avgMs, 2000); // (1000+3000)/2
});

test('opStats flags the single slowest operation (first wins on a tie)', () => {
  const problems = [
    { operation: PLUS, msToAnswer: 1000, wasCorrect: true },
    { operation: TIMES, msToAnswer: 5000, wasCorrect: true },
    { operation: DIV, msToAnswer: 5000, wasCorrect: true },
  ];
  const rows = Z.opStats(problems);
  const slowest = rows.filter(r => r.slowest);
  assert.equal(slowest.length, 1);
  assert.equal(slowest[0].op, TIMES); // ties broken by OP_ORDER (× before ÷)
});

test('opStats on no problems is an empty list', () => {
  assert.deepEqual(Z.opStats([]), []);
});

/* ===================== accuracy ===================== */
test('accuracy counts first-try solves and rounds the percent', () => {
  const problems = [
    { wasCorrect: true }, { wasCorrect: true }, { wasCorrect: true },
    { wasCorrect: false },   // solved, but only after a wrong attempt
  ];
  assert.deepEqual(Z.accuracy(problems), { correct: 3, total: 4, pct: 75 });
});

test('accuracy on no problems is 0/0 → 0% (no divide-by-zero)', () => {
  assert.deepEqual(Z.accuracy([]), { correct: 0, total: 0, pct: 0 });
});

test('accuracy is 100% when every solve was clean', () => {
  const problems = [{ wasCorrect: true }, { wasCorrect: true }];
  assert.deepEqual(Z.accuracy(problems), { correct: 2, total: 2, pct: 100 });
});

/* ===================== computeWeakFacts ===================== */
test('computeWeakFacts ranks misses and slow facts above fast/accurate ones', () => {
  const fact = (op, o1, o2, ok, ms) =>
    ({ operation: op, operand1: o1, operand2: o2, wasCorrect: ok, msToAnswer: ms });
  const key = f => f.operation + ':' + f.operand1 + ':' + f.operand2;
  const problems = [
    // 7×8: fast and always right -> should rank LAST
    fact(TIMES, 7, 8, true, 800), fact(TIMES, 7, 8, true, 900),
    // 6×9: solved but slow -> a weak fact
    fact(TIMES, 6, 9, true, 4000), fact(TIMES, 6, 9, true, 4200),
    // 8×8: high miss rate -> a weak fact
    fact(TIMES, 8, 8, false, 0), fact(TIMES, 8, 8, true, 1500), fact(TIMES, 8, 8, false, 0),
  ];
  const weak = Z.computeWeakFacts(problems, 10);
  // both the slow fact and the missed fact outrank the fast/accurate one
  assert.equal(key(weak[weak.length - 1]), '×:7:8');
  assert.deepEqual(new Set([key(weak[0]), key(weak[1])]), new Set(['×:6:9', '×:8:8']));
  // correctAnswer is filled in for the challenge pool to reuse
  const m78 = weak.find(f => f.operand1 === 7 && f.operand2 === 8);
  assert.equal(m78.correctAnswer, 56);
});

test('computeWeakFacts folds commutative facts and skips singletons', () => {
  const fact = (op, o1, o2, ok, ms) =>
    ({ operation: op, operand1: o1, operand2: o2, wasCorrect: ok, msToAnswer: ms });
  const problems = [
    fact(TIMES, 7, 8, true, 1000),  // folds with 8×7 -> count 2, kept
    fact(TIMES, 8, 7, true, 1200),
    fact(TIMES, 3, 4, true, 1000),  // seen once -> skipped
  ];
  const weak = Z.computeWeakFacts(problems, 10);
  assert.equal(weak.length, 1);
  assert.equal(weak[0].operand1, 7);
  assert.equal(weak[0].operand2, 8);
  assert.equal(weak[0]._count, 2);
});

test('computeWeakFacts returns [] when nothing has been solved correctly', () => {
  const problems = [
    { operation: PLUS, operand1: 2, operand2: 3, wasCorrect: false, msToAnswer: 0 },
    { operation: PLUS, operand1: 2, operand2: 3, wasCorrect: false, msToAnswer: 0 },
  ];
  assert.deepEqual(Z.computeWeakFacts(problems, 10), []);
});

test('computeWeakFacts honors the topN cap', () => {
  const problems = [];
  for (let n = 2; n <= 9; n++)              // 8 distinct facts, each seen twice
    for (let i = 0; i < 2; i++)
      problems.push({ operation: TIMES, operand1: 2, operand2: n, wasCorrect: true, msToAnswer: 1000 * n });
  const weak = Z.computeWeakFacts(problems, 3);
  assert.equal(weak.length, 3);
});

/* ===================== genProblem (invariants) ===================== */
test('genProblem always yields a well-formed, in-range, exactly-solvable problem', () => {
  // a wide config that exercises every op and a range that admits 1
  const cfg = {
    ops: { add: true, sub: true, mul: true, div: true },
    add: { min1: 2, max1: 100, min2: 2, max2: 100 },
    mul: { min1: 2, max1: 12, min2: 2, max2: 100 },
  };
  // deterministic PRNG so a failure is reproducible (mulberry32)
  let s = 0x9e3779b9;
  const rng = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 5000; i++) {
    const p = Z.genProblem(cfg, rng);
    // answer matches the stated operation
    assert.equal(Z.answerFor(p.operation, p.operand1, p.operand2), p.correctAnswer);
    // never a negative subtraction
    if (p.operation === MINUS) assert.ok(p.operand1 >= p.operand2, `negative sub: ${p.display}`);
    // division is always exact and integer
    if (p.operation === DIV) {
      assert.ok(Number.isInteger(p.correctAnswer), `non-integer div: ${p.display}`);
      assert.equal(p.operand1 % p.operand2, 0, `inexact div: ${p.display}`);
    }
    // display reads "o1 op o2"
    assert.equal(p.display, p.operand1 + ' ' + p.operation + ' ' + p.operand2);
  }
});

test('genProblem only emits enabled operations', () => {
  const cfg = {
    ops: { add: false, sub: false, mul: true, div: false },
    add: { min1: 1, max1: 9, min2: 1, max2: 9 },
    mul: { min1: 2, max1: 9, min2: 2, max2: 9 },
  };
  let i = 0;
  const rng = () => ((i++ * 0.137) % 1); // cheap spread across [0,1)
  for (let n = 0; n < 200; n++) assert.equal(Z.genProblem(cfg, rng).operation, TIMES);
});

test('genProblem never divides by zero even when the mul range admits 0', () => {
  // the input layer accepts min >= 0, so a 0-inclusive mul range must not
  // produce a 0 / 0 (or anything / 0) problem with a bogus stored answer
  const cfg = {
    ops: { add: false, sub: false, mul: false, div: true },
    add: { min1: 1, max1: 9, min2: 1, max2: 9 },
    mul: { min1: 0, max1: 0, min2: 2, max2: 4 },
  };
  let i = 0;
  const rng = () => ((i++ * 0.137) % 1);
  for (let n = 0; n < 500; n++) {
    const p = Z.genProblem(cfg, rng);
    assert.equal(p.operation, DIV);
    assert.ok(p.operand2 >= 1, `divisor < 1: ${p.display}`);
    // the stored answer must be the true quotient, not an unrelated factor
    assert.equal(Z.answerFor(p.operation, p.operand1, p.operand2), p.correctAnswer, `bad div: ${p.display}`);
    assert.ok(Number.isInteger(p.correctAnswer), `non-integer div: ${p.display}`);
  }
});

test('genProblem returns null when no operation is enabled (no silent fallthrough)', () => {
  const cfg = {
    ops: { add: false, sub: false, mul: false, div: false },
    add: { min1: 1, max1: 9, min2: 1, max2: 9 },
    mul: { min1: 1, max1: 9, min2: 1, max2: 9 },
  };
  assert.equal(Z.genProblem(cfg, Math.random), null);   // not a bogus division
});

/* ---- daily gauntlet ---- */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// problem records for one fact: specs is an array of [ms, wasCorrect]
function recsFor(op, o1, o2, specs, baseTs) {
  return specs.map(([ms, ok], i) => ({
    operation: op, operand1: o1, operand2: o2, correctAnswer: Z.answerFor(op, o1, o2),
    wasCorrect: ok, msToAnswer: ms, timestamp: (baseTs || 2e12) - 1000 * i,
  }));
}

test('recentProblems keeps only problems within the window', () => {
  const now = 1e12, day = 86400000;
  const all = [{ timestamp: now }, { timestamp: now - 1 * day },
               { timestamp: now - 10 * day }, { timestamp: now - 30 * day }];
  assert.equal(Z.recentProblems(all, now, 21).length, 3);   // drops the 30-day-old one
  assert.equal(Z.recentProblems(all, now, 0).length, 4);    // no window
  assert.equal(Z.recentProblems([], now, 21).length, 0);
});

test('buildGauntlet returns SIZE well-formed facts, weak ones included', () => {
  const now = 2e12;
  let hist = [];
  hist = hist.concat(recsFor(TIMES, 7, 8, [[3200, true], [3400, false], [3100, true], [3300, true]], now));
  hist = hist.concat(recsFor(DIV, 56, 7, [[3000, true], [3200, true], [3500, false], [3100, true]], now));
  hist = hist.concat(recsFor(PLUS, 47, 38, [[2800, true], [2900, true], [3000, true]], now));
  for (let a = 2; a <= 9; a++) hist = hist.concat(recsFor(PLUS, a, a + 1, [[700, true], [720, true], [680, true]], now));
  const set = Z.buildGauntlet(hist, now, mulberry32(20260601));
  assert.equal(set.length, Z.GAUNTLET_SIZE);
  for (const f of set) assert.equal(Z.answerFor(f.operation, f.operand1, f.operand2), f.correctAnswer, f.display);
  const keys = new Set(set.map(Z.factKey));
  assert.ok(keys.has(Z.factKey({ operation: TIMES, operand1: 7, operand2: 8 })), '7×8 missing');
  assert.ok(keys.has(Z.factKey({ operation: DIV, operand1: 56, operand2: 7 })), '56÷7 missing');
});

test('buildGauntlet tops up to SIZE on thin history (cold start), deterministically', () => {
  const now = 2e12;
  const set = Z.buildGauntlet([], now, mulberry32(42));
  assert.equal(set.length, Z.GAUNTLET_SIZE);
  for (const f of set) assert.equal(Z.answerFor(f.operation, f.operand1, f.operand2), f.correctAnswer, f.display);
  const a = Z.buildGauntlet([], now, mulberry32(7)).map(f => f.display);
  const b = Z.buildGauntlet([], now, mulberry32(7)).map(f => f.display);
  assert.deepEqual(a, b);   // same seed → same set
});

test('buildGauntlet is unchanged by pre-filtering history to its window', () => {
  // guards the perf change: the home screen now queries only the recent window
  // (getProblemsSince) instead of all history — must yield the identical set
  const now = 2e12, day = 86400000;
  let hist = [];
  hist = hist.concat(recsFor(TIMES, 7, 8, [[3200, true], [3400, false], [3100, true], [3300, true]], now));
  hist = hist.concat(recsFor(DIV, 56, 7, [[3000, true], [3200, true], [3500, false], [3100, true]], now));
  for (let a = 2; a <= 9; a++) hist = hist.concat(recsFor(PLUS, a, a + 1, [[700, true], [720, true], [680, true]], now));
  const old = recsFor(MINUS, 90, 40, [[5000, false], [5200, false]], now - 40 * day); // outside the window
  const all = hist.concat(old);
  const recent = Z.recentProblems(all, now, Z.GAUNTLET_WINDOW_DAYS);
  const fromAll = Z.buildGauntlet(all, now, mulberry32(20260601)).map(f => f.display);
  const fromRecent = Z.buildGauntlet(recent, now, mulberry32(20260601)).map(f => f.display);
  assert.deepEqual(fromRecent, fromAll);   // bounding the DB query to the window changes nothing
});

test('shuffle is an in-place permutation, deterministic under a seeded rng', () => {
  const src = [10, 20, 30, 40, 50, 60, 70, 80];
  const a = Z.shuffle(src.slice(), mulberry32(123));
  const b = Z.shuffle(src.slice(), mulberry32(123));
  assert.deepEqual(a, b);                                  // same seed -> same order
  assert.deepEqual(a.slice().sort((x, y) => x - y), src);  // same elements, none lost or added
  const c = Z.shuffle(src.slice(), mulberry32(999));
  assert.notDeepEqual(a, c);                               // different seed -> different order
  const arr = [1, 2, 3];
  assert.equal(Z.shuffle(arr), arr);                       // shuffles in place, returns the array
  assert.deepEqual(Z.shuffle([]), []);                     // empty is fine
  assert.deepEqual(Z.shuffle([9]), [9]);                   // single element unchanged
});

test('buildGauntlet selects deterministically (order no longer seeded; shuffled per run)', () => {
  const now = 2e12;
  const a = Z.buildGauntlet([], now, mulberry32(7));
  const b = Z.buildGauntlet([], now, mulberry32(7));
  const keyset = s => new Set(s.map(Z.factKey));
  assert.deepEqual([...keyset(a)].sort(), [...keyset(b)].sort());  // same seed -> same SET
  assert.equal(a.length, Z.GAUNTLET_SIZE);
});

test('gauntletStreak counts consecutive cleared days; today-in-progress does not break', () => {
  const k = (y, m, d) => Z.dayKey(new Date(y, m - 1, d));
  const today = D(2026, 5, 20);
  assert.equal(Z.gauntletStreak({ [k(2026,5,18)]:1, [k(2026,5,19)]:1, [k(2026,5,20)]:1 }, today), 3);
  assert.equal(Z.gauntletStreak({ [k(2026,5,17)]:1, [k(2026,5,18)]:1, [k(2026,5,19)]:1 }, today), 3); // today not done yet
  assert.equal(Z.gauntletStreak({ [k(2026,5,18)]:1, [k(2026,5,20)]:1 }, today), 1);                  // gap breaks it
  assert.equal(Z.gauntletStreak({}, today), 0);
  assert.equal(Z.gauntletStreak(null, today), 0);
});

test('recordGauntletClear awards once per day and tracks the best time', () => {
  const p = Z.defaultProgress(), key = '2026-05-20';
  let r = Z.recordGauntletClear(p, key, 30000);
  assert.deepEqual([r.firstToday, r.improved, r.reward, r.best], [true, true, Z.GAUNTLET_REWARD, 30000]);
  assert.equal(p.xp, Z.GAUNTLET_REWARD);
  r = Z.recordGauntletClear(p, key, 40000);                 // slower retry
  assert.deepEqual([r.firstToday, r.improved, r.reward, r.best], [false, false, 0, 30000]);
  assert.equal(p.xp, Z.GAUNTLET_REWARD);                    // no extra XP
  r = Z.recordGauntletClear(p, key, 25000);                 // faster retry
  assert.deepEqual([r.improved, r.reward, r.best], [true, 0, 25000]);
  assert.equal(p.gauntletClears[key], 25000);
});

test('progress carries gauntletClears through default + normalize', () => {
  assert.deepEqual(Z.defaultProgress().gauntletClears, {});
  assert.deepEqual(Z.normalizeProgress(null).gauntletClears, {});
  assert.deepEqual(Z.normalizeProgress({ gauntletClears: 'bad' }).gauntletClears, {});
  const keep = { '2026-05-20': 25000 };
  assert.deepEqual(Z.normalizeProgress({ gauntletClears: keep }).gauntletClears, keep);
});

/* ---- gauntlet par & medals ---- */
test('gauntletPar sums per-fact expected times: history median where known, weak default else', () => {
  const probs = recsFor(TIMES, 7, 8, [[3000, true], [3100, true], [3200, true]]);  // baseline = median = 3100
  const facts = [{ operation: TIMES, operand1: 7, operand2: 8 },   // in history
                 { operation: PLUS, operand1: 99, operand2: 99 }]; // not -> weak default
  const par = Z.gauntletPar(facts, probs);
  assert.equal(par.baseline, 3100);
  assert.deepEqual([par.perFact[0].from, par.perFact[0].expMs], ['history', 3100]);
  assert.deepEqual([par.perFact[1].from, par.perFact[1].expMs], ['default', 4650]); // 1.5 × 3100
  assert.equal(par.parMs, 7750);
});

test('gauntletPar clamps each fact and cold-starts cleanly on empty history', () => {
  const tiny = recsFor(TIMES, 2, 2, [[100, true], [120, true]]);  // median 120 -> floored
  const par = Z.gauntletPar([{ operation: TIMES, operand1: 2, operand2: 2 }], tiny);
  assert.equal(par.perFact[0].expMs, 700);                        // PAR_FACT_FLOOR
  const cold = Z.gauntletPar(                                     // no history at all
    [{ operation: TIMES, operand1: 6, operand2: 7 }, { operation: DIV, operand1: 42, operand2: 6 }], []);
  assert.equal(cold.baseline, 2500);                              // PAR_DEFAULT_BASELINE
  assert.equal(cold.parMs, 7500);                                 // 2 × (2500 × 1.5)
});

test('medalForTime grades a clear against par', () => {
  const par = 10000;
  assert.equal(Z.medalForTime(8000, par), 'gold');     // <= 0.80 × par (par −20%), inclusive
  assert.equal(Z.medalForTime(8001, par), 'silver');
  assert.equal(Z.medalForTime(10000, par), 'silver');  // <= par (beat par), inclusive
  assert.equal(Z.medalForTime(10001, par), 'bronze');
  assert.equal(Z.medalForTime(5000, 0), 'bronze');     // no usable par -> a clear is bronze
  assert.deepEqual(Z.medalTargets(10000), { silver: 10000, gold: 8000 });
  assert.deepEqual(Z.medalTargets(0), { silver: 0, gold: 0 });
});

test('medalCounts tallies the per-day best-medal map', () => {
  const m = { d1: 'gold', d2: 'silver', d3: 'gold', d4: 'bronze' };
  assert.deepEqual(Z.medalCounts(m), { gold: 2, silver: 1, bronze: 1, total: 4 });
  assert.deepEqual(Z.medalCounts({}), { gold: 0, silver: 0, bronze: 0, total: 0 });
  assert.deepEqual(Z.medalCounts(null), { gold: 0, silver: 0, bronze: 0, total: 0 });
});

test('recordGauntletClear tracks best medal and pays XP only for upgrades', () => {
  const p = Z.defaultProgress(), key = '2026-05-20';
  let r = Z.recordGauntletClear(p, key, 30000, 'bronze');         // first clear -> bronze
  assert.deepEqual([r.medal, r.medalImproved, r.reward], ['bronze', true, Z.MEDAL_XP.bronze]);
  assert.equal(p.xp, 30);
  r = Z.recordGauntletClear(p, key, 22000, 'gold');              // faster -> upgrade to gold
  assert.deepEqual([r.medal, r.prevMedal, r.medalImproved, r.reward],
    ['gold', 'bronze', true, Z.MEDAL_XP.gold - Z.MEDAL_XP.bronze]);
  assert.equal(p.xp, 75);                                         // 30 + 45, only the delta
  r = Z.recordGauntletClear(p, key, 21000, 'silver');            // best TIME but lower grade -> no downgrade/pay
  assert.deepEqual([r.medal, r.medalImproved, r.reward], ['gold', false, 0]);
  assert.equal(p.xp, 75);
  assert.equal(p.gauntletClears[key], 21000);                    // best time tracked independently of medal
});

test('progress carries gauntletMedals through default + normalize + merge', () => {
  assert.deepEqual(Z.defaultProgress().gauntletMedals, {});
  assert.deepEqual(Z.normalizeProgress(null).gauntletMedals, {});
  assert.deepEqual(Z.normalizeProgress({ gauntletMedals: 'bad' }).gauntletMedals, {});
  const keep = { '2026-05-20': 'gold' };
  assert.deepEqual(Z.normalizeProgress({ gauntletMedals: keep }).gauntletMedals, keep);
  const cur = { gauntletMedals: { d1: 'silver', d2: 'gold' } };
  const inc = { gauntletMedals: { d1: 'gold', d2: 'bronze', d3: 'silver' } };
  assert.deepEqual(Z.mergeProgress(cur, inc).gauntletMedals,      // keep the higher-ranked per day
    { d1: 'gold', d2: 'gold', d3: 'silver' });
});

/* ===================== CSV import ===================== */
const CSV_HEAD = ['sessionId', 'sessionDate', 'presetName', 'enabledOps', 'addRange', 'mulRange',
  'durationSec', 'operation', 'operand1', 'operand2', 'correctAnswer', 'userAnswer',
  'wasCorrect', 'msToAnswer', 'problemTimestamp'];

test('parseCSV handles BOM, CRLF, and quoted fields with commas/quotes', () => {
  const text = '﻿a,b,c\r\n1,"x,y","he said ""hi"""\r\n';
  const rows = Z.parseCSV(text);
  assert.equal(rows.length, 2);                 // trailing CRLF doesn't make an empty row
  assert.deepEqual(rows[0], ['a', 'b', 'c']);
  assert.deepEqual(rows[1], ['1', 'x,y', 'he said "hi"']);
});

test('buildImport rebuilds a session with derived score/rate/errors/config', () => {
  const end = '2026-05-20T18:02:00.000Z';
  const t0 = Date.parse('2026-05-20T18:00:00.000Z');
  const text = [
    CSV_HEAD.join(','),
    ['s1', end, 'Normal', 'add+sub+mul+div', '2-100;2-100', '2-12;2-100', '120',
      PLUS, '7', '8', '15', '15', 'true', '1200', new Date(t0).toISOString()].join(','),
    ['s1', end, 'Normal', 'add+sub+mul+div', '2-100;2-100', '2-12;2-100', '120',
      TIMES, '6', '9', '54', '50', 'false', '3000', new Date(t0 + 1200).toISOString()].join(','),
  ].join('\r\n');
  const res = Z.buildImport(Z.parseCSV(text));
  assert.equal(res.ok, true);
  assert.equal(res.sessions.length, 1);
  const s = res.sessions[0];
  assert.equal(s.sessionId, 's1');
  assert.equal(s.score, 2);
  assert.equal(s.errorCount, 1);
  assert.equal(s.durationSec, 120);
  assert.equal(s.elapsedMs, 120000);
  assert.ok(Math.abs(s.rate - 2 / 120) < 1e-9);
  assert.deepEqual(s.config.ops, { add: true, sub: true, mul: true, div: true });
  assert.deepEqual(s.config.add, { min1: 2, max1: 100, min2: 2, max2: 100 });
  assert.deepEqual(s.config.mul, { min1: 2, max1: 12, min2: 2, max2: 100 });
  assert.equal(s.problems.length, 2);
  assert.equal(s.problems[1].wasCorrect, false);
  assert.equal(s.problems[1].userAnswer, 50);
});

test('buildImport routes session-less rows to looseProblems and skips bad rows', () => {
  const ts = new Date(Date.parse('2026-05-20T18:00:00.000Z')).toISOString();
  const text = [
    CSV_HEAD.join(','),
    ['g1', '', '', '', '', '', '', DIV, '56', '7', '8', '8', 'true', '900', ts].join(','),   // gauntlet: no session
    ['s2', ts, 'Fast', 'add', '1-9;1-9', '1-9;1-9', '60', '?', '2', '3', '5', '5', 'true', '800', ts].join(','), // bad op
    ['s2', ts, 'Fast', 'add', '1-9;1-9', '1-9;1-9', '60', PLUS, 'x', '3', '5', '5', 'true', '800', ts].join(','), // bad operand
  ].join('\r\n');
  const res = Z.buildImport(Z.parseCSV(text));
  assert.equal(res.ok, true);
  assert.equal(res.sessions.length, 0);
  assert.equal(res.looseProblems.length, 1);
  assert.equal(res.looseProblems[0].operation, DIV);
  assert.equal(res.imported, 1);
  assert.equal(res.skipped, 2);
});

test('buildImport maps columns by name and rejects a non-Reckon CSV', () => {
  const head2 = ['problemTimestamp', 'operation', 'operand1', 'operand2', 'correctAnswer',
    'userAnswer', 'wasCorrect', 'msToAnswer', 'sessionId', 'sessionDate', 'presetName',
    'enabledOps', 'addRange', 'mulRange', 'durationSec'];
  const ts = new Date(Date.parse('2026-05-20T18:00:00.000Z')).toISOString();
  const good = [head2.join(','),
    [ts, PLUS, '1', '2', '3', '3', 'true', '500', 's3', ts, 'Easy', 'add', '1-9;1-9', '1-9;1-9', '120'].join(',')
  ].join('\n');                                  // LF-only line endings
  const r1 = Z.buildImport(Z.parseCSV(good));
  assert.equal(r1.ok, true);
  assert.equal(r1.sessions.length, 1);
  assert.equal(r1.sessions[0].problems[0].operation, PLUS);

  const bad = Z.buildImport(Z.parseCSV('foo,bar\n1,2\n'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Reckon CSV/);
});

/* ===================== complete backup (JSON) ===================== */
test('parseBackup groups problems under sessions, isolates loose ones, normalizes progress', () => {
  const backup = {
    type: 'reckon-backup', version: 1,
    sessions: [{ sessionId: 'A', score: 2, rate: 0.5, config: { ops: { add: true } } }],
    problems: [
      { sessionId: 'A', operation: PLUS, operand1: 7, operand2: 8, correctAnswer: 15, userAnswer: 15, wasCorrect: true, msToAnswer: 1200, timestamp: 111 },
      { sessionId: 'G', operation: DIV, operand1: 56, operand2: 7, correctAnswer: 8, userAnswer: 8, wasCorrect: true, msToAnswer: 900, timestamp: 222 },  // no session -> loose
      { sessionId: 'A', operation: 'bogus', operand1: 1, operand2: 2, correctAnswer: 3 },  // bad op -> skipped
    ],
    progress: { xp: 40, xpLifetime: 90, freezes: 1, freezeDays: { '2026-05-20': true }, gauntletClears: { '2026-05-20': 25000 } },
  };
  const res = Z.parseBackup(JSON.stringify(backup));
  assert.equal(res.ok, true);
  assert.equal(res.sessions.length, 1);
  assert.equal(res.sessions[0].score, 2);                 // stored fields kept verbatim
  assert.equal(res.sessions[0].problems.length, 1);
  assert.equal(res.looseProblems.length, 1);
  assert.equal(res.looseProblems[0].operation, DIV);
  assert.equal(res.skipped, 1);
  assert.deepEqual(res.progress.freezeDays, { '2026-05-20': true });
  assert.equal(res.progress.freezes, 1);

  assert.equal(Z.parseBackup('not json').ok, false);
  assert.equal(Z.parseBackup(JSON.stringify({ sessions: [] })).ok, false);   // missing problems[]
});

test('mergeProgress keeps the better of each side (non-destructive)', () => {
  const cur = { xp: 100, xpLifetime: 100, freezes: 0, freezeDays: { d1: true }, gauntletClears: { day: 30000 } };
  const inc = { xp: 40, xpLifetime: 250, freezes: 2, freezeDays: { d2: true }, gauntletClears: { day: 25000, day2: 9000 } };
  const m = Z.mergeProgress(cur, inc);
  assert.equal(m.xp, 100);                 // max
  assert.equal(m.xpLifetime, 250);         // max
  assert.equal(m.freezes, 2);              // max (within cap)
  assert.deepEqual(m.freezeDays, { d1: true, d2: true });        // union
  assert.deepEqual(m.gauntletClears, { day: 25000, day2: 9000 }); // best (min ms) per day
  // restoring into an empty profile adopts the backup's values
  const fresh = Z.mergeProgress(null, inc);
  assert.equal(fresh.xpLifetime, 250);
  assert.equal(fresh.freezes, 2);
});

/* ===================== backup nudge ===================== */
test('shouldBackupNudge fires only with unbacked games, past the stale window, not snoozed', () => {
  const DAY = 86400000, STALE = 3 * DAY;
  const now = Date.parse('2026-06-01T18:00:00.000Z');
  const game = t => ({ endedAt: new Date(t).toISOString() });

  assert.equal(Z.shouldBackupNudge([], {}, now, STALE), false);                       // no games
  assert.equal(Z.shouldBackupNudge([game(now - DAY)], {}, now, STALE), true);         // never backed up
  // backed up recently -> not stale yet
  assert.equal(Z.shouldBackupNudge([game(now - DAY)], { lastBackupAt: now - DAY }, now, STALE), false);
  // backed up long ago AND a newer game exists -> nudge
  assert.equal(Z.shouldBackupNudge([game(now - DAY)], { lastBackupAt: now - 5 * DAY }, now, STALE), true);
  // backed up long ago but NO game since -> nothing to lose, no nudge
  assert.equal(Z.shouldBackupNudge([game(now - 10 * DAY)], { lastBackupAt: now - 5 * DAY }, now, STALE), false);
  // stale + unbacked but snooze still active -> suppressed
  assert.equal(Z.shouldBackupNudge([game(now - DAY)], { lastBackupAt: 0, snoozeUntil: now + DAY }, now, STALE), false);
});

/* ===================== ranks ===================== */
test('rankForXp places lifetime XP on the ladder with progress to the next rank', () => {
  let r = Z.rankForXp(0);
  assert.equal(r.rank.key, 'novice'); assert.equal(r.index, 0);
  assert.equal(r.next.key, 'apprentice'); assert.equal(r.isMax, false);
  assert.equal(r.xpForNext, 500); assert.equal(r.progress, 0);
  assert.equal(Z.rankForXp(499).rank.key, 'novice');           // one short of the next rung
  assert.equal(Z.rankForXp(499).xpForNext, 1);
  r = Z.rankForXp(500);
  assert.equal(r.rank.key, 'apprentice'); assert.equal(r.xpIntoRank, 0);
  r = Z.rankForXp(2750);                                        // between adept(1500) and reckoner(4000)
  assert.equal(r.rank.key, 'adept'); assert.equal(r.xpForNext, 1250); assert.equal(r.progress, 0.5);
  r = Z.rankForXp(200000);                                      // past the top
  assert.equal(r.rank.key, 'luminary'); assert.equal(r.isMax, true);
  assert.equal(r.next, null); assert.equal(r.progress, 1); assert.equal(r.xpForNext, 0);
  assert.equal(Z.rankForXp(-50).rank.key, 'novice');           // garbage floors to the base rank
});

/* ===================== best gauntlet streak ===================== */
test('bestGauntletStreak finds the longest consecutive run of cleared days', () => {
  const k = (y, m, d) => Z.dayKey(new Date(y, m - 1, d));
  assert.equal(Z.bestGauntletStreak({ [k(2026,5,1)]:1, [k(2026,5,2)]:1, [k(2026,5,3)]:1,
                                      [k(2026,5,10)]:1, [k(2026,5,11)]:1 }), 3);   // run of 3 vs run of 2
  assert.equal(Z.bestGauntletStreak({ [k(2026,5,1)]:30000, [k(2026,5,3)]:30000 }), 1); // gap breaks it
  assert.equal(Z.bestGauntletStreak({}), 0);
  assert.equal(Z.bestGauntletStreak(null), 0);
});

/* ===================== trophy evaluation ===================== */
test('evaluateTrophies earns nothing from an empty stats bundle', () => {
  assert.deepEqual(Z.evaluateTrophies({}), []);          // every trophy needs a positive stat
  assert.deepEqual(Z.evaluateTrophies(undefined), []);   // tolerant of no argument
});

test('evaluateTrophies earns the right emblems per system, with thresholds', () => {
  const ids = stats => new Set(Z.evaluateTrophies(stats));
  // ranks: lifetime XP unlocks each rung it has passed (Novice is the start, not a trophy)
  let s = ids({ xpLifetime: 5000 });
  assert.ok(s.has('rank-apprentice') && s.has('rank-adept') && s.has('rank-reckoner'));
  assert.ok(!s.has('rank-tactician'));                    // 5000 < 9000
  // day streak: 30 clears the 7 and 30 tiers but not 100
  s = ids({ bestDayStreak: 30 });
  assert.ok(s.has('streak-7') && s.has('streak-30') && !s.has('streak-100'));
  // gauntlet medals / clears / streak
  assert.ok(ids({ totalGauntlets: 1 }).has('gaunt-first'));
  assert.ok(ids({ golds: 1 }).has('gaunt-gold') && !ids({ golds: 1 }).has('gaunt-gold10'));
  assert.ok(ids({ golds: 10 }).has('gaunt-gold10'));
  assert.ok(ids({ bestGauntletStreak: 7 }).has('gaunt-streak7'));
  // volume
  s = ids({ totalProblems: 1000 });
  assert.ok(s.has('vol-100') && s.has('vol-1000') && !s.has('vol-10000'));
  // speed: the guard rejects a 0 (no solves yet); 800ms is quickdraw only; 500ms is both
  assert.deepEqual([...ids({ fastestCorrectMs: 0 })], []);
  assert.ok(ids({ fastestCorrectMs: 800 }).has('rec-quickdraw') && !ids({ fastestCorrectMs: 800 }).has('rec-lightning'));
  assert.ok(ids({ fastestCorrectMs: 500 }).has('rec-lightning'));
  assert.ok(ids({ bestScore: 100 }).has('rec-highscore'));
  // mastery
  s = ids({ strongFacts: 100, tableMastered: true, opsWithStrong: 4 });
  assert.ok(s.has('mas-25') && s.has('mas-100') && s.has('mas-table') && s.has('mas-allops'));
  assert.ok(!ids({ opsWithStrong: 3 }).has('mas-allops'));
  // secret
  assert.ok(ids({ perfectGame: true }).has('sec-flawless'));
  assert.ok(ids({ nightOwl: true }).has('sec-nightowl'));
  assert.ok(ids({ usedFreeze: true }).has('sec-saved'));
});

test('every TROPHY_DEF is well-formed and secret trophies are flagged', () => {
  const seen = new Set();
  for (const t of Z.TROPHY_DEFS) {
    assert.ok(t.id && !seen.has(t.id), 'unique id: ' + t.id); seen.add(t.id);
    assert.equal(typeof t.reached, 'function');
    assert.ok(t.name && t.desc && t.icon && t.group);
  }
  assert.equal(Z.TROPHY_TOTAL, Z.TROPHY_DEFS.length);
  assert.ok(Z.TROPHY_DEFS.some(t => t.secret));            // some surprises exist
  assert.ok(Z.TROPHY_DEFS.filter(t => t.group === 'rank').length === Z.RANKS.length - 1);
});

test('reconcileTrophies is monotonic: earns once, never un-earns, returns only the fresh', () => {
  const p = Z.defaultProgress();
  let fresh = Z.reconcileTrophies(p, { totalGauntlets: 1, golds: 1 }, 1000);
  assert.deepEqual(fresh.map(t => t.id).sort(), ['gaunt-first', 'gaunt-gold']);
  assert.equal(p.trophies['gaunt-first'], 1000);          // earn time stamped
  // re-running with the same stats earns nothing new and doesn't restamp
  fresh = Z.reconcileTrophies(p, { totalGauntlets: 1, golds: 1 }, 2000);
  assert.deepEqual(fresh, []);
  assert.equal(p.trophies['gaunt-first'], 1000);          // original timestamp preserved
  // a REGRESSED stat (e.g. a mastered fact wilted away) must NOT remove an earned trophy
  fresh = Z.reconcileTrophies(p, { golds: 0 }, 3000);
  assert.deepEqual(fresh, []);
  assert.ok(p.trophies['gaunt-gold'] != null);            // still earned
  // a brand-new reach returns just that one
  fresh = Z.reconcileTrophies(p, { golds: 10 }, 4000);
  assert.deepEqual(fresh.map(t => t.id), ['gaunt-gold10']);
  assert.equal(p.trophies['gaunt-gold10'], 4000);
});

test('trophyCounts reports earned-of-total, ignoring stale ids', () => {
  const p = Z.defaultProgress();
  assert.deepEqual(Z.trophyCounts(p), { earned: 0, total: Z.TROPHY_TOTAL });
  Z.reconcileTrophies(p, { totalGauntlets: 1, bestScore: 100 }, 1);
  assert.deepEqual(Z.trophyCounts(p), { earned: 2, total: Z.TROPHY_TOTAL });
  p.trophies['no-such-trophy'] = 5;                       // an id from a future/older build is not counted
  assert.equal(Z.trophyCounts(p).earned, 2);
});

/* ===================== progress carries the new fields ===================== */
test('defaultProgress + normalize seed trophies / trophiesSeenAt / stats', () => {
  const d = Z.defaultProgress();
  assert.deepEqual(d.trophies, {});
  assert.equal(d.trophiesSeenAt, 0);
  assert.deepEqual(d.stats, { probs: 0, fastestMs: 0 });
  assert.deepEqual(Z.normalizeProgress(null).stats, { probs: 0, fastestMs: 0 });
  // trophiesSeenAt is a ms timestamp — it must survive normalize UNTRUNCATED (a |0 bug would wreck it)
  const big = 1_750_000_000_000;
  const n = Z.normalizeProgress({ trophiesSeenAt: big, trophies: { 'rank-adept': big }, stats: { probs: 9, fastestMs: 410 } });
  assert.equal(n.trophiesSeenAt, big);
  assert.equal(n.trophies['rank-adept'], big);
  assert.deepEqual(n.stats, { probs: 9, fastestMs: 410 });
  assert.deepEqual(Z.normalizeProgress({ trophies: 'bad', stats: 'bad' }).trophies, {});
  assert.deepEqual(Z.normalizeProgress({ stats: 'bad' }).stats, { probs: 0, fastestMs: 0 });
});

test('mergeProgress unions trophies (earliest earn) and keeps the better stats', () => {
  const cur = { trophies: { a: 100, b: 200 }, trophiesSeenAt: 500, stats: { probs: 300, fastestMs: 900 } };
  const inc = { trophies: { a: 50, c: 300 }, trophiesSeenAt: 400, stats: { probs: 250, fastestMs: 700 } };
  const m = Z.mergeProgress(cur, inc);
  assert.deepEqual(m.trophies, { a: 50, b: 200, c: 300 });   // union; 'a' keeps the EARLIER (50)
  assert.equal(m.trophiesSeenAt, 500);                       // max
  assert.deepEqual(m.stats, { probs: 300, fastestMs: 700 }); // max problems, min (fastest) time
  // a fresh profile adopts the incoming side; a 0 fastest (none yet) doesn't beat a real time
  const fresh = Z.mergeProgress(null, { stats: { probs: 5, fastestMs: 0 }, trophies: { z: 9 } });
  assert.equal(fresh.stats.probs, 5);
  assert.equal(fresh.stats.fastestMs, 0);
  assert.equal(fresh.trophies.z, 9);
});

/* ===================== html escaping ===================== */
test('escapeHTML neutralizes the five HTML-significant characters', () => {
  assert.equal(Z.escapeHTML('a"b\'c&d<e>f'), 'a&quot;b&#39;c&amp;d&lt;e&gt;f');
  assert.equal(Z.escapeHTML('plain text 123'), 'plain text 123');
  assert.equal(Z.escapeHTML(42), '42');                 // coerces non-strings
  // a malicious imported sessionId / presetName can't break out of an attribute
  const out = Z.escapeHTML('"><img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<') && !out.includes('>') && !out.includes('"'), 'no raw < > " survive');
});

/* ===================== survival / sudden death ===================== */
test('survivalTimeLimit starts generous, tightens per solve, and floors', () => {
  assert.equal(Z.survivalTimeLimit(0), Z.SURVIVAL_START_MS);            // first problem
  assert.equal(Z.survivalTimeLimit(1), Z.SURVIVAL_START_MS - Z.SURVIVAL_STEP_MS);
  // monotonically non-increasing
  for (let i = 1; i <= 40; i++)
    assert.ok(Z.survivalTimeLimit(i) <= Z.survivalTimeLimit(i - 1));
  // never drops below the floor, even far out
  assert.equal(Z.survivalTimeLimit(1000), Z.SURVIVAL_FLOOR_MS);
  assert.ok(Z.survivalTimeLimit(0) > Z.SURVIVAL_FLOOR_MS);
  // negative / garbage solved counts clamp to the start budget
  assert.equal(Z.survivalTimeLimit(-5), Z.SURVIVAL_START_MS);
});

test('recordSurvival banks only a new best (monotonic) and reports it', () => {
  const p = Z.defaultProgress();
  assert.equal(p.survivalBest, 0);
  let r = Z.recordSurvival(p, 7);
  assert.deepEqual(r, { best: 7, isBest: true, prev: 0 });
  assert.equal(p.survivalBest, 7);
  r = Z.recordSurvival(p, 4);                 // worse run doesn't lower the best
  assert.deepEqual(r, { best: 7, isBest: false, prev: 7 });
  assert.equal(p.survivalBest, 7);
  r = Z.recordSurvival(p, 7);                 // tying is not a new best
  assert.equal(r.isBest, false);
  r = Z.recordSurvival(p, 12);                // beating it is
  assert.deepEqual(r, { best: 12, isBest: true, prev: 7 });
  assert.equal(p.survivalBest, 12);
});

test('survivalBest survives normalize and takes the max on merge', () => {
  assert.equal(Z.normalizeProgress({ survivalBest: 9 }).survivalBest, 9);
  assert.equal(Z.normalizeProgress({ survivalBest: -3 }).survivalBest, 0);  // clamp garbage
  assert.equal(Z.normalizeProgress({}).survivalBest, 0);
  const m = Z.mergeProgress({ survivalBest: 5 }, { survivalBest: 11 });
  assert.equal(m.survivalBest, 11);
});

/* Guard against silent data loss when a future mode adds a progress field.
   Three functions define the persisted progress shape and MUST agree on its
   field set:
     · defaultProgress  — the source of truth (what's stored)
     · normalizeProgress — sanitizes a loaded/imported record (drops anything
       not listed, to keep untrusted backup JSON safe)
     · mergeProgress     — folds an imported backup into the current progress
   A field present in defaultProgress but missing from the other two would be
   silently dropped on import/restore. This test fails the moment they diverge,
   so adding e.g. `parkourBest` forces you to handle it everywhere a backup
   touches it. (It also catches a value not surviving a normalize round-trip.) */
test('progress shape stays in sync across default / normalize / merge', () => {
  const keys = Object.keys(Z.defaultProgress()).sort();
  assert.deepEqual(
    Object.keys(Z.normalizeProgress(Z.defaultProgress())).sort(), keys,
    'normalizeProgress is missing/adding a field vs defaultProgress — update it so backups keep every field');
  assert.deepEqual(
    Object.keys(Z.mergeProgress(Z.defaultProgress(), Z.defaultProgress())).sort(), keys,
    'mergeProgress is missing/adding a field vs defaultProgress — update it so restore merges every field');
  // every default field must round-trip through normalize unchanged (catches a
  // field that's keyed but quietly zeroed/dropped on load/import)
  const probe = Z.normalizeProgress(Z.defaultProgress());
  for (const k of keys) assert.ok(k in probe, 'normalizeProgress drops "' + k + '"');
});

test('Survivor trophy is earned at the survival threshold', () => {
  const below = Z.evaluateTrophies({ bestSurvival: Z.TROPHY.SURVIVAL - 1 });
  const at = Z.evaluateTrophies({ bestSurvival: Z.TROPHY.SURVIVAL });
  assert.ok(!below.includes('rec-survival'));
  assert.ok(at.includes('rec-survival'));
});
