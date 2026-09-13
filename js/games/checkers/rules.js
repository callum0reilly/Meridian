// Checkers. Pure logic — no DOM, no network.
//
// Same shape as chess/rules.js: the host owns one state object, mutates it
// through these functions, and every function reports what happened so the
// caller can narrate it. The only randomness is who gets Black in the first
// game, and that is injectable.
//
// ---- Which checkers ----
//
// English draughts, a.k.a. American checkers — the 8×8 game most people mean.
// Men move one square diagonally forward. Capturing is compulsory, and a
// capture that can carry on must: you choose which route, not the longest one.
// Kings move and capture one square in any diagonal direction (no flying
// kings). A man that reaches the far row is crowned, and that ends the move
// even in the middle of a multi-jump. Black moves first.
//
// ---- Layers ----
//
// As in chess: a pure *position* layer (board, side to move, quiet-move count)
// where `makeMove` returns a new position, and a *match* layer on top with
// seats, colours, scores, draw offers and results.
//
// ---- Squares ----
//
// A board is 64 entries in reading order, index 0 top-left, so `i >> 3` is the
// row and `i & 7` the file — the same layout as chess, which lets the two
// screens share their board code's shape. Only the dark squares, where
// row + file is odd, are ever used. Black starts on the top three rows and
// moves down the board; White starts on the bottom three and moves up.
//
// Notation numbers the 32 dark squares 1–32 in reading order from Black's
// side, as every checkers book does: Black starts on 1–12, White on 21–32, and
// the classic opening "11-15" means here what it means there. A move is
// written "11-15", a capture "15x24", a multi-jump with every landing square
// "15x24x31".
//
// Pieces are 'b' and 'w' for men, 'B' and 'W' for kings, null for empty.
// Plain strings, so a whole state survives structuredClone and the wire.
//
// ---- How games end ----
//
// The side to move with no legal move loses, whether every piece has been
// taken or the ones left are all blocked in. Threefold repetition and forty
// moves each without a capture or a man moving are draws, and — the same call
// as chess — the game claims them for you the moment they happen.

export const PLAYERS = 2;
export const START_FEN = 'B:W21,22,23,24,25,26,27,28,29,30,31,32:B1,2,3,4,5,6,7,8,9,10,11,12';
export const QUIET_LIMIT = 80;   // half-moves — forty each

export const colourOf = (p) => (p ? p.toLowerCase() : null);
export const opponent = (c) => (c === 'w' ? 'b' : 'w');
export const isKing = (p) => !!p && p === p.toUpperCase();
export const isDark = (i) => ((i >> 3) + (i & 7)) % 2 === 1;

/** Square index for a row/file pair, or -1 if it falls off the board. */
const at = (r, f) => (r >= 0 && r < 8 && f >= 0 && f < 8 ? r * 8 + f : -1);

/** Book number (1–32) of a dark square, or 0 for anything else. */
export function squareNumber(i) {
  return Number.isInteger(i) && i >= 0 && i < 64 && isDark(i) ? (i >> 3) * 4 + ((i & 7) >> 1) + 1 : 0;
}

/** Board index of book square `n`, or -1. Even rows start on file b, odd on a. */
export function squareIndex(n) {
  if (!Number.isInteger(n) || n < 1 || n > 32) return -1;
  const r = (n - 1) >> 2;
  return r * 8 + ((n - 1) & 3) * 2 + (r % 2 === 0 ? 1 : 0);
}

/* ============================ positions ============================ */

/** PDN FEN: side to move, then each colour's squares, kings prefixed K —
 *  "W:W18,K26:B1,2,K14". */
export function fromFEN(fen) {
  const [turn, ...lists] = fen.trim().split(':');
  if (turn !== 'B' && turn !== 'W') throw new Error('bad FEN');
  const board = Array(64).fill(null);
  for (const list of lists) {
    const colour = list[0]?.toLowerCase();
    if (colour !== 'b' && colour !== 'w') throw new Error('bad FEN');
    for (const tok of list.slice(1).split(',').filter(Boolean)) {
      const king = tok[0] === 'K';
      const i = squareIndex(Number(king ? tok.slice(1) : tok));
      if (i < 0 || board[i]) throw new Error('bad FEN');
      board[i] = king ? colour.toUpperCase() : colour;
    }
  }
  return { board, turn: turn.toLowerCase(), quiet: 0 };
}

export function toFEN(pos) {
  const list = (colour) => pos.board
    .map((p, i) => (colourOf(p) === colour ? (isKing(p) ? 'K' : '') + squareNumber(i) : null))
    .filter(Boolean)
    .join(',');
  return `${pos.turn.toUpperCase()}:W${list('w')}:B${list('b')}`;
}

/* ============================== moves ============================== */

// A move is { from, to, path, captured, piece, crown }. `path` is every square
// the piece lands on, in order, so `to` is its last entry; `captured` is the
// square of each piece jumped, in the same order. A plain step has a path of
// one and nothing captured. `crown` is whether it ends by making a king.

const DIAGONALS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const FORWARD = { b: 1, w: -1 };
const crownRow = (colour) => (colour === 'b' ? 7 : 0);

const directions = (p) => (isKing(p) ? DIAGONALS : DIAGONALS.filter(([dr]) => dr === FORWARD[colourOf(p)]));

function moveOf(board, from, path, captured) {
  const piece = board[from];
  const to = path[path.length - 1];
  return { from, to, path, captured, piece, crown: !isKing(piece) && to >> 3 === crownRow(colourOf(piece)) };
}

/**
 * Every complete capture sequence for the piece on `from`. Jumped pieces stay
 * on the board until the move is over — they can't be jumped twice, and they
 * still block a landing — which is the English rule. The square the piece
 * started on is empty for the whole sequence, so a king can loop back through it.
 */
function jumpsFrom(board, from, out) {
  const piece = board[from];
  const colour = colourOf(piece);
  const walk = (sq, path, captured) => {
    let more = false;
    for (const [dr, df] of directions(piece)) {
      const land = at((sq >> 3) + 2 * dr, (sq & 7) + 2 * df);
      if (land < 0) continue;
      const over = sq + 8 * dr + df;
      const victim = board[over];
      if (!victim || colourOf(victim) === colour || captured.includes(over)) continue;
      if (board[land] && land !== from) continue;
      more = true;
      const nextPath = [...path, land];
      const nextCaptured = [...captured, over];
      // Crowning ends the move, even if the new king could jump again.
      if (!isKing(piece) && land >> 3 === crownRow(colour)) out.push(moveOf(board, from, nextPath, nextCaptured));
      else walk(land, nextPath, nextCaptured);
    }
    if (!more && path.length) out.push(moveOf(board, from, path, captured));
  };
  walk(from, [], []);
}

/** Every legal move for the side to move — or just those from one square.
 *  Captures are compulsory, so if any piece can take, only captures count. */
export function legalMoves(pos, from = null) {
  const { board, turn } = pos;
  const jumps = [];
  const steps = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p || colourOf(p) !== turn) continue;
    jumpsFrom(board, i, jumps);
    if (jumps.length) continue;   // once there is a capture, plain steps are moot
    for (const [dr, df] of directions(p)) {
      const to = at((i >> 3) + dr, (i & 7) + df);
      if (to >= 0 && !board[to]) steps.push(moveOf(board, i, [to], []));
    }
  }
  const moves = jumps.length ? jumps : steps;
  return from === null ? moves : moves.filter((m) => m.from === from);
}

/** Does the side to move have to capture? */
export const mustCapture = (pos) => legalMoves(pos).some((m) => m.captured.length > 0);

/** Play a move on a position. Returns a new position; `pos` is untouched.
 *  Trusts the move — only ever call it with one from `legalMoves`. */
export function makeMove(pos, m) {
  const board = pos.board.slice();
  board[m.from] = null;
  for (const sq of m.captured) board[sq] = null;
  board[m.to] = m.crown ? m.piece.toUpperCase() : m.piece;
  return {
    board,
    turn: opponent(pos.turn),
    quiet: m.captured.length || !isKing(m.piece) ? 0 : pos.quiet + 1,
  };
}

export function toNotation(m) {
  return [m.from, ...m.path].map(squareNumber).join(m.captured.length ? 'x' : '-');
}

const positionKey = (pos) => pos.board.map((p) => p || '.').join('') + pos.turn;

/* ============================== match ============================== */

/**
 * @param seats exactly two
 * @param opts.black  seat index that plays Black (and so moves first) in game 1;
 *        random if omitted
 * @param opts.swapOnRematch  online, colours alternate so neither player keeps
 *        the first move. On one laptop the seats *are* the colours, so it's off.
 */
export function createState(seats, { black, rng = Math.random, swapOnRematch = true, fen = START_FEN } = {}) {
  const scores = {};
  for (const s of seats) scores[s.id] = 0;
  const state = {
    phase: 'playing',    // playing | over
    seats,
    game: 1,
    black: black ?? (rng() < 0.5 ? 0 : 1),
    swapOnRematch,
    scores,
    draws: 0,
    startFen: fen,
    pos: null,
    history: [],         // every move so far, in notation
    lastMove: null,      // { from, path, captured }
    repetitions: {},     // position key -> times seen since the last capture or man move
    drawOffer: null,     // seat id of whoever has a draw offer standing
    result: null,        // { winner: id|null, loser?: id, reason }
  };
  setUp(state);
  return state;
}

function setUp(state) {
  state.phase = 'playing';
  state.pos = fromFEN(state.startFen);
  state.history = [];
  state.lastMove = null;
  state.drawOffer = null;
  state.result = null;
  state.repetitions = {};
  record(state);
}

function record(state) {
  const key = positionKey(state.pos);
  state.repetitions[key] = (state.repetitions[key] || 0) + 1;
  return state.repetitions[key];
}

export const seatOfColour = (state, colour) => state.seats[colour === 'b' ? state.black : 1 - state.black];
export const currentSeat = (state) => seatOfColour(state, state.pos.turn);
export function colourOfSeat(state, id) {
  const i = state.seats.findIndex((s) => s.id === id);
  return i < 0 ? null : i === state.black ? 'b' : 'w';
}

/** Legal moves from one square, or none once the game is over. */
export function movesFrom(state, from) {
  if (state.phase !== 'playing' || !Number.isInteger(from) || from < 0 || from > 63) return [];
  return legalMoves(state.pos, from);
}

/**
 * Play a move for `seatId`, named by where it starts and every square it
 * lands on. Throws on anything illegal — including stopping a multi-jump
 * short — rather than fudging it: the host validates first, so reaching here
 * with a bad move means a stale client, not a misclick.
 *
 * @returns {{note, move, over, result}}
 */
export function applyMove(state, seatId, { from, path } = {}) {
  if (state.phase !== 'playing' || currentSeat(state).id !== seatId) throw new Error('illegal move');
  const move = Array.isArray(path) && legalMoves(state.pos).find((m) =>
    m.from === from && m.path.length === path.length && m.path.every((sq, k) => sq === path[k]));
  if (!move) throw new Error('illegal move');

  const note = toNotation(move);
  state.pos = makeMove(state.pos, move);
  state.history.push(note);
  state.lastMove = { from, path: move.path, captured: move.captured };
  // Moving instead of answering a draw offer declines it. The player who
  // offered can go on to make their own move without withdrawing it.
  if (state.drawOffer && state.drawOffer !== seatId) state.drawOffer = null;
  // A capture or a man moving can never be undone, so no earlier position can
  // come round again — forget them.
  if (state.pos.quiet === 0) state.repetitions = {};
  const seen = record(state);

  const loser = state.seats.find((s) => s.id !== seatId).id;
  let result = null;
  if (!legalMoves(state.pos).length) {
    const left = state.pos.board.some((p) => colourOf(p) === state.pos.turn);
    result = { winner: seatId, loser, reason: left ? 'blocked' : 'captured' };
  } else if (seen >= 3) {
    result = { winner: null, reason: 'repetition' };
  } else if (state.pos.quiet >= QUIET_LIMIT) {
    result = { winner: null, reason: 'forty' };
  }
  if (result) finish(state, result);

  return { note, move, over: !!result, result };
}

function finish(state, result) {
  state.phase = 'over';
  state.result = result;
  state.drawOffer = null;
  if (result.winner) state.scores[result.winner] += 1;
  else state.draws += 1;
}

const isSeat = (state, id) => state.seats.some((s) => s.id === id);

/** Either player may resign at any time, whoever's move it is. */
export function resign(state, seatId) {
  if (state.phase !== 'playing' || !isSeat(state, seatId)) throw new Error('not allowed');
  const winner = state.seats.find((s) => s.id !== seatId).id;
  finish(state, { winner, loser: seatId, reason: 'resign' });
  return state.result;
}

export function offerDraw(state, seatId) {
  if (state.phase !== 'playing' || !isSeat(state, seatId) || state.drawOffer) throw new Error('not allowed');
  state.drawOffer = seatId;
}

/** Only the player who was offered the draw can take it or turn it down. */
export function acceptDraw(state, seatId) {
  if (!state.drawOffer || state.drawOffer === seatId || !isSeat(state, seatId)) throw new Error('not allowed');
  return agreeDraw(state);
}

export function declineDraw(state, seatId) {
  if (!state.drawOffer || state.drawOffer === seatId || !isSeat(state, seatId)) throw new Error('not allowed');
  state.drawOffer = null;
}

/** A draw both players have agreed to. On one laptop there is nobody to send
 *  an offer to, so the UI goes straight here. */
export function agreeDraw(state) {
  if (state.phase !== 'playing') throw new Error('not allowed');
  finish(state, { winner: null, reason: 'agreement' });
  return state.result;
}

/** Fresh game, same seats, scores kept. Colours swap unless told not to. */
export function rematch(state) {
  if (state.phase !== 'over') throw new Error('game is not over');
  state.game += 1;
  if (state.swapOnRematch) state.black = 1 - state.black;
  setUp(state);
}
