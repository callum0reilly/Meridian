// Tests for the checkers rules.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  START_FEN, QUIET_LIMIT,
  fromFEN, toFEN, squareIndex, squareNumber, isDark, legalMoves, makeMove, mustCapture, toNotation,
  createState, currentSeat, seatOfColour, colourOfSeat, movesFrom,
  applyMove, resign, offerDraw, acceptDraw, declineDraw, agreeDraw, rematch,
} from '../js/games/checkers/rules.js';

/* ---------------- helpers ---------------- */

const seats = () => [
  { id: 'p0', name: 'P0', connected: true },
  { id: 'p1', name: 'P1', connected: true },
];

/** p0 on Black unless told otherwise, so tests never depend on the coin toss. */
const match = (opts = {}) => createState(seats(), { black: 0, ...opts });

/** Play moves in book notation — '11-15', '15x24x31' — as whoever is to move. */
function play(s, notes) {
  return notes.map((note) => {
    const [from, ...path] = note.split(/[-x]/).map((n) => squareIndex(Number(n)));
    return applyMove(s, currentSeat(s).id, { from, path });
  });
}

const notes = (pos, from = null) => legalMoves(pos, from).map(toNotation).sort();
const pieceOn = (s, n) => s.pos.board[squareIndex(n)];

function perft(pos, depth) {
  const moves = legalMoves(pos);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(makeMove(pos, m), depth - 1);
  return n;
}

/* ---------------- board + notation ---------------- */

test('book squares and board indices agree', () => {
  assert.equal(squareIndex(1), 1, 'square 1 is b8');
  assert.equal(squareIndex(4), 7, 'square 4 is the single corner, h8');
  assert.equal(squareIndex(5), 8, 'square 5 is a7');
  assert.equal(squareIndex(29), 56, 'square 29 is a1');
  assert.equal(squareIndex(32), 62);
  for (let n = 1; n <= 32; n++) {
    assert.ok(isDark(squareIndex(n)));
    assert.equal(squareNumber(squareIndex(n)), n);
  }
  assert.equal(squareNumber(0), 0, 'light squares have no number');
  for (const junk of [0, 33, 1.5, '5']) assert.equal(squareIndex(junk), -1);
});

test('FEN round-trips, kings included', () => {
  assert.equal(toFEN(fromFEN(START_FEN)), START_FEN);
  const fen = 'W:W18,K26:B1,2,K14';
  assert.equal(toFEN(fromFEN(fen)), fen);
  assert.throws(() => fromFEN('X:W1:B2'), /bad FEN/);
  assert.throws(() => fromFEN('B:W1:B1'), /bad FEN/, 'two pieces on one square');
});

// Published counts for English draughts from the opening position.
test('perft from the start position', () => {
  const pos = fromFEN(START_FEN);
  [7, 49, 302, 1469, 7361, 36768].forEach((expected, i) => assert.equal(perft(pos, i + 1), expected, `depth ${i + 1}`));
});

/* ---------------- how pieces move ---------------- */

test('Black opens, and men only move forward', () => {
  const pos = fromFEN(START_FEN);
  assert.equal(pos.turn, 'b');
  assert.deepEqual(notes(pos), ['10-14', '10-15', '11-15', '11-16', '12-16', '9-13', '9-14']);
  assert.deepEqual(notes(fromFEN('W:W18:B1')), ['18-14', '18-15'], 'White moves up the board');
});

test('kings move one square either way, not across the board', () => {
  assert.deepEqual(notes(fromFEN('B:W32:BK15')), ['15-10', '15-11', '15-18', '15-19']);
});

test('capturing is compulsory', () => {
  const pos = fromFEN('B:W14:B9,12');
  assert.equal(mustCapture(pos), true);
  assert.deepEqual(notes(pos), ['9x18'], 'the man on 12 cannot just step');
  assert.equal(mustCapture(fromFEN(START_FEN)), false);
});

test('a multi-jump has to be finished, but any route will do', () => {
  const s = match({ fen: 'B:W6,14,15,22:B1' });
  assert.deepEqual(notes(s.pos), ['1x10x17x26', '1x10x19']);
  assert.throws(() => play(s, ['1x10']), /illegal move/, 'stopping halfway');
  const [{ note, move }] = play(s, ['1x10x19']);
  assert.equal(note, '1x10x19', 'the shorter route is legal');
  assert.deepEqual(move.captured.map(squareNumber), [6, 15]);
  assert.equal(pieceOn(s, 19), 'b');
  assert.equal(pieceOn(s, 6), null);
  assert.equal(pieceOn(s, 15), null);
  assert.equal(pieceOn(s, 14), 'w', 'pieces off the route stay');
});

test('reaching the far row crowns a man and ends the move', () => {
  // As a king on 31 it could jump 27 straight away — but crowning stops it.
  const s = match({ fen: 'B:W26,27:B22' });
  const [{ note, move }] = play(s, ['22x31']);
  assert.equal(note, '22x31');
  assert.equal(move.crown, true);
  assert.equal(pieceOn(s, 31), 'B');
  assert.equal(pieceOn(s, 27), 'w');
  assert.equal(s.pos.turn, 'w');
});

test('kings capture backwards, and pieces are lifted only once the move is over', () => {
  assert.deepEqual(notes(fromFEN('B:W18:BK23')), ['23x14']);
  // A king among four pieces has routes that circle back towards where it
  // started; none of them may jump the same piece twice.
  const pos = fromFEN('B:W6,7,14,15:BK1');
  for (const m of legalMoves(pos)) assert.equal(new Set(m.captured).size, m.captured.length);
});

/* ---------------- how games end ---------------- */

test('taking the last piece wins', () => {
  const s = match({ fen: 'B:W6:B1' });
  const [last] = play(s, ['1x10']);
  assert.equal(last.over, true);
  assert.deepEqual(s.result, { winner: 'p0', loser: 'p1', reason: 'captured' });
  assert.deepEqual(s.scores, { p0: 1, p1: 0 });
  assert.deepEqual(movesFrom(s, squareIndex(10)), [], 'a finished game offers no moves');
  assert.throws(() => play(s, ['10-14']), /illegal move/);
});

test('leaving the opponent with no legal move wins', () => {
  // White's man on 32 is hemmed in by 27 and 28, and 23 guards the jump.
  const s = match({ fen: 'B:W32:B1,23,27,28' });
  play(s, ['1-5']);
  assert.deepEqual(s.result, { winner: 'p0', loser: 'p1', reason: 'blocked' });
});

test('threefold repetition draws on the third occurrence, not before', () => {
  const s = match({ fen: 'B:WK32:BK1' });
  const shuffle = ['1-5', '32-27', '5-1', '27-32'];
  play(s, [...shuffle, ...shuffle.slice(0, 3)]);
  assert.equal(s.phase, 'playing', 'the start has only been seen twice');
  play(s, ['27-32']);
  assert.deepEqual(s.result, { winner: null, reason: 'repetition' });
  assert.equal(s.draws, 1);
});

test('forty moves each without a capture or a man moving is a draw', () => {
  const s = match({ fen: 'B:WK32,20:BK1' });
  s.pos.quiet = QUIET_LIMIT - 2;
  play(s, ['1-5']);
  assert.equal(s.phase, 'playing');
  play(s, ['32-27']);
  assert.deepEqual(s.result, { winner: null, reason: 'forty' });
});

test('a man moving resets the quiet count', () => {
  const s = match({ fen: 'B:WK32,20:BK1' });
  s.pos.quiet = QUIET_LIMIT - 2;
  play(s, ['1-5', '20-16']);
  assert.equal(s.pos.quiet, 0);
  assert.equal(s.phase, 'playing');
});

/* ---------------- the match ---------------- */

test('colours come from the coin toss unless fixed', () => {
  assert.equal(createState(seats(), { rng: () => 0.1 }).black, 0);
  assert.equal(createState(seats(), { rng: () => 0.9 }).black, 1);
  const s = createState(seats(), { rng: () => 0.9 });
  assert.equal(colourOfSeat(s, 'p1'), 'b');
  assert.equal(seatOfColour(s, 'b').id, 'p1');
  assert.equal(currentSeat(s).id, 'p1', 'Black moves first');
  assert.equal(colourOfSeat(s, 'nobody'), null);
});

test('you cannot move out of turn, or move the other side\'s pieces', () => {
  const s = match();
  const w = { from: squareIndex(22), path: [squareIndex(18)] };
  assert.throws(() => applyMove(s, 'p1', w), /illegal move/);
  assert.throws(() => applyMove(s, 'p0', w), /illegal move/);
  const b = squareIndex(11);
  for (const junk of [{}, { from: b }, { from: b, path: squareIndex(15) }, { from: String(b), path: [squareIndex(15)] },
    { from: b, path: [String(squareIndex(15))] }, { from: b, path: [squareIndex(15), squareIndex(19)] }]) {
    assert.throws(() => applyMove(s, 'p0', junk), /illegal move/);
  }
  assert.equal(toFEN(s.pos), START_FEN, 'nothing was played');
});

test('resigning hands the game to the other player, on either turn', () => {
  const s = match();
  resign(s, 'p1');
  assert.deepEqual(s.result, { winner: 'p0', loser: 'p1', reason: 'resign' });
  assert.throws(() => resign(s, 'p0'), /not allowed/);
});

test('draw offers: only the other player can answer', () => {
  const s = match();
  offerDraw(s, 'p0');
  assert.throws(() => offerDraw(s, 'p1'), /not allowed/, 'one offer at a time');
  assert.throws(() => acceptDraw(s, 'p0'), /not allowed/, 'you cannot accept your own offer');
  declineDraw(s, 'p1');
  assert.equal(s.drawOffer, null);

  offerDraw(s, 'p1');
  acceptDraw(s, 'p0');
  assert.deepEqual(s.result, { winner: null, reason: 'agreement' });
  assert.equal(s.draws, 1);
});

test('moving instead of answering declines a draw; the offerer moving does not', () => {
  const s = match();
  offerDraw(s, 'p0');
  play(s, ['11-15']);
  assert.equal(s.drawOffer, 'p0');
  play(s, ['22-18']);
  assert.equal(s.drawOffer, null);
});

test('agreeDraw ends a live game and nothing else', () => {
  const s = match();
  agreeDraw(s);
  assert.equal(s.result.reason, 'agreement');
  assert.throws(() => agreeDraw(s), /not allowed/);
});

test('a rematch swaps colours, keeps the score, and resets the board', () => {
  const s = match();
  play(s, ['11-15']);
  assert.throws(() => rematch(s), /game is not over/);
  resign(s, 'p1');

  rematch(s);
  assert.equal(s.game, 2);
  assert.equal(s.phase, 'playing');
  assert.equal(colourOfSeat(s, 'p1'), 'b');
  assert.equal(currentSeat(s).id, 'p1');
  assert.equal(toFEN(s.pos), START_FEN);
  assert.deepEqual(s.history, []);
  assert.equal(s.lastMove, null);
  assert.equal(s.result, null);
  assert.deepEqual(s.scores, { p0: 1, p1: 0 });
});

test('a same-device rematch keeps the colours where they are', () => {
  const s = match({ swapOnRematch: false });
  resign(s, 'p0');
  rematch(s);
  assert.equal(colourOfSeat(s, 'p0'), 'b');
});

test('the whole state survives the wire', () => {
  const s = match();
  play(s, ['11-15', '22-18', '15x22']);
  offerDraw(s, 'p1');
  assert.deepEqual(structuredClone(s), s);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});
