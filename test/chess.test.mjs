// Tests for the chess rules.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  START_FEN, PROMOTIONS,
  fromFEN, toFEN, squareIndex, squareName, legalMoves, makeMove, inCheck, isAttacked, toSAN,
  insufficientMaterial,
  createState, currentSeat, seatOfColour, colourOfSeat, movesFrom,
  applyMove, resign, offerDraw, acceptDraw, declineDraw, agreeDraw, rematch,
} from '../js/games/chess/rules.js';

/* ---------------- helpers ---------------- */

const seats = () => [
  { id: 'p0', name: 'P0', connected: true },
  { id: 'p1', name: 'P1', connected: true },
];

/** p0 on White unless told otherwise, so tests never depend on the coin toss. */
const match = (opts = {}) => createState(seats(), { white: 0, ...opts });

/** Play moves like 'e2e4' or 'a7a8q', always as whoever is to move. */
function play(s, moves) {
  const out = [];
  for (const uci of moves) {
    const from = squareIndex(uci.slice(0, 2));
    const to = squareIndex(uci.slice(2, 4));
    out.push(applyMove(s, currentSeat(s).id, { from, to, promo: uci[4] ?? null }));
  }
  return out;
}

const pieceAt = (s, name) => s.pos.board[squareIndex(name)];

/** Count leaf nodes of the legal move tree — the standard check that a move
 *  generator agrees with every other correct one. */
function perft(pos, depth) {
  const moves = legalMoves(pos);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(makeMove(pos, m), depth - 1);
  return n;
}

/* ---------------- move generation ---------------- */

// Published node counts (chessprogramming.org "Perft Results"). Between them
// these positions exercise castling through and out of check, en passant
// (including the discovered-check case), under-promotion and pins.
const PERFT = [
  ['start position', START_FEN, [20, 400, 8902, 197281]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['position 3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['position 4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
];

for (const [name, fen, counts] of PERFT) {
  test(`perft: ${name}`, () => {
    const pos = fromFEN(fen);
    counts.forEach((expected, i) => assert.equal(perft(pos, i + 1), expected, `depth ${i + 1}`));
  });
}

test('FEN round-trips', () => {
  for (const [, fen] of PERFT) assert.equal(toFEN(fromFEN(fen)), fen);
});

test('square names and indices agree', () => {
  assert.equal(squareIndex('a8'), 0);
  assert.equal(squareIndex('h1'), 63);
  assert.equal(squareIndex('e4'), 36);
  for (let i = 0; i < 64; i++) assert.equal(squareIndex(squareName(i)), i);
  assert.equal(squareIndex('i9'), -1);
});

test('a pinned piece cannot move', () => {
  const pos = fromFEN('k3r3/8/8/8/8/8/4N3/4K3 w - - 0 1');
  assert.deepEqual(legalMoves(pos, squareIndex('e2')), []);
});

test('attack detection sees every kind of piece', () => {
  const pos = fromFEN('4k3/8/8/3p4/8/8/8/4K3 w - - 0 1');
  assert.ok(isAttacked(pos.board, squareIndex('e4'), 'b'), 'black pawn d5 attacks e4');
  assert.ok(!isAttacked(pos.board, squareIndex('d4'), 'b'), 'but not the square in front of it');
});

/* ---------------- special moves ---------------- */

test('castling moves the rook and removes the rights', () => {
  const s = match({ fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' });
  const kingMoves = movesFrom(s, squareIndex('e1')).map((m) => squareName(m.to));
  assert.ok(kingMoves.includes('g1') && kingMoves.includes('c1'));

  const [{ san }] = play(s, ['e1g1']);
  assert.equal(san, 'O-O');
  assert.equal(pieceAt(s, 'g1'), 'K');
  assert.equal(pieceAt(s, 'f1'), 'R');
  assert.equal(pieceAt(s, 'h1'), null);
  assert.equal(s.pos.castling, 'kq');

  assert.equal(play(s, ['e8c8'])[0].san, 'O-O-O');
  assert.equal(pieceAt(s, 'd8'), 'r');
  assert.equal(s.pos.castling, '');
});

test('no castling out of, through, or into check', () => {
  const castles = (fen) => legalMoves(fromFEN(fen)).filter((m) => m.flag === 'castle').map((m) => squareName(m.to));
  assert.deepEqual(castles('r3k2r/8/8/8/8/8/4r3/R3K2R w KQkq - 0 1'), [], 'in check');
  assert.deepEqual(castles('r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1'), ['c1'], 'f1 is attacked');
  assert.deepEqual(castles('r3k2r/8/8/8/8/8/6r1/R3K2R w KQkq - 0 1'), ['c1'], 'g1 is attacked');
  // b1 being attacked does not stop queenside castling: the king never crosses it.
  assert.deepEqual(castles('r3k2r/8/8/8/8/8/1r6/R3K2R w KQkq - 0 1').sort(), ['c1', 'g1']);
});

test('a rook captured at home takes its castling right with it', () => {
  const s = match({ fen: 'r3k2r/8/8/8/8/8/6b1/R3K2R b KQkq - 0 1' });
  play(s, ['g2h1']);
  assert.equal(s.pos.castling, 'Qkq');
});

test('en passant: available straight away, gone a move later', () => {
  const s = match();
  play(s, ['e2e4', 'a7a6', 'e4e5', 'd7d5']);
  const ep = movesFrom(s, squareIndex('e5')).find((m) => m.flag === 'ep');
  assert.ok(ep, 'exd6 is on offer');
  const [{ san }] = play(s, ['e5d6']);
  assert.equal(san, 'exd6');
  assert.equal(pieceAt(s, 'd5'), null, 'the captured pawn is removed');
  assert.equal(pieceAt(s, 'd6'), 'P');

  const late = match();
  play(late, ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'a2a3', 'h7h6']);
  assert.ok(!movesFrom(late, squareIndex('e5')).some((m) => m.flag === 'ep'));
});

test('promotion needs a piece, and any of the four will do', () => {
  const fen = '8/P6k/8/8/8/8/8/K7 w - - 0 1';
  assert.equal(movesFrom(match({ fen }), squareIndex('a7')).length, PROMOTIONS.length);

  const s = match({ fen });
  assert.throws(() => play(s, ['a7a8']), /illegal move/);
  assert.throws(() => play(s, ['a7a8k']), /illegal move/);
  assert.equal(play(s, ['a7a8n'])[0].san, 'a8=N');
  assert.equal(pieceAt(s, 'a8'), 'N');
});

/* ---------------- notation ---------------- */

test('SAN for a short game', () => {
  const s = match();
  play(s, ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']);
  assert.deepEqual(s.sans, ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']);
});

test('SAN disambiguates by file, then rank', () => {
  const byFile = fromFEN('k7/8/8/8/8/8/8/KN3N2 w - - 0 1');
  const nbd2 = legalMoves(byFile).find((m) => m.from === squareIndex('b1') && m.to === squareIndex('d2'));
  assert.equal(toSAN(byFile, nbd2), 'Nbd2');

  const byRank = fromFEN('7k/8/8/R7/8/8/8/R6K w - - 0 1');
  const r1a3 = legalMoves(byRank).find((m) => m.from === squareIndex('a1') && m.to === squareIndex('a3'));
  assert.equal(toSAN(byRank, r1a3), 'R1a3');
});

/* ---------------- how games end ---------------- */

test('checkmate ends the game and scores the winner', () => {
  const s = match();
  const last = play(s, ['f2f3', 'e7e5', 'g2g4', 'd8h4']).at(-1);
  assert.equal(last.san, 'Qh4#');
  assert.equal(last.over, true);
  assert.equal(s.phase, 'over');
  assert.deepEqual(s.result, { winner: 'p1', reason: 'checkmate' });
  assert.deepEqual(s.scores, { p0: 0, p1: 1 });
  assert.deepEqual(movesFrom(s, squareIndex('e2')), [], 'a finished game offers no moves');
  assert.throws(() => play(s, ['e2e3']), /illegal move/);
});

test('stalemate is a draw', () => {
  const s = match({ fen: 'k7/8/8/2Q5/8/8/8/7K w - - 0 1' });
  play(s, ['c5b6']);
  assert.equal(inCheck(s.pos), false);
  assert.deepEqual(s.result, { winner: null, reason: 'stalemate' });
  assert.equal(s.draws, 1);
  assert.deepEqual(s.scores, { p0: 0, p1: 0 });
});

test('capturing down to a lone minor piece is a draw', () => {
  const s = match({ fen: 'k7/8/8/8/8/8/1r6/KB6 w - - 0 1' });
  play(s, ['a1b2']);
  assert.deepEqual(s.result, { winner: null, reason: 'material' });
});

test('insufficient material, case by case', () => {
  const board = (fen) => fromFEN(fen).board;
  assert.equal(insufficientMaterial(board('k7/8/8/8/8/8/8/K7 w - - 0 1')), true, 'bare kings');
  assert.equal(insufficientMaterial(board('k7/8/8/8/8/8/8/KN6 w - - 0 1')), true, 'one knight');
  assert.equal(insufficientMaterial(board('k7/8/8/8/8/8/8/KB5b w - - 0 1')), true, 'same-colour bishops');
  assert.equal(insufficientMaterial(board('k7/8/8/8/8/8/8/KB4b1 w - - 0 1')), false, 'opposite-colour bishops');
  assert.equal(insufficientMaterial(board('k7/8/8/8/8/8/8/KNN5 w - - 0 1')), false, 'two knights');
  assert.equal(insufficientMaterial(board('k7/8/8/8/8/8/P7/K7 w - - 0 1')), false, 'a pawn');
});

test('threefold repetition draws on the third occurrence, not before', () => {
  const s = match();
  const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
  play(s, [...shuffle, ...shuffle.slice(0, 3)]);
  assert.equal(s.phase, 'playing', 'the start position has only been seen twice');
  play(s, ['f6g8']);
  assert.deepEqual(s.result, { winner: null, reason: 'repetition' });
});

test('the fifty-move rule draws at the hundredth quiet half-move', () => {
  const s = match({ fen: 'k7/8/8/8/8/8/8/KR6 w - - 98 80' });
  play(s, ['b1b2']);
  assert.equal(s.phase, 'playing');
  play(s, ['a8a7']);
  assert.deepEqual(s.result, { winner: null, reason: 'fifty' });
});

test('mate on the hundredth half-move still wins', () => {
  const s = match({ fen: 'k7/8/1K6/8/8/8/8/7R w - - 99 80' });
  play(s, ['h1h8']);
  assert.deepEqual(s.result, { winner: 'p0', reason: 'checkmate' });
});

/* ---------------- the match ---------------- */

test('colours come from the coin toss unless fixed', () => {
  assert.equal(createState(seats(), { rng: () => 0.1 }).white, 0);
  assert.equal(createState(seats(), { rng: () => 0.9 }).white, 1);
  const s = createState(seats(), { rng: () => 0.9 });
  assert.equal(colourOfSeat(s, 'p1'), 'w');
  assert.equal(seatOfColour(s, 'w').id, 'p1');
  assert.equal(currentSeat(s).id, 'p1', 'White moves first');
  assert.equal(colourOfSeat(s, 'nobody'), null);
});

test('you cannot move out of turn, or move the other side\'s pieces', () => {
  const s = match();
  const e7e5 = { from: squareIndex('e7'), to: squareIndex('e5') };
  assert.throws(() => applyMove(s, 'p1', e7e5), /illegal move/);
  assert.throws(() => applyMove(s, 'p0', e7e5), /illegal move/);
  for (const junk of [{}, { from: -1, to: 3 }, { from: '52', to: '36' }, { from: 1.5, to: 36 }]) {
    assert.throws(() => applyMove(s, 'p0', junk), /illegal move/);
  }
  assert.equal(toFEN(s.pos), START_FEN, 'nothing was played');
});

test('resigning hands the game to the other player, on either turn', () => {
  const s = match();
  resign(s, 'p1');
  assert.deepEqual(s.result, { winner: 'p0', loser: 'p1', reason: 'resign' });
  assert.deepEqual(s.scores, { p0: 1, p1: 0 });
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
  play(s, ['e2e4']);
  assert.equal(s.drawOffer, 'p0', 'the offer stands after the offerer moves');
  play(s, ['e7e5']);
  assert.equal(s.drawOffer, null, 'replying with a move turned it down');
});

test('agreeDraw ends a live game and nothing else', () => {
  const s = match();
  agreeDraw(s);
  assert.equal(s.result.reason, 'agreement');
  assert.throws(() => agreeDraw(s), /not allowed/);
});

test('a rematch swaps colours, keeps the score, and resets the board', () => {
  const s = match();
  play(s, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  assert.throws(() => { const live = match(); rematch(live); }, /game is not over/);

  rematch(s);
  assert.equal(s.game, 2);
  assert.equal(s.phase, 'playing');
  assert.equal(colourOfSeat(s, 'p1'), 'w');
  assert.equal(currentSeat(s).id, 'p1');
  assert.equal(toFEN(s.pos), START_FEN);
  assert.deepEqual(s.sans, []);
  assert.equal(s.lastMove, null);
  assert.equal(s.result, null);
  assert.deepEqual(s.scores, { p0: 0, p1: 1 });
});

test('a same-device rematch keeps the colours where they are', () => {
  const s = match({ swapOnRematch: false });
  resign(s, 'p0');
  rematch(s);
  assert.equal(colourOfSeat(s, 'p0'), 'w');
});

test('the whole state survives the wire', () => {
  const s = match();
  play(s, ['e2e4', 'e7e5']);
  offerDraw(s, 'p0');
  assert.deepEqual(structuredClone(s), s);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});
