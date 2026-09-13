// Chess. Pure logic — no DOM, no network.
//
// Same shape as xo/rules.js: the host owns one state object, mutates it through
// these functions, and every function reports what happened so the caller can
// narrate it. The only randomness is who gets White in the first game, and
// that is injectable.
//
// ---- Layers ----
//
// Two of them. The bottom half works on a *position* — board, side to move,
// castling rights, en passant square, move clocks — and knows nothing about
// players. It is pure: `makeMove` returns a new position rather than editing
// the old one, which is what lets `legalMoves` try a move, look for check, and
// throw the result away. The top half wraps a position in a *match*: seats,
// colours, scores, draw offers, results.
//
// ---- Squares ----
//
// A board is 64 entries in reading order from White's side of the table turned
// upside down: index 0 is a8, 7 is h8, 56 is a1, 63 is h1. So `i >> 3` is the
// row counted from the top and `i & 7` is the file. Pieces are FEN letters —
// uppercase White, lowercase Black — or null for an empty square. Plain
// strings, so a whole state survives structuredClone and the wire unchanged.
//
// ---- Draws ----
//
// Stalemate, insufficient material, threefold repetition and the fifty-move
// rule all end the game on their own, the moment they happen. Over the board
// the last two are *claimed*, not automatic, but a claim button nobody knows
// to press just lets a dead game drag on — so, as on most sites, the game
// claims them for you.

export const PLAYERS = 2;
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const PROMOTIONS = ['q', 'r', 'b', 'n'];

const FILES = 'abcdefgh';

export const squareName = (i) => FILES[i & 7] + (8 - (i >> 3));
export function squareIndex(name) {
  const m = /^([a-h])([1-8])$/.exec(name);
  return m ? (8 - Number(m[2])) * 8 + FILES.indexOf(m[1]) : -1;
}

export const colourOf = (p) => (p ? (p === p.toUpperCase() ? 'w' : 'b') : null);
export const opponent = (c) => (c === 'w' ? 'b' : 'w');
const typeOf = (p) => p.toLowerCase();

/* ============================ positions ============================ */

export function fromFEN(fen) {
  const [placement, turn = 'w', castling = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/);
  const board = [];
  for (const rank of placement.split('/')) {
    for (const ch of rank) {
      if (/[1-8]/.test(ch)) for (let k = 0; k < Number(ch); k++) board.push(null);
      else if (/[pnbrqk]/i.test(ch)) board.push(ch);
      else throw new Error('bad FEN');
    }
  }
  if (board.length !== 64 || (turn !== 'w' && turn !== 'b')) throw new Error('bad FEN');
  return {
    board,
    turn,
    castling: castling === '-' ? '' : castling,
    ep: ep === '-' ? null : squareIndex(ep),
    halfmove: Number(half),
    fullmove: Number(full),
  };
}

export function toFEN(pos) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = '';
    let gap = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos.board[r * 8 + f];
      if (!p) { gap++; continue; }
      if (gap) { row += gap; gap = 0; }
      row += p;
    }
    rows.push(row + (gap || ''));
  }
  const ep = pos.ep === null ? '-' : squareName(pos.ep);
  return `${rows.join('/')} ${pos.turn} ${pos.castling || '-'} ${ep} ${pos.halfmove} ${pos.fullmove}`;
}

/* ============================= attacks ============================= */

// Offsets as [rows, files].
const KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const ORTHOGONAL = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const DIAGONAL = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

/** Square index for a row/file pair, or -1 if it falls off the board. */
const at = (r, f) => (r >= 0 && r < 8 && f >= 0 && f < 8 ? r * 8 + f : -1);

/** Is square `sq` attacked by any piece of colour `by`? Looks outward from the
 *  square for each kind of attacker, rather than generating the attacker's
 *  moves — much cheaper, and it is the hottest function in the file. */
export function isAttacked(board, sq, by) {
  const r = sq >> 3;
  const f = sq & 7;
  const own = (p) => (by === 'w' ? p.toUpperCase() : p);

  // White pawns attack up the board, so a White attacker sits one row below.
  const pawnRow = by === 'w' ? r + 1 : r - 1;
  for (const df of [-1, 1]) {
    const i = at(pawnRow, f + df);
    if (i >= 0 && board[i] === own('p')) return true;
  }
  for (const [dr, df] of KNIGHT) {
    const i = at(r + dr, f + df);
    if (i >= 0 && board[i] === own('n')) return true;
  }
  for (const [dr, df] of KING) {
    const i = at(r + dr, f + df);
    if (i >= 0 && board[i] === own('k')) return true;
  }
  const rays = (dirs, slider) => {
    for (const [dr, df] of dirs) {
      for (let rr = r + dr, ff = f + df; at(rr, ff) >= 0; rr += dr, ff += df) {
        const p = board[rr * 8 + ff];
        if (!p) continue;
        if (p === own(slider) || p === own('q')) return true;
        break;
      }
    }
    return false;
  };
  return rays(ORTHOGONAL, 'r') || rays(DIAGONAL, 'b');
}

export const kingSquare = (board, colour) => board.indexOf(colour === 'w' ? 'K' : 'k');

/** Is `colour` (by default, the side to move) in check? */
export function inCheck(pos, colour = pos.turn) {
  const k = kingSquare(pos.board, colour);
  return k >= 0 && isAttacked(pos.board, k, opponent(colour));
}

/* ============================== moves ============================== */

// A move is { from, to, piece, captured, promo, flag }. `promo` is a lowercase
// piece letter or null; `flag` is 'double' | 'ep' | 'castle' | null.

/** Moves for the piece on `from` that obey how it moves, ignoring whether they
 *  leave its own king in check. `legalMoves` filters that out. */
function pseudoMoves(pos, from, out) {
  const { board, turn } = pos;
  const p = board[from];
  if (!p || colourOf(p) !== turn) return;
  const r = from >> 3;
  const f = from & 7;
  const add = (to, extra = {}) =>
    out.push({ from, to, piece: p, captured: board[to], promo: null, flag: null, ...extra });
  const enemy = (i) => board[i] && colourOf(board[i]) !== turn;

  const steps = (offsets) => {
    for (const [dr, df] of offsets) {
      const to = at(r + dr, f + df);
      if (to >= 0 && (!board[to] || enemy(to))) add(to);
    }
  };
  const slides = (dirs) => {
    for (const [dr, df] of dirs) {
      for (let rr = r + dr, ff = f + df; at(rr, ff) >= 0; rr += dr, ff += df) {
        const to = rr * 8 + ff;
        if (!board[to]) { add(to); continue; }
        if (enemy(to)) add(to);
        break;
      }
    }
  };

  switch (typeOf(p)) {
    case 'p': {
      const dir = turn === 'w' ? -1 : 1;
      const lastRow = turn === 'w' ? 0 : 7;
      // A pawn reaching the last row is four moves, one per promotion piece.
      const pawnTo = (to) => {
        if (to >> 3 === lastRow) for (const promo of PROMOTIONS) add(to, { promo });
        else add(to);
      };
      const one = at(r + dir, f);
      if (one >= 0 && !board[one]) {
        pawnTo(one);
        const two = at(r + 2 * dir, f);
        if (r === (turn === 'w' ? 6 : 1) && !board[two]) add(two, { flag: 'double' });
      }
      for (const df of [-1, 1]) {
        const to = at(r + dir, f + df);
        if (to < 0) continue;
        if (enemy(to)) pawnTo(to);
        else if (to === pos.ep) add(to, { flag: 'ep', captured: turn === 'w' ? 'p' : 'P' });
      }
      break;
    }
    case 'n': steps(KNIGHT); break;
    case 'b': slides(DIAGONAL); break;
    case 'r': slides(ORTHOGONAL); break;
    case 'q': slides(ORTHOGONAL); slides(DIAGONAL); break;
    case 'k': {
      steps(KING);
      // Castling: the right still held, the rook still home, the squares
      // between empty, and the king neither in check nor passing through an
      // attacked square. Landing in check is caught by the legality filter.
      const home = turn === 'w' ? 60 : 4;
      const them = opponent(turn);
      if (from !== home || isAttacked(board, home, them)) break;
      const [kSide, qSide, rook] = turn === 'w' ? ['K', 'Q', 'R'] : ['k', 'q', 'r'];
      if (pos.castling.includes(kSide) && board[home + 3] === rook &&
          !board[home + 1] && !board[home + 2] && !isAttacked(board, home + 1, them)) {
        add(home + 2, { flag: 'castle' });
      }
      if (pos.castling.includes(qSide) && board[home - 4] === rook &&
          !board[home - 1] && !board[home - 2] && !board[home - 3] && !isAttacked(board, home - 1, them)) {
        add(home - 2, { flag: 'castle' });
      }
      break;
    }
  }
}

/** Play a move on a position. Returns a new position; `pos` is untouched.
 *  Trusts the move — only ever call it with one from `legalMoves`. */
export function makeMove(pos, m) {
  const board = pos.board.slice();
  const colour = pos.turn;
  board[m.to] = m.promo ? (colour === 'w' ? m.promo.toUpperCase() : m.promo) : board[m.from];
  board[m.from] = null;
  if (m.flag === 'ep') board[m.to + (colour === 'w' ? 8 : -8)] = null;
  if (m.flag === 'castle') {
    const [rookFrom, rookTo] = m.to > m.from ? [m.from + 3, m.from + 1] : [m.from - 4, m.from - 1];
    board[rookTo] = board[rookFrom];
    board[rookFrom] = null;
  }

  // A king move loses both rights. Anything leaving or landing on a rook's
  // home corner loses that one — a rook moving away, or being captured there.
  let castling = pos.castling;
  const strip = (chars) => { for (const ch of chars) castling = castling.replace(ch, ''); };
  if (m.piece === 'K') strip('KQ');
  if (m.piece === 'k') strip('kq');
  for (const sq of [m.from, m.to]) {
    if (sq === 63) strip('K');
    if (sq === 56) strip('Q');
    if (sq === 7) strip('k');
    if (sq === 0) strip('q');
  }

  return {
    board,
    turn: opponent(colour),
    castling,
    ep: m.flag === 'double' ? (m.from + m.to) / 2 : null,
    halfmove: typeOf(m.piece) === 'p' || m.captured ? 0 : pos.halfmove + 1,
    fullmove: pos.fullmove + (colour === 'b' ? 1 : 0),
  };
}

/** Every legal move for the side to move — or just those from one square. */
export function legalMoves(pos, from = null) {
  const pseudo = [];
  if (from === null) for (let i = 0; i < 64; i++) pseudoMoves(pos, i, pseudo);
  else pseudoMoves(pos, from, pseudo);
  return pseudo.filter((m) => !inCheck(makeMove(pos, m), pos.turn));
}

/* ========================= notation + draws ========================= */

/** Standard algebraic notation for a legal move: Nf3, exd5, e8=Q+, O-O-O#. */
export function toSAN(pos, m, legal = legalMoves(pos)) {
  let san;
  if (m.flag === 'castle') {
    san = m.to > m.from ? 'O-O' : 'O-O-O';
  } else if (typeOf(m.piece) === 'p') {
    san = (m.captured ? FILES[m.from & 7] + 'x' : '') + squareName(m.to) +
          (m.promo ? '=' + m.promo.toUpperCase() : '');
  } else {
    // Name the origin only as far as it takes to tell this piece apart from
    // an identical one that could also reach the square: file, then rank,
    // then both.
    const rivals = legal.filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
    let from = '';
    if (rivals.length) {
      if (!rivals.some((o) => (o.from & 7) === (m.from & 7))) from = FILES[m.from & 7];
      else if (!rivals.some((o) => o.from >> 3 === m.from >> 3)) from = String(8 - (m.from >> 3));
      else from = squareName(m.from);
    }
    san = m.piece.toUpperCase() + from + (m.captured ? 'x' : '') + squareName(m.to);
  }
  const next = makeMove(pos, m);
  if (inCheck(next)) san += legalMoves(next).length ? '+' : '#';
  return san;
}

/** Can neither side ever deliver mate? Bare kings, a single minor piece, or
 *  bishops that all stand on the same colour of square. */
export function insufficientMaterial(board) {
  const rest = [];
  board.forEach((p, i) => { if (p && typeOf(p) !== 'k') rest.push([typeOf(p), i]); });
  if (rest.length === 0) return true;
  if (rest.length === 1 && (rest[0][0] === 'n' || rest[0][0] === 'b')) return true;
  if (rest.every(([t]) => t === 'b')) {
    const shade = (i) => ((i >> 3) + (i & 7)) % 2;
    return rest.every(([, i]) => shade(i) === shade(rest[0][1]));
  }
  return false;
}

/**
 * What makes two positions "the same" for repetition: pieces, side to move,
 * castling rights, and the en passant square — but only when a capture there
 * is actually possible. A double push that nothing can take en passant does
 * not make the position different from the one without it.
 */
function positionKey(pos, legal) {
  const ep = legal.some((m) => m.flag === 'ep') ? pos.ep : '-';
  return pos.board.map((p) => p || '.').join('') + pos.turn + pos.castling + ep;
}

/* ============================== match ============================== */

/**
 * @param seats exactly two
 * @param opts.white  seat index that plays White in game 1; random if omitted
 * @param opts.swapOnRematch  online, colours alternate so neither player keeps
 *        the first move. On one laptop the seats *are* the colours, so it's off.
 */
export function createState(seats, { white, rng = Math.random, swapOnRematch = true, fen = START_FEN } = {}) {
  const scores = {};
  for (const s of seats) scores[s.id] = 0;
  const state = {
    phase: 'playing',    // playing | over
    seats,
    game: 1,
    white: white ?? (rng() < 0.5 ? 0 : 1),
    swapOnRematch,
    scores,
    draws: 0,
    startFen: fen,
    pos: null,
    sans: [],            // every move so far, in SAN
    lastMove: null,      // { from, to }
    repetitions: {},     // position key -> times seen since the last capture or pawn move
    drawOffer: null,     // seat id of whoever has a draw offer standing
    result: null,        // { winner: id|null, loser?: id, reason }
  };
  setUp(state);
  return state;
}

function setUp(state) {
  state.phase = 'playing';
  state.pos = fromFEN(state.startFen);
  state.sans = [];
  state.lastMove = null;
  state.drawOffer = null;
  state.result = null;
  state.repetitions = {};
  record(state, legalMoves(state.pos));
}

function record(state, legal) {
  const key = positionKey(state.pos, legal);
  state.repetitions[key] = (state.repetitions[key] || 0) + 1;
  return state.repetitions[key];
}

export const seatOfColour = (state, colour) => state.seats[colour === 'w' ? state.white : 1 - state.white];
export const currentSeat = (state) => seatOfColour(state, state.pos.turn);
export function colourOfSeat(state, id) {
  const i = state.seats.findIndex((s) => s.id === id);
  return i < 0 ? null : i === state.white ? 'w' : 'b';
}

/** Legal moves from one square, or none once the game is over. */
export function movesFrom(state, from) {
  if (state.phase !== 'playing' || !Number.isInteger(from) || from < 0 || from > 63) return [];
  return legalMoves(state.pos, from);
}

/**
 * Play a move for `seatId`. Throws on anything illegal rather than fudging it —
 * the host validates first, so reaching here with a bad move means a stale
 * client, not a misclick. A promotion must name its piece.
 *
 * @returns {{san, move, check, over, result}}
 */
export function applyMove(state, seatId, { from, to, promo = null } = {}) {
  if (state.phase !== 'playing' || currentSeat(state).id !== seatId) throw new Error('illegal move');
  const legal = legalMoves(state.pos);
  const move = legal.find((m) => m.from === from && m.to === to && m.promo === promo);
  if (!move) throw new Error('illegal move');

  const san = toSAN(state.pos, move, legal);
  state.pos = makeMove(state.pos, move);
  state.sans.push(san);
  state.lastMove = { from, to };
  // Moving instead of answering a draw offer declines it. The player who
  // offered can go on to make their own move without withdrawing it.
  if (state.drawOffer && state.drawOffer !== seatId) state.drawOffer = null;
  // A capture or pawn move can never be undone, so no earlier position can
  // come round again — forget them.
  if (state.pos.halfmove === 0) state.repetitions = {};

  const next = legalMoves(state.pos);
  const seen = record(state, next);
  const check = inCheck(state.pos);

  // Mate outranks every draw: a checkmate delivered on the hundredth
  // half-move still wins.
  let result = null;
  if (!next.length) result = check ? { winner: seatId, reason: 'checkmate' } : { winner: null, reason: 'stalemate' };
  else if (insufficientMaterial(state.pos.board)) result = { winner: null, reason: 'material' };
  else if (seen >= 3) result = { winner: null, reason: 'repetition' };
  else if (state.pos.halfmove >= 100) result = { winner: null, reason: 'fifty' };
  if (result) finish(state, result);

  return { san, move, check, over: !!result, result };
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
  if (state.swapOnRematch) state.white = 1 - state.white;
  setUp(state);
}
