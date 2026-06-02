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

/* ===================== html escaping ===================== */
test('escapeHTML neutralizes the five HTML-significant characters', () => {
  assert.equal(Z.escapeHTML('a"b\'c&d<e>f'), 'a&quot;b&#39;c&amp;d&lt;e&gt;f');
  assert.equal(Z.escapeHTML('plain text 123'), 'plain text 123');
  assert.equal(Z.escapeHTML(42), '42');                 // coerces non-strings
  // a malicious imported sessionId / presetName can't break out of an attribute
  const out = Z.escapeHTML('"><img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<') && !out.includes('>') && !out.includes('"'), 'no raw < > " survive');
});
