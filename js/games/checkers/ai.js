// Checkers computer player. Pure: a position in, a move out.
//
// Same shape as chess/ai.js — negamax with alpha-beta, iterative deepening
// against a clock — with a checkers evaluation: kings are worth most of two
// men, men are worth more the closer they get to crowning, and a man left on
// the back row earns a little for keeping the other side from crowning.
//
// Captures are compulsory, so the search never stops in the middle of an
// exchange: while the side to move has a capture, it keeps looking.
//
//   easy    two moves deep, loose about which move it picks
//   medium  five moves deep, rarely careless
//   hard    as deep as a second and a half allows

import { legalMoves, makeMove, colourOf, isKing, QUIET_LIMIT } from './rules.js';

export const LEVELS = {
  easy:   { depth: 2,  margin: 60, blunder: 0.2,  time: 400 },
  medium: { depth: 5,  margin: 15, blunder: 0.03, time: 900 },
  hard:   { depth: 20, margin: 0,  blunder: 0,    time: 1500 },
};

const MAN = 100;
const KING = 170;
const MATE = 100000;

/** Static score for the side to move. */
export function evaluate(pos) {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = pos.board[i];
    if (!p) continue;
    const colour = colourOf(p);
    const r = i >> 3;
    const f = i & 7;
    let v;
    if (isKing(p)) {
      // Kings are strongest in the middle of the board, weakest in a corner.
      v = KING + (3.5 - Math.abs(3.5 - r)) * 2 + (3.5 - Math.abs(3.5 - f)) * 2;
    } else {
      const travelled = colour === 'b' ? r : 7 - r;
      v = MAN + travelled * 4 + (travelled === 0 ? 6 : 0);
    }
    score += colour === 'b' ? v : -v;
  }
  return pos.turn === 'b' ? score : -score;
}

/** Longest captures first, then crownings. */
const order = (moves) => moves.sort((a, b) => (b.captured.length * 10 + b.crown) - (a.captured.length * 10 + a.crown));

function tick(ctx) {
  if ((++ctx.nodes & 511) === 0 && Date.now() > ctx.deadline) ctx.stop = true;
  return ctx.stop;
}

function search(pos, depth, alpha, beta, ply, ctx) {
  if (tick(ctx)) return 0;
  const moves = legalMoves(pos);
  if (!moves.length) return -MATE + ply;            // no move is a loss
  if (pos.quiet >= QUIET_LIMIT) return 0;
  const capturing = moves[0].captured.length > 0;
  if (depth <= 0 && (!capturing || ply >= ctx.maxPly)) return evaluate(pos);

  for (const m of order(moves)) {
    const v = -search(makeMove(pos, m), depth - 1, -beta, -alpha, ply + 1, ctx);
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
  if (moves.length === 1) return moves[0];
  const cfg = LEVELS[level] || LEVELS.medium;
  if (rng() < cfg.blunder) return moves[Math.floor(rng() * moves.length)];

  const ctx = { nodes: 0, stop: false, deadline: Date.now() + (timeMs ?? cfg.time), maxPly: 40 };
  let ordered = order(moves.slice());
  let best = ordered[0];

  for (let depth = 1; depth <= cfg.depth; depth++) {
    const scored = [];
    let alpha = -Infinity;
    for (const m of ordered) {
      // Searched only to prove it worse than the floor: a score at or below
      // the floor is a bound, not a value, and stays off the shortlist.
      const floor = alpha === -Infinity ? -Infinity : alpha - cfg.margin;
      const v = -search(makeMove(pos, m), depth - 1, -Infinity, -floor, 1, ctx);
      if (ctx.stop) break;
      scored.push([m, v, v > floor]);
      if (v > alpha) alpha = v;
    }
    if (ctx.stop && depth > 1) break;
    if (!scored.length) break;

    scored.sort((a, b) => b[1] - a[1]);
    const top = scored[0][1];
    const pool = scored.filter(([, v, exact]) => exact && v >= top - cfg.margin);
    best = pool[Math.floor(rng() * pool.length)][0];
    ordered = [...scored.map(([m]) => m), ...ordered.filter((m) => !scored.some(([s]) => s === m))];
    if (ctx.stop || Math.abs(top) > MATE - 1000) break;
  }
  return best;
}
