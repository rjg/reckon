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
    return { xp: 0, xpLifetime: 0, freezes: 0, freezeDays: {}, gauntletClears: {}, v: 1 };
  }
  /* normalize a loaded record so older/partial shapes don't crash callers */
  function normalizeProgress(p) {
    const d = defaultProgress();
    if (!p || typeof p !== 'object') return d;
    return {
      xp: Math.max(0, p.xp | 0),
      xpLifetime: Math.max(0, p.xpLifetime | 0),
      freezes: Math.max(0, Math.min(MAX_FREEZES, p.freezes | 0)),
      freezeDays: (p.freezeDays && typeof p.freezeDays === 'object') ? p.freezeDays : {},
      gauntletClears: (p.gauntletClears && typeof p.gauntletClears === 'object') ? p.gauntletClears : {},
      v: 1,
    };
  }
  function xpForSession(session) { return Math.max(0, (session && session.score) | 0); }
  function awardXp(progress, amount) {
    amount = Math.max(0, amount | 0);
    progress.xp += amount; progress.xpLifetime += amount;
    return amount;
  }
  function canBuyFreeze(progress) {
    return progress.xp >= FREEZE_COST && progress.freezes < MAX_FREEZES;
  }
  /* spend XP for a freeze; returns true on success, false if not allowed */
  function buyFreeze(progress) {
    if (!canBuyFreeze(progress)) return false;
    progress.xp -= FREEZE_COST; progress.freezes++;
    return true;
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
      if (!c) c = cells[a - 1][b - 1] = { count: 0, correct: 0, totalMs: 0 };
      c.count++;
      if (p.wasCorrect) { c.correct++; c.totalMs += p.msToAnswer; }
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
     there are N. `rng` is injectable so the fill + shuffle are reproducible per
     day (index.html seeds it by date; tests pass a deterministic rng). */
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
    for (let i = out.length - 1; i > 0; i--) {           // seeded shuffle, stable per day
      const j = Math.floor(rng() * (i + 1));
      const t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
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
  /* record a clear time (ms) for a day; award the flat reward only on the FIRST
     clear of that day. Mutates progress (gauntletClears, and xp via awardXp). */
  function recordGauntletClear(progress, key, ms) {
    progress.gauntletClears = progress.gauntletClears || {};
    ms = Math.max(0, Math.round(ms));
    const prev = progress.gauntletClears[key];
    const firstToday = prev == null;
    const improved = firstToday || ms < prev;
    if (improved) progress.gauntletClears[key] = ms;
    const reward = firstToday ? awardXp(progress, GAUNTLET_REWARD) : 0;
    return { firstToday, improved, best: progress.gauntletClears[key], reward };
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
    return {
      xp: Math.max(cur.xp, inc.xp), xpLifetime: Math.max(cur.xpLifetime, inc.xpLifetime),
      freezes: Math.max(cur.freezes, inc.freezes), freezeDays, gauntletClears, v: 1,
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

  return {
    PLUS, MINUS, TIMES, DIV, OP_ORDER,
    DAILY_GOAL, FREEZE_COST, MAX_FREEZES,
    GAUNTLET_SIZE, GAUNTLET_REWARD, GAUNTLET_WINDOW_DAYS,
    dayKey, parseKey, addDays,
    answerFor, canonFact, factKey, genProblem,
    dayCounts, daySatisfied, currentStreak, bestStreak, reconcileFreezes,
    defaultProgress, normalizeProgress, xpForSession, awardXp, canBuyFreeze, buyFreeze,
    pickGhost, ghostScoreAt,
    gridFactors, masteryBaseline, cellLevel, masteryGrid,
    opStats, computeWeakFacts,
    recentProblems, buildGauntlet, gauntletStreak, recordGauntletClear,
    parseCSV, buildImport, parseBackup, mergeProgress, shouldBackupNudge,
  };
});
