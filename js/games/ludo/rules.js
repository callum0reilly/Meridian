// Ludo rules. Pure logic — no DOM, no network, no randomness except rollDice().
// Everything here is deterministic given a state, which is what makes the
// host-authoritative model safe and the whole thing testable in node.
//
// ---- How a token's position is modelled ----
//
// Each token stores `r`, its own step count, NOT an absolute board square.
// Every player counts from their own start square, which removes all the
// per-colour special-casing from the movement code:
//
//   r = -1        in the yard (not yet on the board)
//   r = 0..50     on the shared 52-square track
//                 absolute square = (START[colour] + r) % 52
//   r = 51..55    in that colour's 5-square home column (private, uncapturable)
//   r = 56        home
//
// So a token needs exactly 56 steps from its start square to get home, and it
// walks 51 of the 52 shared squares — it branches off into its home column
// right before it would land back on its own start square. That's the classic
// board, and it falls out of the numbering for free.

export const COLORS = ['red', 'green', 'yellow', 'blue'];

export const TRACK_LEN = 52;
export const HOME_COL_LEN = 5;
export const LAST_TRACK_STEP = 50; // r=50 is the final shared square
export const HOME_STEP = 56;       // r=56 is home
export const YARD = -1;
export const TOKENS_PER_PLAYER = 4;

// Where each colour joins the shared track. Evenly spaced, quarter turns apart.
export const START = { red: 0, green: 13, yellow: 26, blue: 39 };

// Safe squares: the four start squares, plus the four stars 8 along from each.
// Nothing can be captured while standing on one.
export const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/** Absolute track square for a token, or null if it isn't on the shared track. */
export function absSquare(color, r) {
  if (r < 0 || r > LAST_TRACK_STEP) return null;
  return (START[color] + r) % TRACK_LEN;
}

export const isHome = (r) => r === HOME_STEP;
export const inYard = (r) => r === YARD;
export const inHomeColumn = (r) => r > LAST_TRACK_STEP && r < HOME_STEP;

/** Every token sharing an absolute square, as {color, i}. */
export function tokensAt(state, abs) {
  const out = [];
  for (const color of seatColors(state)) {
    state.tokens[color].forEach((r, i) => {
      if (absSquare(color, r) === abs) out.push({ color, i });
    });
  }
  return out;
}

const seatColors = (state) => state.seats.map((s) => s.color);

/**
 * A block is two or more of one colour stacked on a square. Blocks can't be
 * captured. (They do not bar passage in this variant — you may move through and
 * land on a block, you just can't send it home.)
 */
export function isBlock(state, abs, color) {
  return tokensAt(state, abs).filter((t) => t.color === color).length >= 2;
}

export function createState(seats) {
  const tokens = {};
  for (const s of seats) tokens[s.color] = Array(TOKENS_PER_PLAYER).fill(YARD);
  return {
    phase: 'playing',
    seats,             // [{id, name, color, connected}] — array order is turn order
    turn: 0,           // index into seats
    dice: null,        // last roll, null while waiting for a roll
    moves: [],         // token indices that dice can legally move
    sixes: 0,          // consecutive 6s this turn
    winner: null,
    tokens,
    log: [],
  };
}

export const currentSeat = (state) => state.seats[state.turn];

/** Token indices `color` could legally move with `dice`. */
export function legalMoves(state, color, dice) {
  if (!dice) return [];
  const out = [];
  state.tokens[color].forEach((r, i) => {
    if (isHome(r)) return;
    // Leaving the yard needs a 6.
    if (inYard(r)) { if (dice === 6) out.push(i); return; }
    // Home needs an exact roll — overshooting is not a move.
    if (r + dice <= HOME_STEP) out.push(i);
  });
  return out;
}

export function rollDice(rng = Math.random) {
  return 1 + Math.floor(rng() * 6);
}

/**
 * Apply a roll. Mutates state and returns what happened so the caller can
 * narrate it. Does not advance the turn — that's applyMove/passTurn.
 */
export function applyRoll(state, dice) {
  state.dice = dice;
  state.sixes = dice === 6 ? state.sixes + 1 : 0;

  // Three 6s in a row burns the turn: the third one is void, no move allowed.
  if (state.sixes === 3) {
    state.moves = [];
    return { forfeit: true };
  }

  state.moves = legalMoves(state, currentSeat(state).color, dice);
  return { forfeit: false, stuck: state.moves.length === 0 };
}

/**
 * Move token `i` of the current player. Mutates state.
 * @returns {{captured: Array, extraTurn: boolean, won: boolean}}
 */
export function applyMove(state, i) {
  const color = currentSeat(state).color;
  const dice = state.dice;
  if (!state.moves.includes(i)) throw new Error('illegal move');

  const from = state.tokens[color][i];
  const to = inYard(from) ? 0 : from + dice;
  state.tokens[color][i] = to;

  const captured = [];
  const abs = absSquare(color, to);
  // Captures only happen on the shared track, and never on a safe square.
  if (abs !== null && !SAFE.has(abs)) {
    for (const t of tokensAt(state, abs)) {
      if (t.color === color) continue;
      if (isBlock(state, abs, t.color)) continue; // stacked pair is immune
      state.tokens[t.color][t.i] = YARD;
      captured.push(t);
    }
  }

  const won = state.tokens[color].every(isHome);
  if (won) {
    state.phase = 'over';
    state.winner = color;
  }

  // A 6 or a capture buys another go. Landing a token home does not.
  const extraTurn = !won && (dice === 6 || captured.length > 0);
  return { captured, extraTurn, won, from, to };
}

/** Hand over to the next connected player (or the same one, on an extra turn). */
export function passTurn(state, { keepSeat = false } = {}) {
  state.dice = null;
  state.moves = [];
  if (keepSeat) return;

  state.sixes = 0;
  // Skip anyone who dropped out, but never spin forever if everyone's gone.
  for (let n = 0; n < state.seats.length; n++) {
    state.turn = (state.turn + 1) % state.seats.length;
    if (state.seats[state.turn].connected) return;
  }
}
