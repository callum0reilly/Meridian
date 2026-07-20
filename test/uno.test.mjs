// Tests for the Uno rules.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLORS, HAND_SIZE, DEFAULT_TARGET, CATCH_PENALTY, CHALLENGE_PENALTY,
  buildDeck, shuffle, cardPoints, handPoints, createState, deal, nextRound,
  currentSeat, canPlay, legalPlays, isBluff, drawCards, advance,
  applyPlay, applyDraw, applyPass, applyTakeDraw, applyChallenge,
  applySayUno, applyCatch, applyOpeningColor, needsOpeningColor, endRound,
} from '../js/games/uno/rules.js';

/* ---------------- helpers ---------------- */

// Deterministic rng so a failing test fails the same way twice.
function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seats = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'p' + i, name: 'P' + i, color: COLORS[i % 4], connected: true,
}));

let uid = 0;
const card = (color, value) => ({ id: 't' + (uid++), color, value });

/** A state with a known face-up card and hands you control. */
function table(n, top, hands = {}) {
  const s = createState(seats(n), { rng: seeded(7) });
  s.discard = [top];
  s.color = top.color;
  s.value = top.value === 'wild' || top.value === 'wild4' ? null : top.value;
  s.turn = 0;
  s.dir = 1;
  s.pending = null;
  s.challenge = null;
  s.drawnId = null;
  s.mustPass = false;
  for (const seat of s.seats) s.hands[seat.id] = hands[seat.id] ?? [card('red', 1)];
  return s;
}

const ids = (cards) => cards.map((c) => c.id);

/* ---------------- the deck ---------------- */

test('the deck is the standard 108 cards', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map((c) => c.id)).size, 108, 'every card needs a unique id');
});

test('deck composition: one zero, two of everything else, per colour', () => {
  const deck = buildDeck();
  for (const color of COLORS) {
    const mine = deck.filter((c) => c.color === color);
    assert.equal(mine.length, 25, `${color} should have 25 cards`);
    assert.equal(mine.filter((c) => c.value === 0).length, 1, `${color} has one zero`);
    for (const v of [1, 5, 9, 'skip', 'rev', 'draw2']) {
      assert.equal(mine.filter((c) => c.value === v).length, 2, `${color} ${v} should appear twice`);
    }
  }
  assert.equal(deck.filter((c) => c.value === 'wild').length, 4);
  assert.equal(deck.filter((c) => c.value === 'wild4').length, 4);
});

test('shuffle keeps every card, and actually moves them', () => {
  const before = buildDeck();
  const after = shuffle(buildDeck(), seeded(3));
  assert.deepEqual(new Set(after.map((c) => c.id)), new Set(before.map((c) => c.id)));
  assert.notDeepEqual(ids(after), ids(before));
});

test('card values: pips at face value, actions 20, wilds 50', () => {
  assert.equal(cardPoints(card('red', 0)), 0);
  assert.equal(cardPoints(card('red', 7)), 7);
  assert.equal(cardPoints(card('blue', 'skip')), 20);
  assert.equal(cardPoints(card('blue', 'rev')), 20);
  assert.equal(cardPoints(card('blue', 'draw2')), 20);
  assert.equal(cardPoints(card(null, 'wild')), 50);
  assert.equal(cardPoints(card(null, 'wild4')), 50);
  // 4 x (90 pips + 120 action) + 8 x 50 wild.
  assert.equal(handPoints(buildDeck()), 1240);
});

/* ---------------- dealing ---------------- */

test('everyone gets seven cards and the pile is short by exactly that many', () => {
  const s = createState(seats(4), { rng: seeded(11) });
  for (const seat of s.seats) assert.equal(s.hands[seat.id].length, HAND_SIZE);
  assert.equal(s.draw.length + s.discard.length + 4 * HAND_SIZE, 108);
  assert.equal(s.discard.length, 1);
});

test('a round never opens on a +4', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const s = createState(seats(3), { rng: seeded(seed) });
    assert.notEqual(s.discard[0].value, 'wild4', `seed ${seed} opened on a +4`);
  }
});

test('an opening wild waits for the first player to name a colour', () => {
  const s = createState(seats(2), { rng: seeded(1) });
  s.discard = [card(null, 'wild')];
  s.color = null;
  s.value = null;
  assert.ok(needsOpeningColor(s));
  assert.deepEqual(legalPlays(s, 'p0'), [], 'nothing is playable until a colour exists');
  applyOpeningColor(s, 'p0', 'green');
  assert.equal(s.color, 'green');
  assert.ok(!needsOpeningColor(s));
});

test('every opening card is dealt with — no round starts in limbo', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    const s = createState(seats(3), { rng: seeded(seed) });
    seen.add(s.opener.kind);
    const top = s.discard[0];
    if (top.value === 'draw2') {
      assert.deepEqual(s.pending, { kind: 'draw2', amount: 2 }, 'an opening +2 must land as a chain');
    } else if (top.value === 'skip') {
      assert.equal(currentSeat(s).id, 'p1', 'an opening skip burns the first turn');
    } else if (top.value === 'rev') {
      assert.equal(s.dir, -1);
      assert.equal(currentSeat(s).id, 'p2', 'an opening reverse turns play around');
    } else if (top.value === 'wild') {
      assert.ok(needsOpeningColor(s));
    } else {
      assert.equal(currentSeat(s).id, 'p0');
    }
  }
  assert.ok(seen.size > 1, 'the sample should cover more than one kind of opening card');
});

test('an opening +2 can be stacked rather than taken', () => {
  const s = table(3, card('red', 'draw2'), {
    p0: [card('blue', 'draw2'), card('red', 5)],
  });
  s.pending = { kind: 'draw2', amount: 2 };
  assert.deepEqual(legalPlays(s, 'p0'), [s.hands.p0[0].id], 'only the +2 continues the chain');
});

/* ---------------- matching ---------------- */

test('a card matches on colour or on value, and wilds always match', () => {
  const s = table(2, card('red', 5));
  assert.ok(canPlay(s, card('red', 9)), 'same colour');
  assert.ok(canPlay(s, card('blue', 5)), 'same value');
  assert.ok(canPlay(s, card(null, 'wild')));
  assert.ok(canPlay(s, card(null, 'wild4')));
  assert.ok(!canPlay(s, card('blue', 9)), 'neither colour nor value');
});

test('after a wild only the chosen colour matches — the card under it is dead', () => {
  const s = table(2, card('red', 5), { p0: [card(null, 'wild')] });
  applyPlay(s, 'p0', s.hands.p0[0].id, 'green');
  assert.equal(s.color, 'green');
  assert.equal(s.value, null);
  assert.ok(canPlay(s, card('green', 2)));
  assert.ok(!canPlay(s, card('blue', 5)), 'the 5 underneath must no longer count');
});

test('action cards match each other across colours', () => {
  const s = table(2, card('red', 'skip'));
  assert.ok(canPlay(s, card('blue', 'skip')));
  assert.ok(!canPlay(s, card('blue', 'rev')));
});

test('legalPlays only ever offers cards from your own hand, on your own turn', () => {
  const s = table(2, card('red', 5), { p0: [card('red', 1)], p1: [card('red', 2)] });
  assert.deepEqual(legalPlays(s, 'p0'), [s.hands.p0[0].id]);
  assert.deepEqual(legalPlays(s, 'p1'), [], 'not their turn');
});

/* ---------------- turn order ---------------- */

test('play passes down the seats and wraps', () => {
  const s = table(3, card('red', 5));
  assert.equal(currentSeat(s).id, 'p0');
  advance(s); assert.equal(currentSeat(s).id, 'p1');
  advance(s); assert.equal(currentSeat(s).id, 'p2');
  advance(s); assert.equal(currentSeat(s).id, 'p0');
});

test('reverse flips direction', () => {
  const s = table(3, card('red', 5), { p0: [card('red', 'rev'), card('red', 1)] });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  assert.equal(s.dir, -1);
  assert.equal(currentSeat(s).id, 'p2', 'play should now run the other way');
});

test('with two players a reverse acts as a skip', () => {
  const s = table(2, card('red', 5), { p0: [card('red', 'rev'), card('red', 1)] });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  assert.equal(currentSeat(s).id, 'p0', 'the turn must come back, not stall on p1');
});

test('skip jumps the next player', () => {
  const s = table(3, card('red', 5), { p0: [card('red', 'skip'), card('red', 1)] });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  assert.equal(currentSeat(s).id, 'p2');
});

test('disconnected players are skipped over', () => {
  const s = table(3, card('red', 5));
  s.seats[1].connected = false;
  advance(s);
  assert.equal(currentSeat(s).id, 'p2');
});

/* ---------------- drawing ---------------- */

test('you draw one card, and may play it if it fits', () => {
  const s = table(2, card('red', 5), { p0: [card('blue', 9)] });
  s.draw = [card('red', 3), card('blue', 1)];
  const res = applyDraw(s, 'p0');
  assert.ok(res.playable);
  assert.equal(s.hands.p0.length, 2);
  assert.deepEqual(legalPlays(s, 'p0'), [res.card.id], 'only the drawn card is live');
  applyPlay(s, 'p0', res.card.id);
  assert.equal(currentSeat(s).id, 'p1');
});

test('an unplayable drawn card leaves you nothing but Pass', () => {
  const s = table(2, card('red', 5), { p0: [card('blue', 9)] });
  s.draw = [card('blue', 1)];
  const res = applyDraw(s, 'p0');
  assert.ok(!res.playable);
  assert.ok(s.mustPass);
  assert.deepEqual(legalPlays(s, 'p0'), []);
  applyPass(s, 'p0');
  assert.equal(currentSeat(s).id, 'p1');
});

test('you cannot draw twice, nor pass before drawing', () => {
  const s = table(2, card('red', 5), { p0: [card('blue', 9)] });
  s.draw = [card('red', 3), card('red', 4)];
  assert.throws(() => applyPass(s, 'p0'), /must draw/);
  applyDraw(s, 'p0');
  assert.throws(() => applyDraw(s, 'p0'), /already drew/);
});

test('the discard is recycled when the draw pile runs out', () => {
  const s = table(2, card('red', 5), { p0: [] });
  const top = s.discard[0];
  s.draw = [];
  s.discard = [card('blue', 1), card('green', 2), card('yellow', 3), top];
  drawCards(s, 'p0', 2, seeded(5));
  assert.equal(s.hands.p0.length, 2);
  assert.deepEqual(s.discard, [top], 'the face-up card stays put');
  assert.equal(s.draw.length, 1);
});

test('recycled wilds forget the colour they were played as', () => {
  const s = table(2, card('red', 5), { p0: [] });
  const top = s.discard[0];
  const w = card('green', 'wild');   // was played as green
  s.draw = [];
  s.discard = [w, card('blue', 1), top];
  drawCards(s, 'p0', 1, seeded(5));
  const recycled = [...s.draw, ...s.hands.p0].find((c) => c.id === w.id);
  assert.equal(recycled.color, null);
});

/* ---------------- stacking ---------------- */

test('a +2 starts a chain rather than making the next player draw at once', () => {
  const s = table(3, card('red', 5), { p0: [card('red', 'draw2'), card('red', 1)] });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  assert.deepEqual(s.pending, { kind: 'draw2', amount: 2 });
  assert.equal(currentSeat(s).id, 'p1', 'p1 gets the chance to stack');
  assert.equal(s.hands.p1.length, 1, 'nobody has drawn yet');
});

test('+2 stacks on +2 and the penalty accumulates', () => {
  const s = table(3, card('red', 5), {
    p0: [card('red', 'draw2'), card('red', 1)],
    p1: [card('blue', 'draw2'), card('red', 1)],
  });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  applyPlay(s, 'p1', s.hands.p1[0].id);
  assert.equal(s.pending.amount, 4);
  assert.equal(currentSeat(s).id, 'p2');
});

test('a +2 stacks regardless of colour', () => {
  const s = table(2, card('red', 5), { p0: [card('red', 'draw2'), card('red', 1)], p1: [card('green', 'draw2'), card('red', 1)] });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  assert.deepEqual(legalPlays(s, 'p1'), [s.hands.p1[0].id]);
});

test('a +4 may be stacked onto a +2', () => {
  const s = table(3, card('red', 5), {
    p0: [card('red', 'draw2'), card('red', 1)],
    p1: [card(null, 'wild4'), card('red', 1)],
  });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  const res = applyPlay(s, 'p1', s.hands.p1[0].id, 'blue');
  assert.equal(s.pending.amount, 6, '2 + 4');
  assert.equal(s.pending.kind, 'wild4');
  assert.ok(!res.challengeable, 'a stacked +4 is not a bluff — nothing to challenge');
  assert.equal(s.challenge, null);
});

test('a +2 may NOT be stacked onto a +4 — the chain only goes upward', () => {
  const s = table(3, card('red', 5), {
    p0: [card(null, 'wild4'), card('red', 1)],
    p1: [card('blue', 'draw2'), card(null, 'wild4'), card('red', 1)],
  });
  applyPlay(s, 'p0', s.hands.p0[0].id, 'blue');
  const legal = legalPlays(s, 'p1');
  assert.ok(!legal.includes(s.hands.p1[0].id), 'the +2 must be refused');
  assert.ok(legal.includes(s.hands.p1[1].id), 'the +4 is still fine');
});

test('nothing but a draw card can be played into a chain', () => {
  const s = table(2, card('red', 5), {
    p0: [card('red', 'draw2'), card('red', 1)],
    p1: [card('red', 9), card(null, 'wild'), card('red', 'skip')],
  });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  assert.deepEqual(legalPlays(s, 'p1'), [], 'no colour match, no plain wild, no skip');
});

test('taking the chain draws the whole accumulated pile and ends the turn', () => {
  const s = table(3, card('red', 5), {
    p0: [card('red', 'draw2'), card('red', 1)],
    p1: [card('blue', 'draw2'), card('red', 1)],
    p2: [card('red', 1)],
  });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  applyPlay(s, 'p1', s.hands.p1[0].id);
  const res = applyTakeDraw(s, 'p2');
  assert.equal(res.amount, 4);
  assert.equal(s.hands.p2.length, 5);
  assert.equal(s.pending, null);
  assert.equal(currentSeat(s).id, 'p0', 'the chain victim loses their turn');
});

test('you cannot simply draw your one card while a chain is live', () => {
  const s = table(2, card('red', 5), { p0: [card('red', 'draw2'), card('red', 1)] });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  assert.throws(() => applyDraw(s, 'p1'), /draw chain/);
});

/* ---------------- the +4 challenge ---------------- */

test('a +4 is a bluff only if you held the active colour', () => {
  const s = table(2, card('red', 5), { p0: [card(null, 'wild4'), card('red', 2)] });
  assert.ok(isBluff(s, 'p0', s.hands.p0[0].id), 'holding a red makes it a bluff');

  const honest = table(2, card('red', 5), { p0: [card(null, 'wild4'), card('blue', 2)] });
  assert.ok(!isBluff(honest, 'p0', honest.hands.p0[0].id));
});

test('a caught bluff sends four cards back to the liar and leaves the turn put', () => {
  const s = table(2, card('red', 5), {
    p0: [card(null, 'wild4'), card('red', 2)],   // holding red — a bluff
    p1: [card('blue', 1)],
  });
  applyPlay(s, 'p0', s.hands.p0[0].id, 'blue');
  assert.ok(s.challenge);
  assert.equal(s.challenge.byId, 'p1');

  const res = applyChallenge(s, 'p1');
  assert.ok(res.caught);
  assert.equal(res.drew, 4);
  assert.equal(s.hands.p0.length, 5, '1 left + 4 drawn');
  assert.equal(s.hands.p1.length, 1, 'the challenger draws nothing');
  assert.equal(currentSeat(s).id, 'p1', 'and still gets their turn');
  assert.equal(s.pending, null);
});

test('a failed challenge costs six and the turn', () => {
  const s = table(3, card('red', 5), {
    p0: [card(null, 'wild4'), card('blue', 2)],  // no red — honest
    p1: [card('blue', 1)],
  });
  applyPlay(s, 'p0', s.hands.p0[0].id, 'blue');
  const res = applyChallenge(s, 'p1');
  assert.ok(!res.caught);
  assert.equal(res.drew, 4 + CHALLENGE_PENALTY);
  assert.equal(s.hands.p1.length, 7);
  assert.equal(currentSeat(s).id, 'p2', 'the challenger is skipped');
});

test('accepting a +4 instead of challenging just draws the four', () => {
  const s = table(3, card('red', 5), {
    p0: [card(null, 'wild4'), card('blue', 2)],
    p1: [card('blue', 1)],
  });
  applyPlay(s, 'p0', s.hands.p0[0].id, 'blue');
  applyTakeDraw(s, 'p1');
  assert.equal(s.hands.p1.length, 5);
  assert.equal(s.challenge, null);
  assert.equal(currentSeat(s).id, 'p2');
});

test('only the player facing the +4 may challenge it', () => {
  const s = table(3, card('red', 5), {
    p0: [card(null, 'wild4'), card('red', 2)],
    p1: [card('blue', 1)],
    p2: [card('blue', 1)],
  });
  applyPlay(s, 'p0', s.hands.p0[0].id, 'blue');
  assert.throws(() => applyChallenge(s, 'p2'), /nothing to challenge/);
});

test('stacking onto a +4 gives up the right to challenge it', () => {
  const s = table(3, card('red', 5), {
    p0: [card(null, 'wild4'), card('red', 2)],
    p1: [card(null, 'wild4'), card('red', 1)],
  });
  applyPlay(s, 'p0', s.hands.p0[0].id, 'blue');
  applyPlay(s, 'p1', s.hands.p1[0].id, 'green');
  assert.equal(s.challenge, null);
  assert.equal(s.pending.amount, 8);
  assert.throws(() => applyChallenge(s, 'p2'), /nothing to challenge/);
});

/* ---------------- calling Uno ---------------- */

test('playing to one card without calling it leaves you catchable', () => {
  const s = table(2, card('red', 5), { p0: [card('red', 1), card('red', 2)] });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  assert.deepEqual(s.catchable, { playerId: 'p0' });
});

test('calling Uno first keeps you safe', () => {
  const s = table(2, card('red', 5), { p0: [card('red', 1), card('red', 2)] });
  assert.ok(applySayUno(s, 'p0'));
  applyPlay(s, 'p0', s.hands.p0[0].id);
  assert.equal(s.catchable, null);
  assert.throws(() => applyCatch(s, 'p1'), /nobody to catch/);
});

test('you cannot call Uno on a full hand', () => {
  const s = table(2, card('red', 5), { p0: [card('red', 1), card('red', 2), card('red', 3)] });
  assert.ok(!applySayUno(s, 'p0'));
  assert.ok(!s.said.p0);
});

test('a catch costs two cards, and only lands once', () => {
  const s = table(2, card('red', 5), { p0: [card('red', 1), card('red', 2)], p1: [card('blue', 1)] });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  const res = applyCatch(s, 'p1');
  assert.equal(res.caught, 'p0');
  assert.equal(s.hands.p0.length, 1 + CATCH_PENALTY);
  assert.throws(() => applyCatch(s, 'p1'), /nobody to catch/);
});

test('you cannot catch yourself', () => {
  const s = table(2, card('red', 5), { p0: [card('red', 1), card('red', 2)] });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  assert.throws(() => applyCatch(s, 'p0'), /nobody to catch/);
});

test('drawing back up clears the Uno flag', () => {
  const s = table(2, card('red', 5), { p0: [card('red', 1)] });
  applySayUno(s, 'p0');
  assert.ok(s.said.p0);
  drawCards(s, 'p0', 1, seeded(2));
  assert.ok(!s.said.p0, 'you have to call it again next time');
});

/* ---------------- scoring ---------------- */

test('going out ends the round and banks everyone else\'s cards', () => {
  const s = table(3, card('red', 5), {
    p0: [card('red', 9)],
    p1: [card('blue', 4), card('green', 'skip')],       // 4 + 20
    p2: [card(null, 'wild4')],                          // 50
  });
  const res = applyPlay(s, 'p0', s.hands.p0[0].id);
  assert.ok(res.roundOver);
  assert.equal(s.roundWinner, 'p0');
  assert.equal(s.scores.p0, 74);
  assert.equal(s.phase, 'roundover', 'well short of 500 — play on');
});

test('an action card played as your last card does not act', () => {
  const s = table(3, card('red', 5), { p0: [card('red', 'skip')] });
  applyPlay(s, 'p0', s.hands.p0[0].id);
  assert.equal(s.phase, 'roundover');
  assert.equal(s.pending, null);
});

test('reaching the target ends the match', () => {
  const s = table(2, card('red', 5), { p0: [card('red', 9)], p1: [card(null, 'wild4')] });
  s.scores.p0 = DEFAULT_TARGET - 50;
  const res = applyPlay(s, 'p0', s.hands.p0[0].id);
  assert.ok(res.matchOver);
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 'p0');
  assert.equal(s.scores.p0, DEFAULT_TARGET);
});

test('scores survive into the next round, hands do not', () => {
  const s = createState(seats(3), { rng: seeded(9) });
  s.hands.p1 = [card('red', 9)];
  s.discard = [card('red', 5)];
  s.color = 'red'; s.value = 5; s.turn = 1;
  applyPlay(s, 'p1', s.hands.p1[0].id);
  const banked = s.scores.p1;
  assert.ok(banked > 0);

  nextRound(s, seeded(4));
  assert.equal(s.phase, 'playing');
  assert.equal(s.round, 2);
  assert.equal(s.scores.p1, banked, 'scores carry');
  for (const seat of s.seats) assert.equal(s.hands[seat.id].length, HAND_SIZE);
});

test('the round winner leads the next round', () => {
  const s = createState(seats(3), { rng: seeded(21) });
  endRound(s, 'p2');
  nextRound(s, seeded(22));
  // A skip or reverse on the opening card shifts off the leader; a plain card
  // must not.
  if (!s.opener.kind) assert.equal(currentSeat(s).id, 'p2');
});

test('nextRound refuses to run mid-round', () => {
  const s = createState(seats(2), { rng: seeded(2) });
  assert.throws(() => nextRound(s), /not over/);
});

/* ---------------- guards ---------------- */

test('an illegal play is rejected rather than silently applied', () => {
  const s = table(2, card('red', 5), { p0: [card('blue', 9)] });
  assert.throws(() => applyPlay(s, 'p0', s.hands.p0[0].id), /illegal play/);
  assert.equal(s.hands.p0.length, 1, 'the card must stay in hand');
});

test('you cannot play out of turn', () => {
  const s = table(2, card('red', 5), { p0: [card('red', 1)], p1: [card('red', 2)] });
  assert.throws(() => applyPlay(s, 'p1', s.hands.p1[0].id), /illegal play/);
});

// `drawnId` and `mustPass` are scoped to one player's turn. If either survived
// into the next player's turn, that player's draw would be refused and they
// would have no legal way to act — a deadlock that only shows up mid-match.
test('turn-scoped state never leaks into the next player\'s turn', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const rng = seeded(seed);
    const s = createState(seats(3), { rng });
    let prevTurn = s.turn;
    const settled = (what) => {
      assert.ok(s.turn === prevTurn || (!s.drawnId && !s.mustPass),
        `seed ${seed}: turn moved after ${what} with drawnId=${s.drawnId} mustPass=${s.mustPass}`);
      prevTurn = s.turn;
    };

    let guard = 0;
    while (s.phase !== 'over' && guard++ < 3000) {
      if (s.phase === 'roundover') { nextRound(s, rng); prevTurn = s.turn; continue; }
      const me = currentSeat(s).id;
      if (needsOpeningColor(s)) { applyOpeningColor(s, me, 'red'); continue; }
      if (s.catchable && rng() < 0.5) {
        applyCatch(s, s.seats.find((x) => x.id !== s.catchable.playerId).id, rng);
        settled('catch');
        continue;
      }
      if (s.challenge && rng() < 0.5) { applyChallenge(s, me, rng); settled('challenge'); continue; }
      const legal = legalPlays(s, me);
      if (legal.length && rng() < 0.85) {
        applyPlay(s, me, legal[Math.floor(rng() * legal.length)], COLORS[Math.floor(rng() * 4)]);
        settled('play');
      } else if (s.pending) { applyTakeDraw(s, me, rng); settled('take'); }
      else if (!s.drawnId && !s.mustPass) { applyDraw(s, me, rng); settled('draw'); }
      else { applyPass(s, me); settled('pass'); }
    }
  }
});

test('a full game of random legal moves always terminates with a winner', () => {
  const rng = seeded(1234);
  const s = createState(seats(4), { rng });
  let guard = 0;
  while (s.phase !== 'over' && guard++ < 20000) {
    if (s.phase === 'roundover') { nextRound(s, rng); continue; }
    const me = currentSeat(s).id;
    if (needsOpeningColor(s)) { applyOpeningColor(s, me, 'red'); continue; }
    if (s.challenge && rng() < 0.5) { applyChallenge(s, me, rng); continue; }
    const legal = legalPlays(s, me);
    if (legal.length) {
      applyPlay(s, me, legal[Math.floor(rng() * legal.length)], COLORS[Math.floor(rng() * 4)]);
    } else if (s.pending) {
      applyTakeDraw(s, me, rng);
    } else if (!s.drawnId && !s.mustPass) {
      applyDraw(s, me, rng);
    } else {
      applyPass(s, me);
    }
  }
  assert.equal(s.phase, 'over', 'the game should reach a winner, not deadlock');
  assert.ok(s.scores[s.winner] >= DEFAULT_TARGET);
});
