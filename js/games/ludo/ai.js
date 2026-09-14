// Ludo computer players. Pure: given a state with a roll on it, pick a token.
//
// Ludo is mostly dice, so a strong player is one that doesn't throw away what
// the dice give it. Every legal move gets a score from a handful of instincts —
// get home, knock someone out, get out of the yard, don't park where you can
// be hit — and the best one is played.
//
//   easy    mostly moves any old token; now and then plays sensibly
//   medium  follows the instincts, but only looks at where it lands
//   hard    also weighs what it leaves behind, and cares more the further
//           a token has come

import { LAST_TRACK_STEP, HOME_STEP, SAFE, currentSeat, absSquare, inYard, isBlock, tokensAt } from './rules.js';

/** Token index to move, or null if there is nothing legal. */
export function chooseMove(state, level = 'medium', rng = Math.random) {
  const moves = state.moves;
  if (!moves.length) return null;
  if (level === 'easy' && rng() < 0.7) return moves[Math.floor(rng() * moves.length)];

  let best = moves[0];
  let bestScore = -Infinity;
  for (const i of moves) {
    // A sliver of noise breaks ties without ever outvoting a real reason.
    const score = scoreMove(state, i, level) + rng() * 0.5;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

export function scoreMove(state, i, level = 'medium') {
  const color = currentSeat(state).color;
  const from = state.tokens[color][i];
  const to = inYard(from) ? 0 : from + state.dice;
  let score = to * 0.2;                                // all else equal, push on

  if (to === HOME_STEP) score += 120;
  else if (to > LAST_TRACK_STEP && from <= LAST_TRACK_STEP) score += 55;   // into the home column: untouchable
  if (inYard(from)) score += 70;

  const abs = absSquare(color, to);
  if (abs !== null) {
    if (!SAFE.has(abs)) {
      for (const t of tokensAt(state, abs)) {
        if (t.color === color || isBlock(state, abs, t.color)) continue;
        score += 90 + state.tokens[t.color][t.i] * 0.8;   // the further they'd come, the sweeter
      }
    }
    const covered = SAFE.has(abs) || tokensAt(state, abs).some((t) => t.color === color && t.i !== i);
    if (covered) score += 20;
    else if (level !== 'easy') score -= threat(state, color, abs) * (level === 'hard' ? 1 + to / 40 : 1);
  }

  // Hard players also move a token *out* of reach, not just into safety.
  const fromAbs = absSquare(color, from);
  if (level === 'hard' && fromAbs !== null && !SAFE.has(fromAbs) && !isBlock(state, fromAbs, color)) {
    score += threat(state, color, fromAbs) * (0.6 + from / 60);
  }
  return score;
}

/** How dangerous a track square is for `color`: 30 per enemy token that could
 *  land on it with a single roll. */
export function threat(state, color, abs) {
  let n = 0;
  for (const seat of state.seats) {
    if (seat.color === color) continue;
    for (const r of state.tokens[seat.color]) {
      if (r < 0 || r > LAST_TRACK_STEP) continue;
      for (let k = 1; k <= 6; k++) {
        if (r + k <= LAST_TRACK_STEP && absSquare(seat.color, r + k) === abs) { n += 1; break; }
      }
    }
  }
  return n * 30;
}
