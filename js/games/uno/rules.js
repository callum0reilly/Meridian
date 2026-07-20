// Uno rules. Pure logic — no DOM, no network. Randomness is injected (`rng`)
// so a whole game can be replayed deterministically in a test.
//
// Mirrors the shape of ludo/rules.js: the host owns one state object, mutates
// it through these functions, and every function reports what happened so the
// caller can narrate it into the log.
//
// ---- The house rules we settled on ----
//
//   * Draw cards stack, upward only: +2 on +2, +4 on +2, +4 on +4 — but never
//     a +2 on a +4. The penalty accumulates and lands on the first player who
//     can't or won't continue the chain.
//   * A +4 is only *honest* if you hold no card of the active colour, but you
//     are allowed to bluff — the next player may challenge (official rule).
//     A +4 played onto an existing chain is never challengeable: nobody could
//     have played a colour there anyway, so there is no bluff to catch.
//   * You draw exactly one card when stuck, and may play it immediately.
//   * Rounds are scored; first to `target` (default 500) wins the match.
//
// ---- Active face ----
//
// The top of the discard pile is not enough to know what's playable: a wild
// takes on a colour that isn't printed on it. So the state carries the active
// face separately — `color` always, and `value` only when the top card is a
// coloured card. `value: null` means "the top is a wild, match the colour".

export const COLORS = ['red', 'green', 'yellow', 'blue'];
export const ACTIONS = ['skip', 'rev', 'draw2'];

export const HAND_SIZE = 7;
export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = 2;
export const DEFAULT_TARGET = 500;
export const CATCH_PENALTY = 2;      // caught without calling Uno
export const CHALLENGE_PENALTY = 2;  // added to the +4 when a challenge fails

export const isWild = (card) => card.value === 'wild' || card.value === 'wild4';
export const isDrawCard = (card) => card.value === 'draw2' || card.value === 'wild4';

/** Standard 108-card deck. Ids make otherwise-identical cards clickable. */
export function buildDeck() {
  const deck = [];
  let n = 0;
  const add = (color, value) => deck.push({ id: 'c' + (n++), color, value });

  for (const color of COLORS) {
    add(color, 0);                                  // one zero per colour
    for (let v = 1; v <= 9; v++) { add(color, v); add(color, v); }
    for (const a of ACTIONS) { add(color, a); add(color, a); }
  }
  for (let i = 0; i < 4; i++) { add(null, 'wild'); add(null, 'wild4'); }
  return deck;
}

/** Fisher-Yates, in place. */
export function shuffle(cards, rng = Math.random) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function cardPoints(card) {
  if (typeof card.value === 'number') return card.value;
  if (isWild(card)) return 50;
  return 20; // skip, reverse, +2
}

export const handPoints = (hand) => hand.reduce((sum, c) => sum + cardPoints(c), 0);

/* ============================== setup ============================== */

export function createState(seats, { target = DEFAULT_TARGET, rng = Math.random } = {}) {
  const scores = {};
  for (const s of seats) scores[s.id] = 0;
  const state = {
    phase: 'playing',   // playing | roundover | over
    seats,              // array order is seat order; `dir` decides which way round
    target,
    round: 1,
    scores,
    turn: 0,
    dir: 1,
    hands: {},
    draw: [],
    discard: [],
    color: null,
    value: null,
    pending: null,      // {kind:'draw2'|'wild4', amount} — an unresolved draw chain
    challenge: null,    // {playerId, byId, bluffed} — a +4 awaiting challenge/accept
    drawnId: null,      // card drawn this turn, still playable until you pass
    mustPass: false,    // you drew and can't play it: only Pass is left
    said: {},           // seat id -> called Uno
    catchable: null,    // {playerId} — down to one card without calling it
    roundWinner: null,
    winner: null,
    log: [],
  };
  deal(state, rng);
  return state;
}

/** Fresh deck, fresh hands, same scores. Used for round 2 onwards too. */
export function deal(state, rng = Math.random) {
  state.draw = shuffle(buildDeck(), rng);
  state.discard = [];
  state.hands = {};
  state.said = {};
  state.pending = null;
  state.challenge = null;
  state.drawnId = null;
  state.mustPass = false;
  state.catchable = null;
  state.roundWinner = null;
  state.dir = 1;
  state.turn = 0;

  for (const seat of state.seats) {
    state.hands[seat.id] = state.draw.splice(0, HAND_SIZE);
    state.said[seat.id] = false;
  }

  // Flip the starting card. A +4 can't start a round, so bury it and try again.
  let first;
  for (;;) {
    first = state.draw.shift();
    if (first.value !== 'wild4') break;
    state.draw.splice(Math.floor(rng() * state.draw.length), 0, first);
  }
  state.discard.push(first);
  state.color = first.color;
  state.value = isWild(first) ? null : first.value;

  // The opening card acts on the first player, exactly as if it had been played.
  const opener = { kind: null };
  // Only one step, unlike a skip played mid-game: there the current seat is the
  // player who played it, here it is the player being skipped.
  if (first.value === 'skip') { opener.kind = 'skip'; advance(state, 1); }
  else if (first.value === 'rev') { opener.kind = 'rev'; state.dir = -1; advance(state, 1); }
  else if (first.value === 'draw2') { opener.kind = 'draw2'; state.pending = { kind: 'draw2', amount: 2 }; }
  else if (first.value === 'wild') { opener.kind = 'wild'; }  // first player picks the colour
  state.opener = opener;
  return opener;
}

/** The first player names a colour when the round opens on a wild. */
export function applyOpeningColor(state, seatId, color) {
  if (!needsOpeningColor(state)) throw new Error('no opening colour to choose');
  if (currentSeat(state).id !== seatId) throw new Error('not your turn');
  if (!COLORS.includes(color)) throw new Error('bad colour');
  state.color = color;
  state.discard[0].color = color;
  return { color };
}

export const currentSeat = (state) => state.seats[state.turn];
export const handOf = (state, id) => state.hands[id] || [];

/** True while the opening wild is still waiting for the first player's colour. */
export const needsOpeningColor = (state) =>
  state.discard.length === 1 && isWild(state.discard[0]) && state.color === null;

/* ============================ legality ============================ */

/**
 * Can `card` be played right now? Note this permits a bluffed +4 — the colour
 * restriction on +4 is enforced by the challenge, not by blocking the play.
 */
export function canPlay(state, card) {
  // Mid-chain: only draw cards continue it, and only upward.
  if (state.pending) {
    if (state.pending.kind === 'draw2') return card.value === 'draw2' || card.value === 'wild4';
    return card.value === 'wild4';
  }
  if (isWild(card)) return true;
  if (card.color === state.color) return true;
  return state.value !== null && card.value === state.value;
}

/** Card ids in `seatId`'s hand that are legal right now. */
export function legalPlays(state, seatId) {
  if (state.phase !== 'playing') return [];
  if (currentSeat(state).id !== seatId) return [];
  if (needsOpeningColor(state)) return [];   // name the colour first
  if (state.challenge) return handOf(state, seatId).filter((c) => c.value === 'wild4').map((c) => c.id);
  if (state.mustPass) return [];
  // After drawing, only the drawn card is still in play this turn.
  const hand = state.drawnId
    ? handOf(state, seatId).filter((c) => c.id === state.drawnId)
    : handOf(state, seatId);
  return hand.filter((c) => canPlay(state, c)).map((c) => c.id);
}

/** Would playing this +4 be a bluff — i.e. do they hold the active colour? */
export function isBluff(state, seatId, cardId) {
  return handOf(state, seatId).some((c) => c.id !== cardId && c.color === state.color);
}

/* ============================ the pile ============================ */

/**
 * Take `n` cards. If the draw pile runs dry, everything below the top of the
 * discard is shuffled back in. If even that isn't enough the hand just gets
 * fewer cards — with 10 players and a stacked chain the deck really can run out.
 */
export function drawCards(state, seatId, n, rng = Math.random) {
  const taken = [];
  for (let i = 0; i < n; i++) {
    if (!state.draw.length) {
      const top = state.discard.pop();
      if (!state.discard.length) { state.discard.push(top); break; }
      state.draw = shuffle(state.discard, rng);
      state.discard = [top];
      // Wilds go back to the pile colourless, ready to be re-chosen.
      for (const c of state.draw) if (isWild(c)) c.color = null;
    }
    taken.push(state.draw.shift());
  }
  state.hands[seatId].push(...taken);
  if (state.hands[seatId].length > 1) state.said[seatId] = false;
  if (state.catchable?.playerId === seatId) state.catchable = null;
  return taken;
}

/* ============================ turn flow ============================ */

/** Move `steps` seats along `dir`, skipping anyone who has disconnected. */
export function advance(state, steps = 1) {
  const n = state.seats.length;
  for (let s = 0; s < steps; s++) {
    for (let guard = 0; guard < n; guard++) {
      state.turn = (state.turn + state.dir + n) % n;
      if (state.seats[state.turn].connected) break;
    }
  }
}

/** Everyone still in the room. A round can't continue below two. */
export const activeSeats = (state) => state.seats.filter((s) => s.connected);

function startTurn(state) {
  state.drawnId = null;
  state.mustPass = false;
}

/* ============================== plays ============================== */

/**
 * Play a card. Throws on an illegal play rather than fudging it — the host
 * validates first, so reaching here with a bad card is a bug, not a user error.
 *
 * @returns {{card, effect, chained, uno, roundOver, challengeable}}
 */
export function applyPlay(state, seatId, cardId, chosenColor = null) {
  if (!legalPlays(state, seatId).includes(cardId)) throw new Error('illegal play');

  const hand = state.hands[seatId];
  const card = hand.splice(hand.findIndex((c) => c.id === cardId), 1)[0];
  const stacking = !!state.pending;

  // Recorded before the discard changes the active colour.
  const bluffed = card.value === 'wild4' && !stacking && isBluff(state, seatId, cardId);

  state.discard.push(card);
  state.challenge = null;
  startTurn(state);

  if (isWild(card)) {
    const color = COLORS.includes(chosenColor) ? chosenColor : COLORS[0];
    card.color = color;         // remembered so the pile renders in that colour
    state.color = color;
    state.value = null;
  } else {
    state.color = card.color;
    state.value = card.value;
  }

  // Going out ends the round immediately — trailing action cards do nothing.
  if (!hand.length) {
    const res = endRound(state, seatId);
    return { card, effect: null, chained: stacking, uno: false, roundOver: true, ...res };
  }

  // Down to one card without having called it: catchable until they act again.
  if (hand.length === 1 && !state.said[seatId]) state.catchable = { playerId: seatId };

  let effect = null;
  let challengeable = false;

  if (card.value === 'draw2' || card.value === 'wild4') {
    const amount = (state.pending?.amount || 0) + (card.value === 'draw2' ? 2 : 4);
    state.pending = { kind: card.value, amount };
    effect = card.value;
    advance(state, 1);
    // Only a freely-played +4 can be a bluff worth challenging.
    if (card.value === 'wild4' && !stacking) {
      state.challenge = { playerId: seatId, byId: currentSeat(state).id, bluffed };
      challengeable = true;
    }
  } else if (card.value === 'skip') {
    effect = 'skip';
    advance(state, 2);
  } else if (card.value === 'rev') {
    effect = 'rev';
    state.dir = -state.dir;
    // With two players a reverse is a skip: flipping direction would hand the
    // turn straight back to the player who just went.
    advance(state, activeSeats(state).length === 2 ? 2 : 1);
  } else {
    advance(state, 1);
  }

  return { card, effect, chained: stacking, uno: hand.length === 1, roundOver: false, challengeable };
}

/** Draw your one card for the turn. Playable immediately if it happens to fit. */
export function applyDraw(state, seatId, rng = Math.random) {
  if (state.phase !== 'playing' || currentSeat(state).id !== seatId) throw new Error('not your turn');
  if (state.pending || state.challenge) throw new Error('resolve the draw chain first');
  if (state.drawnId) throw new Error('already drew this turn');

  const [card] = drawCards(state, seatId, 1, rng);
  if (!card) { state.mustPass = true; return { card: null, playable: false }; }

  const playable = canPlay(state, card);
  state.drawnId = playable ? card.id : null;
  state.mustPass = !playable;
  return { card, playable };
}

/** Give up the turn after drawing. Only legal once you've drawn. */
export function applyPass(state, seatId) {
  if (currentSeat(state).id !== seatId) throw new Error('not your turn');
  if (!state.drawnId && !state.mustPass) throw new Error('you must draw first');
  startTurn(state);
  advance(state, 1);
}

/** Take the accumulated chain on the chin. Ends your turn. */
export function applyTakeDraw(state, seatId, rng = Math.random) {
  if (currentSeat(state).id !== seatId) throw new Error('not your turn');
  if (!state.pending) throw new Error('nothing to draw');

  const amount = state.pending.amount;
  drawCards(state, seatId, amount, rng);
  state.pending = null;
  state.challenge = null;
  startTurn(state);
  advance(state, 1);
  return { amount };
}

/* =========================== +4 challenge =========================== */

/**
 * Challenge the +4 you're facing.
 *   bluff caught  → the player who lied draws 4, and your turn carries on.
 *   wrong call    → you draw 4 + 2 and lose your turn.
 */
export function applyChallenge(state, seatId, rng = Math.random) {
  const ch = state.challenge;
  if (!ch || ch.byId !== seatId) throw new Error('nothing to challenge');

  const amount = state.pending.amount;
  state.challenge = null;
  state.pending = null;

  if (ch.bluffed) {
    drawCards(state, ch.playerId, amount, rng);
    startTurn(state);                       // the challenger keeps the turn
    return { caught: true, drew: amount, by: seatId, from: ch.playerId };
  }

  const penalty = amount + CHALLENGE_PENALTY;
  drawCards(state, seatId, penalty, rng);
  startTurn(state);
  advance(state, 1);                        // and loses the turn
  return { caught: false, drew: penalty, by: seatId, from: ch.playerId };
}

/* ============================ calling Uno ============================ */

/** Call it. Allowed at two cards (about to go down to one) or at one. */
export function applySayUno(state, seatId) {
  if (handOf(state, seatId).length > 2) return false;
  state.said[seatId] = true;
  if (state.catchable?.playerId === seatId) state.catchable = null;
  return true;
}

/** Catch someone who forgot. Anyone but them may do it, once. */
export function applyCatch(state, byId, rng = Math.random) {
  const target = state.catchable?.playerId;
  if (!target || target === byId) throw new Error('nobody to catch');
  state.catchable = null;
  drawCards(state, target, CATCH_PENALTY, rng);
  return { caught: target, drew: CATCH_PENALTY };
}

/* ============================== scoring ============================== */

/** Round winner banks the value of every other hand. */
export function endRound(state, winnerId) {
  let gained = 0;
  for (const seat of state.seats) {
    if (seat.id === winnerId) continue;
    gained += handPoints(handOf(state, seat.id));
  }
  state.scores[winnerId] += gained;
  state.roundWinner = winnerId;
  state.pending = null;
  state.challenge = null;
  state.catchable = null;

  if (state.scores[winnerId] >= state.target) {
    state.phase = 'over';
    state.winner = winnerId;
  } else {
    state.phase = 'roundover';
  }
  return { gained, total: state.scores[winnerId], matchOver: state.phase === 'over' };
}

/** Deal the next round. The previous round's winner leads. */
export function nextRound(state, rng = Math.random) {
  if (state.phase !== 'roundover') throw new Error('round is not over');
  const lead = state.seats.findIndex((s) => s.id === state.roundWinner);
  const opener = deal(state, rng);
  state.round += 1;
  state.phase = 'playing';

  // deal() lays out from seat 0; rotate onto the winner, keeping any opening
  // card effect (a skip or reverse shifted the turn) intact.
  if (lead >= 0) {
    const shift = (state.turn - 0 + state.seats.length) % state.seats.length;
    state.turn = (lead + shift) % state.seats.length;
    if (!state.seats[state.turn].connected) advance(state, 1);
  }
  return opener;
}
