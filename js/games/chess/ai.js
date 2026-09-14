// Chess computer player. Pure: a position in, a move out.
//
// A small classical engine: material plus piece-square tables for the
// evaluation, negamax with alpha-beta for the search, a quiescence search on
// captures so it doesn't stop looking halfway through a trade, and iterative
// deepening against a clock so it always has an answer when time runs out.
//
// It runs on the host's main thread. The clock keeps a hard move to about a
// second and a half, which is a pause, not a hang.
//
// Difficulty is the same engine held back three ways — how deep it looks,
// how far off the best move it is willing to play (`margin`, in centipawns),
// and how often it simply plays something at random (`blunder`):
//
//   easy    one move deep; happily gives away a pawn and a half, and now and
//           then just shoves a piece somewhere
//   medium  three moves deep, rarely careless
//   hard    as deep as a second and a half allows, and plays the best it finds

import { legalMoves, makeMove, inCheck } from './rules.js';

export const LEVELS = {
  easy:   { depth: 1, margin: 150, blunder: 0.2,  time: 400 },
  medium: { depth: 3, margin: 30,  blunder: 0.03, time: 900 },
  hard:   { depth: 8, margin: 0,   blunder: 0,    time: 1500 },
};

const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000;

// Piece-square tables, from White's side and a8 first — the same order as a
// board — so a White piece on square i reads TABLE[i] and a Black one reads
// the square mirrored top to bottom.
const PST = {
  p: [
     0,   0,   0,   0,   0,   0,   0,   0,
    50,  50,  50,  50,  50,  50,  50,  50,
    10,  10,  20,  30,  30,  20,  10,  10,
     5,   5,  10,  25,  25,  10,   5,   5,
     0,   0,   0,  20,  20,   0,   0,   0,
     5,  -5, -10,   0,   0, -10,  -5,   5,
     5,  10,  10, -20, -20,  10,  10,   5,
     0,   0,   0,   0,   0,   0,   0,   0],
  n: [
   -50, -40, -30, -30, -30, -30, -40, -50,
   -40, -20,   0,   0,   0,   0, -20, -40,
   -30,   0,  10,  15,  15,  10,   0, -30,
   -30,   5,  15,  20,  20,  15,   5, -30,
   -30,   0,  15,  20,  20,  15,   0, -30,
   -30,   5,  10,  15,  15,  10,   5, -30,
   -40, -20,   0,   5,   5,   0, -20, -40,
   -50, -40, -30, -30, -30, -30, -40, -50],
  b: [
   -20, -10, -10, -10, -10, -10, -10, -20,
   -10,   0,   0,   0,   0,   0,   0, -10,
   -10,   0,   5,  10,  10,   5,   0, -10,
   -10,   5,   5,  10,  10,   5,   5, -10,
   -10,   0,  10,  10,  10,  10,   0, -10,
   -10,  10,  10,  10,  10,  10,  10, -10,
   -10,   5,   0,   0,   0,   0,   5, -10,
   -20, -10, -10, -10, -10, -10, -10, -20],
  r: [
     0,   0,   0,   0,   0,   0,   0,   0,
     5,  10,  10,  10,  10,  10,  10,   5,
    -5,   0,   0,   0,   0,   0,   0,  -5,
    -5,   0,   0,   0,   0,   0,   0,  -5,
    -5,   0,   0,   0,   0,   0,   0,  -5,
    -5,   0,   0,   0,   0,   0,   0,  -5,
    -5,   0,   0,   0,   0,   0,   0,  -5,
     0,   0,   0,   5,   5,   0,   0,   0],
  q: [
   -20, -10, -10,  -5,  -5, -10, -10, -20,
   -10,   0,   0,   0,   0,   0,   0, -10,
   -10,   0,   5,   5,   5,   5,   0, -10,
    -5,   0,   5,   5,   5,   5,   0,  -5,
     0,   0,   5,   5,   5,   5,   0,  -5,
   -10,   5,   5,   5,   5,   5,   0, -10,
   -10,   0,   5,   0,   0,   0,   0, -10,
   -20, -10, -10,  -5,  -5, -10, -10, -20],
  // The king hides in the middlegame…
  k: [
   -30, -40, -40, -50, -50, -40, -40, -30,
   -30, -40, -40, -50, -50, -40, -40, -30,
   -30, -40, -40, -50, -50, -40, -40, -30,
   -30, -40, -40, -50, -50, -40, -40, -30,
   -20, -30, -30, -40, -40, -30, -30, -20,
   -10, -20, -20, -20, -20, -20, -20, -10,
    20,  20,   0,   0,   0,   0,  20,  20,
    20,  30,  10,   0,   0,  10,  30,  20],
  // …and walks to the centre once the heavy pieces are gone.
  kEnd: [
   -50, -40, -30, -20, -20, -30, -40, -50,
   -30, -20, -10,   0,   0, -10, -20, -30,
   -30, -10,  20,  30,  30,  20, -10, -30,
   -30, -10,  30,  40,  40,  30, -10, -30,
   -30, -10,  30,  40,  40,  30, -10, -30,
   -30, -10,  20,  30,  30,  20, -10, -30,
   -30, -30,   0,   0,   0,   0, -30, -30,
   -50, -30, -30, -30, -30, -30, -30, -50],
};

/** Static score of a position in centipawns, for the side to move. */
export function evaluate(pos) {
  let pieces = 0;
  for (const p of pos.board) {
    const t = p && p.toLowerCase();
    if (t && t !== 'p' && t !== 'k') pieces += VALUE[t];
  }
  const endgame = pieces <= 1300;
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = pos.board[i];
    if (!p) continue;
    const t = p.toLowerCase();
    const white = p !== t;
    const sq = white ? i : (7 - (i >> 3)) * 8 + (i & 7);
    const v = VALUE[t] + (t === 'k' && endgame ? PST.kEnd : PST[t])[sq];
    score += white ? v : -v;
  }
  return pos.turn === 'w' ? score : -score;
}

/** Captures of big pieces by small ones first, then promotions, then the rest. */
function order(moves) {
  const key = (m) => (m.captured ? 10 * VALUE[m.captured.toLowerCase()] - VALUE[m.piece.toLowerCase()] : 0) +
    (m.promo ? VALUE[m.promo] : 0);
  return moves.sort((a, b) => key(b) - key(a));
}

function tick(ctx) {
  if ((++ctx.nodes & 511) === 0 && Date.now() > ctx.deadline) ctx.stop = true;
  return ctx.stop;
}

function search(pos, depth, alpha, beta, ply, ctx) {
  if (tick(ctx)) return 0;
  if (pos.halfmove >= 100) return 0;
  // Out of depth: settle the captures — unless in check, where standing
  // still isn't an option, so look one more move (within reason).
  if (depth <= 0 && (ply >= ctx.maxPly || !inCheck(pos))) return quiesce(pos, alpha, beta, ctx, 0);

  const moves = legalMoves(pos);
  if (!moves.length) return inCheck(pos) ? -MATE + ply : 0;
  for (const m of order(moves)) {
    const v = -search(makeMove(pos, m), depth - 1, -beta, -alpha, ply + 1, ctx);
    if (ctx.stop) return 0;
    if (v >= beta) return v;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

function quiesce(pos, alpha, beta, ctx, qply) {
  if (tick(ctx)) return 0;
  const stand = evaluate(pos);
  if (stand >= beta || qply >= 6) return stand;
  if (stand > alpha) alpha = stand;
  const noisy = legalMoves(pos).filter((m) => m.captured || m.promo === 'q');
  for (const m of order(noisy)) {
    const v = -quiesce(makeMove(pos, m), -beta, -alpha, ctx, qply + 1);
    if (ctx.stop) return 0;
    if (v >= beta) return v;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

/**
 * The move to play, as one of `legalMoves(pos)` — or null if there is none.
 * @param opts.timeMs  override the level's thinking time (tests use it)
 */
export function chooseMove(pos, level = 'medium', { rng = Math.random, timeMs } = {}) {
  const moves = legalMoves(pos);
  if (!moves.length) return null;
  const cfg = LEVELS[level] || LEVELS.medium;
  if (rng() < cfg.blunder) return moves[Math.floor(rng() * moves.length)];

  // A hard player still shouldn't open identically every game.
  const margin = cfg.margin || (pos.fullmove <= 3 ? 15 : 0);
  const ctx = { nodes: 0, stop: false, deadline: Date.now() + (timeMs ?? cfg.time), maxPly: 16 };
  let ordered = order(moves.slice());
  let best = ordered[0];

  for (let depth = 1; depth <= cfg.depth; depth++) {
    const scored = [];
    let alpha = -Infinity;
    for (const m of ordered) {
      // Anything that can't come within `margin` of the best so far only
      // needs to be proven worse, not scored exactly — so a score at or below
      // the floor it was searched against is a bound, not a value, and must
      // never make the shortlist.
      const floor = alpha === -Infinity ? -Infinity : alpha - margin;
      const v = -search(makeMove(pos, m), depth - 1, -Infinity, -floor, 1, ctx);
      if (ctx.stop) break;
      scored.push([m, v, v > floor]);
      if (v > alpha) alpha = v;
    }
    // An unfinished depth has only looked at some moves; trust the last
    // finished one instead (the first depth always finishes in practice).
    if (ctx.stop && depth > 1) break;
    if (!scored.length) break;

    scored.sort((a, b) => b[1] - a[1]);
    const top = scored[0][1];
    const pool = scored.filter(([, v, exact]) => exact && v >= top - margin);
    best = pool[Math.floor(rng() * pool.length)][0];
    ordered = [...scored.map(([m]) => m), ...ordered.filter((m) => !scored.some(([s]) => s === m))];
    if (ctx.stop || Math.abs(top) > MATE - 1000) break;   // out of time, or a forced mate is found
  }
  return best;
}
