// X and O's computer player. Pure: a board and a mark in, a square out.
//
// Noughts and crosses is small enough to solve outright, so "hard" does:
// it searches the whole game tree and never loses. The easier levels are
// that same player with its attention wandering.
//
//   easy    sees a win of its own about half the time; otherwise anywhere
//   medium  always takes a win and always blocks one, likes the centre,
//           but has no plan beyond the next move — a fork beats it
//   hard    perfect play, picking at random among equally good squares so
//           it doesn't open the same way every round

import { winningLine, isFull } from './rules.js';

const other = (mark) => (mark === 'X' ? 'O' : 'X');
const openSquares = (board) => board.reduce((out, c, i) => (c === null ? (out.push(i), out) : out), []);

/** Square index for `mark` to take, or null if the board is full. */
export function chooseSquare(board, mark, level = 'medium', rng = Math.random) {
  const open = openSquares(board);
  if (!open.length) return null;
  const anywhere = () => open[Math.floor(rng() * open.length)];

  if (level === 'easy') {
    if (rng() < 0.5) {
      const win = finishing(board, mark);
      if (win !== null) return win;
    }
    return anywhere();
  }

  if (level === 'medium') {
    const win = finishing(board, mark);
    if (win !== null) return win;
    const block = finishing(board, other(mark));
    if (block !== null) return block;
    if (board[4] === null && rng() < 0.6) return 4;
    return anywhere();
  }

  let best = -Infinity;
  let picks = [];
  for (const i of open) {
    const next = board.slice();
    next[i] = mark;
    const v = -negamax(next, other(mark), 1);
    if (v > best) { best = v; picks = [i]; }
    else if (v === best) picks.push(i);
  }
  return picks[Math.floor(rng() * picks.length)];
}

/** A square that completes a line for `mark` right now, or null. */
export function finishing(board, mark) {
  for (const i of openSquares(board)) {
    const next = board.slice();
    next[i] = mark;
    if (winningLine(next)) return i;
  }
  return null;
}

/** Value of `board` for the side about to move: positive is winning. Sooner
 *  wins and later losses score higher, so a won position is finished off
 *  rather than toyed with. There are only a few thousand positions, so each
 *  is worked out once and remembered. */
const memo = new Map();
function negamax(board, toMove, depth) {
  const key = board.map((c) => c || '.').join('') + toMove;
  const known = memo.get(key);
  if (known !== undefined) return known;

  let best;
  if (winningLine(board)) best = depth - 10;     // the player who just moved has won
  else if (isFull(board)) best = 0;
  else {
    best = -Infinity;
    for (const i of openSquares(board)) {
      board[i] = toMove;
      best = Math.max(best, -negamax(board, other(toMove), depth + 1));
      board[i] = null;
    }
  }
  memo.set(key, best);
  return best;
}
