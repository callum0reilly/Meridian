// Noughts and crosses. Pure logic — no DOM, no network.
//
// Same shape as ludo/rules.js and uno/rules.js: the host owns one state object,
// mutates it through these functions, and every function reports what happened
// so the caller can narrate it into the log.
//
// Unlike the other two there is no `rng` to inject — nothing here is random, so
// a whole match is determined by its move list alone.
//
// ---- Fairness ----
//
// Played properly, 3x3 is a draw: the only real edge anyone has is moving
// first. A single game would therefore be decided by whoever got seat 0, so a
// match alternates it — the seat that opens (and plays X) swaps every round.
// Over a best-of series both players get the advantage the same number of
// times, and whoever wins did it on the board rather than on the seating.
//
// ---- Draws ----
//
// A drawn round scores nothing, but it still counts as a round played and the
// opener still alternates past it. Holding a draw back — replaying it as "the
// same round" — would leave whoever opened it opening the next one too, and
// since draws are the normal result between two competent players, that hands
// one seat the first move more or less permanently. `draws` is counted
// separately so the scoreboard can admit how many rounds went nowhere.

export const SIZE = 3;
export const CELLS = SIZE * SIZE;
export const PLAYERS = 2;
export const DEFAULT_TARGET = 3;   // rounds won to take the match

/** Every triple that wins: three rows, three columns, two diagonals. */
export const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

/* ============================== setup ============================== */

export function createState(seats, { target = DEFAULT_TARGET } = {}) {
  const scores = {};
  for (const s of seats) scores[s.id] = 0;
  const state = {
    phase: 'playing',   // playing | roundover | over
    seats,              // exactly two; index 0 and 1 are the only seats
    target,
    round: 1,
    scores,
    draws: 0,
    board: Array(CELLS).fill(null),
    turn: 0,            // seat index to move
    marks: {},          // seat id -> 'X' | 'O'
    starter: 0,         // seat index that opened this round (and so plays X)
    line: null,         // the winning triple, once there is one
    roundWinner: null,  // seat id, or null on a draw
    winner: null,       // seat id, once the match is decided
    log: [],
  };
  layOut(state);
  return state;
}

/**
 * Set up a round: empty board, marks assigned, starter to move.
 *
 * Derived from `round` rather than toggled from the previous round, so it can't
 * drift out of step if a round is ever set up twice.
 */
export function layOut(state) {
  state.board = Array(CELLS).fill(null);
  state.line = null;
  state.roundWinner = null;
  state.starter = (state.round - 1) % PLAYERS;
  state.turn = state.starter;
  // The seat that opens plays X. That is the whole of the alternation.
  state.marks = {};
  state.seats.forEach((s, i) => { state.marks[s.id] = i === state.starter ? 'X' : 'O'; });
  return { starter: state.seats[state.starter] };
}

export const currentSeat = (state) => state.seats[state.turn];
export const markOf = (state, id) => state.marks[id] ?? null;
export const seatOfMark = (state, mark) => state.seats.find((s) => state.marks[s.id] === mark) || null;

/* ============================ legality ============================ */

/** Indices still open. Empty once the round is over, so the UI goes inert. */
export function legalMoves(state) {
  if (state.phase !== 'playing') return [];
  return state.board.reduce((out, cell, i) => (cell === null ? (out.push(i), out) : out), []);
}

/** Can `seatId` take square `i` right now? */
export function canPlay(state, seatId, i) {
  if (state.phase !== 'playing') return false;
  if (currentSeat(state).id !== seatId) return false;
  if (!Number.isInteger(i) || i < 0 || i >= CELLS) return false;
  return state.board[i] === null;
}

/* ============================ the board ============================ */

/** The winning triple on this board, or null. Indices, not marks. */
export function winningLine(board) {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return line;
  }
  return null;
}

export const isFull = (board) => board.every((cell) => cell !== null);

/* ============================== plays ============================== */

/**
 * Take a square. Throws on an illegal move rather than fudging it — the host
 * validates first, so reaching here with a bad square is a bug, not a misclick.
 *
 * @returns {{index, mark, line, roundOver, draw, gained, total, matchOver}}
 */
export function applyMove(state, seatId, i) {
  if (!canPlay(state, seatId, i)) throw new Error('illegal move');

  const mark = state.marks[seatId];
  state.board[i] = mark;

  const line = winningLine(state.board);
  if (line) {
    state.line = line;
    const res = endRound(state, seatId);
    return { index: i, mark, line, roundOver: true, draw: false, ...res };
  }

  if (isFull(state.board)) {
    const res = endRound(state, null);
    return { index: i, mark, line: null, roundOver: true, draw: true, ...res };
  }

  state.turn = (state.turn + 1) % PLAYERS;
  return { index: i, mark, line: null, roundOver: false, draw: false };
}

/* ============================== scoring ============================== */

/**
 * Close the round. `winnerId` of null is a draw: nobody scores, and the match
 * can't end on one — a drawn round is replayed rather than decided.
 */
export function endRound(state, winnerId) {
  state.roundWinner = winnerId;

  if (winnerId === null) {
    state.draws += 1;
    state.phase = 'roundover';
    return { gained: 0, total: null, matchOver: false };
  }

  state.scores[winnerId] += 1;
  if (state.scores[winnerId] >= state.target) {
    state.phase = 'over';
    state.winner = winnerId;
  } else {
    state.phase = 'roundover';
  }
  return { gained: 1, total: state.scores[winnerId], matchOver: state.phase === 'over' };
}

/** Set up the next round. Drawn rounds advance the count like any other. */
export function nextRound(state) {
  if (state.phase !== 'roundover') throw new Error('round is not over');
  state.round += 1;
  state.phase = 'playing';
  return layOut(state);
}

/** Fresh match, same seats. Scores, rounds and draws all back to zero. */
export function resetMatch(state) {
  for (const s of state.seats) state.scores[s.id] = 0;
  state.round = 1;
  state.draws = 0;
  state.phase = 'playing';
  state.winner = null;
  const log = state.log;
  layOut(state);
  state.log = log;
  return { starter: state.seats[state.starter] };
}
