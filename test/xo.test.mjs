// Tests for the X and O's rules.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CELLS, LINES, DEFAULT_TARGET,
  createState, layOut, currentSeat, markOf, seatOfMark,
  legalMoves, canPlay, winningLine, isFull,
  applyMove, endRound, nextRound, resetMatch,
} from '../js/games/xo/rules.js';

/* ---------------- helpers ---------------- */

// No rng to seed here: the game is fully determined by its move list, which is
// the entire reason these tests can just list squares.
const seats = () => [
  { id: 'p0', name: 'P0', connected: true },
  { id: 'p1', name: 'P1', connected: true },
];

/** Play squares in order, always as whoever is to move. */
function play(s, squares) {
  const out = [];
  for (const i of squares) out.push(applyMove(s, currentSeat(s).id, i));
  return out;
}

// Board indices:  0 1 2
//                 3 4 5
//                 6 7 8
const X_WINS_TOP = [0, 3, 1, 4, 2];        // opener takes the top row
const O_WINS_MID = [0, 3, 1, 4, 8, 5];     // second player takes the middle row
const DRAWN = [0, 2, 1, 3, 5, 4, 6, 7, 8]; // every square filled, no line

const boardOf = (s) => s.board.join('');

/* ---------------- setup ---------------- */

test('a fresh match starts empty, with seat 0 on X and to move', () => {
  const s = createState(seats());
  assert.equal(s.phase, 'playing');
  assert.equal(s.board.length, CELLS);
  assert.ok(s.board.every((c) => c === null));
  assert.equal(s.round, 1);
  assert.equal(s.draws, 0);
  assert.equal(s.target, DEFAULT_TARGET);
  assert.deepEqual(s.scores, { p0: 0, p1: 0 });
  assert.equal(currentSeat(s).id, 'p0');
  assert.equal(markOf(s, 'p0'), 'X');
  assert.equal(markOf(s, 'p1'), 'O');
});

test('the opener is always the one on X', () => {
  const s = createState(seats());
  for (let round = 1; round <= 6; round++) {
    s.round = round;
    layOut(s);
    assert.equal(markOf(s, currentSeat(s).id), 'X', `round ${round}`);
  }
});

test('seatOfMark is the inverse of markOf', () => {
  const s = createState(seats());
  assert.equal(seatOfMark(s, 'X').id, 'p0');
  assert.equal(seatOfMark(s, 'O').id, 'p1');
});

/* ---------------- lines ---------------- */

test('there are eight winning lines and no duplicates', () => {
  assert.equal(LINES.length, 8);
  const seen = new Set(LINES.map((l) => [...l].sort((a, b) => a - b).join(',')));
  assert.equal(seen.size, 8);
});

test('every winning line is detected', () => {
  for (const line of LINES) {
    const board = Array(CELLS).fill(null);
    for (const i of line) board[i] = 'X';
    assert.deepEqual(winningLine(board), line);
  }
});

test('a line of mixed marks is not a win', () => {
  for (const [a, b, c] of LINES) {
    const board = Array(CELLS).fill(null);
    board[a] = 'X'; board[b] = 'O'; board[c] = 'X';
    assert.equal(winningLine(board), null);
  }
});

test('an empty board has no line and is not full', () => {
  const board = Array(CELLS).fill(null);
  assert.equal(winningLine(board), null);
  assert.equal(isFull(board), false);
  assert.equal(isFull(board.map(() => 'X')), true);
});

/* ---------------- legality ---------------- */

test('legalMoves lists the empty squares, and shrinks as they fill', () => {
  const s = createState(seats());
  assert.deepEqual(legalMoves(s), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  play(s, [4]);
  assert.deepEqual(legalMoves(s), [0, 1, 2, 3, 5, 6, 7, 8]);
});

test('you cannot take an occupied square', () => {
  const s = createState(seats());
  play(s, [4]);
  assert.equal(canPlay(s, 'p1', 4), false);
  assert.throws(() => applyMove(s, 'p1', 4), /illegal move/);
});

test('you cannot move out of turn', () => {
  const s = createState(seats());
  assert.equal(canPlay(s, 'p1', 0), false);
  assert.throws(() => applyMove(s, 'p1', 0), /illegal move/);
  assert.equal(canPlay(s, 'p0', 0), true);
});

test('squares off the board are rejected rather than stored', () => {
  const s = createState(seats());
  for (const i of [-1, 9, 1.5, NaN, null, undefined, '4']) {
    assert.equal(canPlay(s, 'p0', i), false, `square ${String(i)}`);
    assert.throws(() => applyMove(s, 'p0', i), /illegal move/);
  }
  assert.ok(s.board.every((c) => c === null), 'nothing should have been written');
});

test('a finished round accepts no more moves', () => {
  const s = createState(seats());
  play(s, X_WINS_TOP);
  assert.equal(s.phase, 'roundover');
  assert.deepEqual(legalMoves(s), []);
  assert.throws(() => applyMove(s, 'p1', 5), /illegal move/);
});

/* ---------------- playing a round ---------------- */

test('the turn alternates, and marks land on the right squares', () => {
  const s = createState(seats());
  play(s, [4, 0, 8]);
  assert.equal(boardOf(s), 'O   X   X'.replace(/ /g, ''), 'three marks placed');
  assert.equal(s.board[4], 'X');
  assert.equal(s.board[0], 'O');
  assert.equal(s.board[8], 'X');
  assert.equal(currentSeat(s).id, 'p1');
});

test('completing a line ends the round and scores it', () => {
  const s = createState(seats());
  const moves = play(s, X_WINS_TOP);
  const last = moves.at(-1);

  assert.equal(last.roundOver, true);
  assert.equal(last.draw, false);
  assert.deepEqual(last.line, [0, 1, 2]);
  assert.equal(last.gained, 1);
  assert.equal(last.total, 1);
  assert.equal(last.matchOver, false);

  assert.equal(s.phase, 'roundover');
  assert.equal(s.roundWinner, 'p0');
  assert.deepEqual(s.line, [0, 1, 2]);
  assert.deepEqual(s.scores, { p0: 1, p1: 0 });
  assert.equal(s.draws, 0);
});

test('the second player can win too', () => {
  const s = createState(seats());
  const last = play(s, O_WINS_MID).at(-1);
  assert.equal(last.mark, 'O');
  assert.deepEqual(last.line, [3, 4, 5]);
  assert.equal(s.roundWinner, 'p1');
  assert.deepEqual(s.scores, { p0: 0, p1: 1 });
});

test('a full board with no line is a draw: nobody scores', () => {
  const s = createState(seats());
  const last = play(s, DRAWN).at(-1);

  assert.equal(last.roundOver, true);
  assert.equal(last.draw, true);
  assert.equal(last.line, null);
  assert.equal(last.gained, 0);
  assert.equal(last.matchOver, false);

  assert.ok(isFull(s.board));
  assert.equal(s.phase, 'roundover');
  assert.equal(s.roundWinner, null);
  assert.equal(s.draws, 1);
  assert.deepEqual(s.scores, { p0: 0, p1: 0 });
});

test('a win on the last square is a win, not a draw', () => {
  // Eight squares down, the ninth completes a line — the draw check must run
  // after the win check or this scores as a draw.
  // X ends on 1,5,0,4,8 — only [0,4,8] is a line, and only once 8 lands.
  const s = createState(seats());
  play(s, [1, 2, 5, 3, 0, 6, 4, 7]);
  assert.equal(s.phase, 'playing', 'still one square to go');
  const last = play(s, [8]).at(-1);
  assert.equal(last.draw, false);
  assert.deepEqual(last.line, [0, 4, 8]);
  assert.ok(isFull(s.board), 'the board is full and it is still a win');
  assert.equal(s.roundWinner, 'p0');
});

/* ---------------- the match ---------------- */

test('the next round swaps who opens, and clears the board', () => {
  const s = createState(seats());
  play(s, X_WINS_TOP);
  nextRound(s);

  assert.equal(s.round, 2);
  assert.equal(s.phase, 'playing');
  assert.ok(s.board.every((c) => c === null));
  assert.equal(s.line, null);
  assert.equal(s.roundWinner, null);
  assert.equal(currentSeat(s).id, 'p1');
  assert.equal(markOf(s, 'p1'), 'X');
  assert.equal(markOf(s, 'p0'), 'O');
  assert.deepEqual(s.scores, { p0: 1, p1: 0 }, 'scores survive the round');
});

test('a drawn round still hands the opening move over', () => {
  // The point of the alternation: draws are the usual result between two
  // people who can play, so if a draw kept the opener the same, one seat would
  // hold the first move for the whole match.
  const s = createState(seats());
  assert.equal(currentSeat(s).id, 'p0');
  play(s, DRAWN);
  nextRound(s);
  assert.equal(currentSeat(s).id, 'p1');
  assert.equal(s.round, 2);
  play(s, DRAWN);
  nextRound(s);
  assert.equal(currentSeat(s).id, 'p0');
  assert.equal(s.draws, 2);
  assert.deepEqual(s.scores, { p0: 0, p1: 0 });
});

test('over a long match each seat opens the same number of times', () => {
  const s = createState(seats());
  const openers = [];
  for (let i = 0; i < 10; i++) {
    openers.push(currentSeat(s).id);
    play(s, DRAWN);
    nextRound(s);
  }
  assert.equal(openers.filter((id) => id === 'p0').length, 5);
  assert.equal(openers.filter((id) => id === 'p1').length, 5);
});

test('reaching the target ends the match', () => {
  const s = createState(seats(), { target: 2 });
  play(s, X_WINS_TOP);          // p0 opens as X and wins
  assert.equal(s.phase, 'roundover');
  nextRound(s);
  const last = play(s, O_WINS_MID).at(-1);   // p1 opens, so p0 is O — and wins

  assert.equal(last.matchOver, true);
  assert.equal(last.total, 2);
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 'p0');
  assert.deepEqual(s.scores, { p0: 2, p1: 0 });
});

test('a draw can never end the match, even at match point', () => {
  const s = createState(seats(), { target: 1 });
  play(s, DRAWN);
  assert.equal(s.phase, 'roundover');
  assert.equal(s.winner, null);
  assert.equal(endRound(s, null).matchOver, false);
});

test('nextRound refuses to run mid-round', () => {
  const s = createState(seats());
  assert.throws(() => nextRound(s), /round is not over/);
  play(s, [0, 1]);
  assert.throws(() => nextRound(s), /round is not over/);
});

test('resetMatch clears the score but keeps the log', () => {
  const s = createState(seats(), { target: 1 });
  s.log.push('something happened');
  play(s, X_WINS_TOP);
  assert.equal(s.phase, 'over');

  resetMatch(s);
  assert.equal(s.phase, 'playing');
  assert.equal(s.round, 1);
  assert.equal(s.draws, 0);
  assert.equal(s.winner, null);
  assert.deepEqual(s.scores, { p0: 0, p1: 0 });
  assert.ok(s.board.every((c) => c === null));
  assert.equal(currentSeat(s).id, 'p0');
  assert.deepEqual(s.log, ['something happened']);
});
