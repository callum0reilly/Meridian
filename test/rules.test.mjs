// Tests for the Ludo rules + board geometry.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLORS, START, SAFE, TRACK_LEN, HOME_STEP, LAST_TRACK_STEP, YARD,
  createState, legalMoves, applyRoll, applyMove, passTurn, currentSeat,
  absSquare, isHome, inHomeColumn, tokensAt, isBlock, rollDice,
} from '../js/games/ludo/rules.js';
import { TRACK, HOME_COLUMN, YARD_SLOTS, HOME_SLOTS, GRID } from '../js/games/ludo/board.js';

const seats = (n) => COLORS.slice(0, n).map((color, i) => ({
  id: 'p' + i, name: 'P' + i, color, connected: true,
}));

const adjacent = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
const diagonal = (a, b) => Math.abs(a[0] - b[0]) === 1 && Math.abs(a[1] - b[1]) === 1;

// The centre 3x3. It is what forces the track to 52: the four cells where the
// arms meet belong to the centre, so the track cuts each corner diagonally.
const CENTRE = [];
for (let c = 6; c <= 8; c++) for (let r = 6; r <= 8; r++) CENTRE.push([c, r]);
const inCentre = ([c, r]) => c >= 6 && c <= 8 && r >= 6 && r <= 8;

/* ---------------- board geometry ---------------- */

test('track is 52 distinct squares', () => {
  assert.equal(TRACK.length, TRACK_LEN);
  assert.equal(new Set(TRACK.map(String)).size, TRACK_LEN);
});

test('track is a closed loop with no gaps or teleports', () => {
  let corners = 0;
  for (let i = 0; i < TRACK.length; i++) {
    const a = TRACK[i], b = TRACK[(i + 1) % TRACK.length];
    if (diagonal(a, b)) { corners++; continue; }
    assert.ok(adjacent(a, b), `TRACK[${i}] ${a} does not connect to ${b}`);
  }
  // Exactly four diagonal steps: one per corner, cutting past the centre block.
  assert.equal(corners, 4, 'expected 4 diagonal corner turns, got ' + corners);
});

test('the track never enters the centre, and the corners it cuts are centre cells', () => {
  for (const cell of TRACK) assert.ok(!inCentre(cell), `${cell} is a centre cell`);
  for (const corner of [[6, 6], [8, 6], [8, 8], [6, 8]]) {
    assert.ok(inCentre(corner));
    assert.ok(!TRACK.some((t) => String(t) === String(corner)), `${corner} should not be track`);
  }
});

test('the board tiles exactly: 52 track + 20 home + 9 centre = the whole cross', () => {
  const cross = new Set();
  for (let c = 0; c < GRID; c++) for (let r = 0; r < GRID; r++) {
    const inArm = (c >= 6 && c <= 8) || (r >= 6 && r <= 8);
    if (inArm) cross.add(c + ',' + r);
  }
  const claimed = [...TRACK, ...Object.values(HOME_COLUMN).flat(), ...CENTRE].map(String);
  assert.equal(new Set(claimed).size, claimed.length, 'a cell is claimed twice');
  assert.equal(claimed.length, 52 + 20 + 9);
  assert.equal(cross.size, claimed.length, 'track+home+centre should cover the cross exactly');
});

test('all board cells are inside the 15x15 grid', () => {
  const all = [...TRACK, ...Object.values(HOME_COLUMN).flat()];
  for (const [c, r] of all) {
    assert.ok(c >= 0 && c < GRID && r >= 0 && r < GRID, `${c},${r} out of bounds`);
  }
});

test('each colour branches into its home column from its last track square', () => {
  for (const color of COLORS) {
    const last = TRACK[absSquare(color, LAST_TRACK_STEP)];
    const firstHome = HOME_COLUMN[color][0];
    assert.ok(adjacent(last, firstHome),
      `${color}: last track square ${last} does not touch home column ${firstHome}`);
  }
});

test('home columns are 5 unbroken squares ending at the centre', () => {
  for (const color of COLORS) {
    const col = HOME_COLUMN[color];
    assert.equal(col.length, 5);
    for (let i = 0; i < col.length - 1; i++) {
      assert.ok(adjacent(col[i], col[i + 1]), `${color} home column jumps at ${i}`);
    }
    assert.ok(CENTRE.some((cell) => adjacent(col[4], cell)),
      `${color} home column does not reach the centre`);
  }
});

test('a token walks 51 shared squares and skips exactly one', () => {
  for (const color of COLORS) {
    const walked = new Set();
    for (let r = 0; r <= LAST_TRACK_STEP; r++) walked.add(absSquare(color, r));
    assert.equal(walked.size, 51);
    // The one square it never lands on is the one behind its own start.
    const skipped = (START[color] + LAST_TRACK_STEP + 1) % TRACK_LEN;
    assert.ok(!walked.has(skipped));
    assert.equal(skipped, (START[color] - 1 + TRACK_LEN) % TRACK_LEN);
  }
});

test('start squares are safe and evenly spaced', () => {
  for (const color of COLORS) assert.ok(SAFE.has(START[color]), `${color} start not safe`);
  assert.deepEqual(Object.values(START), [0, 13, 26, 39]);
});

test('yard and home slots exist for 4 tokens each', () => {
  for (const color of COLORS) {
    assert.equal(YARD_SLOTS[color].length, 4);
    assert.equal(HOME_SLOTS[color].length, 4);
  }
});

/* ---------------- movement ---------------- */

test('a token can only leave the yard on a 6', () => {
  const s = createState(seats(2));
  assert.deepEqual(legalMoves(s, 'red', 5), []);
  assert.deepEqual(legalMoves(s, 'red', 1), []);
  assert.deepEqual(legalMoves(s, 'red', 6), [0, 1, 2, 3]);
});

test('leaving the yard lands on the start square, not start+6', () => {
  const s = createState(seats(2));
  applyRoll(s, 6);
  applyMove(s, 0);
  assert.equal(s.tokens.red[0], 0);
  assert.equal(absSquare('red', s.tokens.red[0]), START.red);
});

test('home needs an exact roll — overshooting is not a legal move', () => {
  const s = createState(seats(2));
  s.tokens.red[0] = HOME_STEP - 3;             // 3 away from home
  assert.ok(legalMoves(s, 'red', 3).includes(0));
  assert.ok(!legalMoves(s, 'red', 4).includes(0));
  assert.ok(!legalMoves(s, 'red', 6).includes(0));
});

test('a token that reaches home stops being movable', () => {
  const s = createState(seats(2));
  s.tokens.red[0] = HOME_STEP;
  assert.ok(!legalMoves(s, 'red', 6).includes(0));
  assert.ok(isHome(s.tokens.red[0]));
});

test('steps 51..55 are the private home column', () => {
  for (let r = 51; r <= 55; r++) {
    assert.ok(inHomeColumn(r), `r=${r} should be in the home column`);
    assert.equal(absSquare('red', r), null, 'home column is not on the shared track');
  }
});

/* ---------------- capture ---------------- */

// Sets up red[0] to land on the same absolute square as green after `dice`.
// `greenR` is that square expressed as green's own step count — the two colours
// count from different starts, which is exactly the bit worth testing.
function collide(dice, redFrom, { wantSafe = false } = {}) {
  const s = createState(seats(2));
  s.tokens.red[0] = redFrom;
  const landing = absSquare('red', redFrom + dice);
  const greenR = (landing - START.green + TRACK_LEN) % TRACK_LEN;
  assert.equal(SAFE.has(landing), wantSafe,
    `test setup: square ${landing} safe=${SAFE.has(landing)}, wanted safe=${wantSafe}`);
  assert.ok(greenR <= LAST_TRACK_STEP, 'test setup: green must be on the shared track');
  assert.equal(absSquare('green', greenR), landing, 'test setup: both should share a square');
  return { s, greenR, landing };
}

test('landing on a lone enemy sends it home and buys an extra turn', () => {
  const { s, greenR } = collide(3, 1);
  s.tokens.green[0] = greenR;
  applyRoll(s, 3);
  const res = applyMove(s, 0);
  assert.equal(s.tokens.green[0], YARD, 'captured token should be back in the yard');
  assert.equal(res.captured.length, 1);
  assert.ok(res.extraTurn);
});

test('a token on a safe square cannot be captured', () => {
  // Red at 5 rolling 3 lands on abs 8 — a star square.
  const { s, greenR } = collide(3, 5, { wantSafe: true });
  s.tokens.green[0] = greenR;
  applyRoll(s, 3);
  const res = applyMove(s, 0);
  assert.equal(res.captured.length, 0);
  assert.equal(s.tokens.green[0], greenR, 'green should be untouched on a safe square');
});

test('two stacked enemies form a block and survive being landed on', () => {
  const { s, greenR, landing } = collide(3, 1);
  s.tokens.green[0] = greenR;
  s.tokens.green[1] = greenR;                  // block of 2
  assert.ok(isBlock(s, landing, 'green'));
  applyRoll(s, 3);
  const res = applyMove(s, 0);
  assert.equal(res.captured.length, 0);
  assert.deepEqual([s.tokens.green[0], s.tokens.green[1]], [greenR, greenR]);
});

test('breaking a block: one of the pair alone is capturable again', () => {
  const { s, greenR } = collide(3, 1);
  s.tokens.green[0] = greenR;
  s.tokens.green[1] = greenR + 4;              // moved on, no longer a block
  applyRoll(s, 3);
  const res = applyMove(s, 0);
  assert.equal(res.captured.length, 1);
  assert.equal(s.tokens.green[0], YARD);
});

test('your own tokens are never captured by your own move', () => {
  const s = createState(seats(2));
  s.tokens.red[0] = 10;
  s.tokens.red[1] = 13;
  applyRoll(s, 3);
  const res = applyMove(s, 0);
  assert.equal(res.captured.length, 0);
  assert.equal(s.tokens.red[1], 13);
  assert.equal(s.tokens.red[0], 13, 'stacking on your own token is allowed');
});

test('tokensAt sees through relative positions to a shared absolute square', () => {
  const s = createState(seats(2));
  s.tokens.red[0] = 13;                        // abs 13
  s.tokens.green[0] = 0;                       // abs 13 too — green's start
  const here = tokensAt(s, 13);
  assert.equal(here.length, 2);
  assert.deepEqual(here.map((t) => t.color).sort(), ['green', 'red']);
});

/* ---------------- turn flow ---------------- */

test('a 6 grants another go; a plain roll does not', () => {
  const s = createState(seats(2));
  s.tokens.red[0] = 10;
  applyRoll(s, 6);
  assert.ok(applyMove(s, 0).extraTurn);

  const s2 = createState(seats(2));
  s2.tokens.red[0] = 10;
  applyRoll(s2, 4);
  assert.ok(!applyMove(s2, 0).extraTurn);
});

test('three 6s in a row forfeits the turn with no move', () => {
  const s = createState(seats(2));
  s.tokens.red[0] = 10;
  assert.equal(applyRoll(s, 6).forfeit, false);
  s.sixes = 2;                                 // two already banked this turn
  const res = applyRoll(s, 6);
  assert.ok(res.forfeit);
  assert.deepEqual(s.moves, [], 'the third 6 must offer no moves');
});

test('the six counter resets when the turn passes', () => {
  const s = createState(seats(2));
  applyRoll(s, 6);
  assert.equal(s.sixes, 1);
  passTurn(s);
  assert.equal(s.sixes, 0);
  assert.equal(s.dice, null);
});

test('an extra turn keeps the seat and the six counter', () => {
  const s = createState(seats(2));
  applyRoll(s, 6);
  passTurn(s, { keepSeat: true });
  assert.equal(s.turn, 0);
  assert.equal(s.sixes, 1, 'consecutive 6s must still be tracked across an extra turn');
});

test('turn order follows seat order and wraps', () => {
  const s = createState(seats(3));
  assert.equal(currentSeat(s).color, 'red');
  passTurn(s); assert.equal(currentSeat(s).color, 'green');
  passTurn(s); assert.equal(currentSeat(s).color, 'yellow');
  passTurn(s); assert.equal(currentSeat(s).color, 'red');
});

test('disconnected players are skipped', () => {
  const s = createState(seats(3));
  s.seats[1].connected = false;
  passTurn(s);
  assert.equal(currentSeat(s).color, 'yellow', 'should skip the disconnected green seat');
});

test('passTurn terminates even if everyone has dropped', () => {
  const s = createState(seats(2));
  s.seats.forEach((x) => { x.connected = false; });
  passTurn(s);                                 // must not hang
  assert.ok(s.turn >= 0 && s.turn < 2);
});

test('a roll with no legal move is reported as stuck', () => {
  const s = createState(seats(2));              // all four tokens in the yard
  const res = applyRoll(s, 3);
  assert.ok(res.stuck);
  assert.deepEqual(s.moves, []);
});

test('an illegal move is rejected rather than silently applied', () => {
  const s = createState(seats(2));
  applyRoll(s, 3);                              // nothing can move
  assert.throws(() => applyMove(s, 0), /illegal move/);
});

/* ---------------- winning ---------------- */

test('getting the last token home wins and ends the game', () => {
  const s = createState(seats(2));
  s.tokens.red = [HOME_STEP, HOME_STEP, HOME_STEP, HOME_STEP - 5];
  applyRoll(s, 5);
  const res = applyMove(s, 3);
  assert.ok(res.won);
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 'red');
  assert.ok(!res.extraTurn, 'the winning move should not hand out another go');
});

test('three tokens home is not a win', () => {
  const s = createState(seats(2));
  s.tokens.red = [HOME_STEP, HOME_STEP, HOME_STEP, 40];
  applyRoll(s, 2);
  assert.ok(!applyMove(s, 3).won);
  assert.equal(s.phase, 'playing');
});

/* ---------------- dice ---------------- */

test('rollDice only ever returns 1..6 and covers every face', () => {
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    const d = rollDice();
    assert.ok(Number.isInteger(d) && d >= 1 && d <= 6, `bad roll: ${d}`);
    seen.add(d);
  }
  assert.equal(seen.size, 6);
});

test('rollDice maps the rng range onto the faces without bias at the edges', () => {
  assert.equal(rollDice(() => 0), 1);
  assert.equal(rollDice(() => 0.9999), 6);
});
