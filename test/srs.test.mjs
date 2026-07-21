// Tests for the spaced repetition scheduler.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_EASE, MAX_EASE, START_EASE, LEARNING_STEPS, GRADUATE_DAYS, GRADES,
  newSchedule, review, isDue, dueQueue, deckStats, describeNext,
} from '../js/study/flashcards/srs.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const T0 = 1_700_000_000_000;   // a fixed clock, so intervals are exact

/** Apply a run of grades in sequence, one per "now" that the schedule asks for. */
function run(grades, start = newSchedule(), now = T0) {
  let s = start;
  for (const g of grades) {
    s = review(s, g, now);
    now = s.due;    // answer each card exactly when it comes due
  }
  return s;
}

/** A card in the review stage with a known interval, without faking internals. */
const reviewCard = () => run(['good', 'good']);

/* ---------------- new cards ---------------- */

test('a new schedule is due at any clock reading', () => {
  assert.equal(isDue(newSchedule(), 0), true);
  assert.equal(isDue(newSchedule(), T0), true);
});

test('a new card graded good moves to the second learning step', () => {
  const s = review(newSchedule(), 'good', T0);
  assert.equal(s.stage, 'learning');
  assert.equal(s.step, 1);
  assert.equal(s.due, T0 + LEARNING_STEPS[1]);
});

test('a new card comes back within the session, not tomorrow', () => {
  // The whole reason learning steps exist — see the header comment in srs.js.
  const s = review(newSchedule(), 'good', T0);
  assert.ok(s.due - T0 < 60 * MINUTE, 'first repeat must land inside the session');
});

test('walking every learning step graduates the card', () => {
  const s = run(Array(LEARNING_STEPS.length).fill('good'));
  assert.equal(s.stage, 'review');
  assert.equal(s.intervalDays, GRADUATE_DAYS.good);
});

test('easy graduates a new card immediately', () => {
  const s = review(newSchedule(), 'easy', T0);
  assert.equal(s.stage, 'review');
  assert.equal(s.intervalDays, GRADUATE_DAYS.easy);
  assert.equal(s.due, T0 + GRADUATE_DAYS.easy * DAY);
});

test('again restarts the learning ladder', () => {
  const s = review(review(newSchedule(), 'good', T0), 'again', T0 + MINUTE);
  assert.equal(s.stage, 'learning');
  assert.equal(s.step, 0);
  assert.equal(s.due, T0 + MINUTE + LEARNING_STEPS[0]);
});

test('hard repeats the current step instead of advancing', () => {
  const first = review(newSchedule(), 'good', T0);      // now on step 1
  const s = review(first, 'hard', first.due);
  assert.equal(s.step, 1, 'should stay put');
});

test('every grade on a new card leads somewhere different', () => {
  // Two buttons with the same interval are one button wearing two labels — the
  // user is being asked to choose with nothing behind the choice.
  const s = newSchedule();
  const dues = GRADES.map((g) => review(s, g, T0).due);
  assert.equal(new Set(dues).size, GRADES.length, 'grades must not collide');
});

test('hard sits between again and good while learning', () => {
  const s = newSchedule();
  const at = (g) => review(s, g, T0).due;
  assert.ok(at('again') < at('hard'), 'hard should wait longer than a failure');
  assert.ok(at('hard') < at('good'), 'hard should come back sooner than good');
});

/* ---------------- review cards ---------------- */

test('good multiplies the interval by ease', () => {
  const before = reviewCard();
  const after = review(before, 'good', before.due);
  assert.ok(Math.abs(after.intervalDays - before.intervalDays * before.ease) < 1e-9);
});

test('easy grows the interval faster than good, and raises ease', () => {
  const before = reviewCard();
  const good = review(before, 'good', before.due);
  const easy = review(before, 'easy', before.due);
  assert.ok(easy.intervalDays > good.intervalDays);
  assert.ok(easy.ease > before.ease);
});

test('hard grows the interval slower than good, and lowers ease', () => {
  const before = reviewCard();
  const good = review(before, 'good', before.due);
  const hard = review(before, 'hard', before.due);
  assert.ok(hard.intervalDays < good.intervalDays);
  assert.ok(hard.ease < before.ease);
});

test('a lapse drops the card back into learning and counts itself', () => {
  const before = reviewCard();
  const after = review(before, 'again', before.due);
  assert.equal(after.stage, 'learning');
  assert.equal(after.lapses, 1);
  assert.equal(after.due, before.due + LEARNING_STEPS[0]);
  assert.ok(after.ease < before.ease);
});

test('a lapse keeps some of the old interval rather than resetting to zero', () => {
  const before = run(['good', 'good', 'good', 'good']);
  const after = review(before, 'again', before.due);
  assert.ok(after.intervalDays >= 1);
  assert.ok(after.intervalDays < before.intervalDays);
});

test('ease is clamped at both ends', () => {
  const floor = run(['good', 'good', ...Array(30).fill('hard')]);
  assert.equal(floor.ease, MIN_EASE);
  const ceiling = run(['easy', ...Array(30).fill('easy')]);
  assert.equal(ceiling.ease, MAX_EASE);
});

test('ease starts where SM-2 says it does', () => {
  assert.equal(newSchedule().ease, START_EASE);
});

test('reps counts every answer, including failures', () => {
  const s = run(['good', 'again', 'good', 'good']);
  assert.equal(s.reps, 4);
});

test('review does not mutate the schedule it was given', () => {
  const before = newSchedule();
  const snapshot = JSON.stringify(before);
  review(before, 'easy', T0);
  assert.equal(JSON.stringify(before), snapshot);
});

test('an unknown grade throws rather than scheduling something arbitrary', () => {
  assert.throws(() => review(newSchedule(), 'brilliant', T0), /unknown grade/);
});

test('intervals grow monotonically under repeated good answers', () => {
  let s = newSchedule();
  let now = T0;
  let last = 0;
  for (let i = 0; i < 10; i++) {
    s = review(s, 'good', now);
    now = s.due;
    if (s.stage === 'review') {
      assert.ok(s.intervalDays >= last, `interval shrank at rep ${i}`);
      last = s.intervalDays;
    }
  }
  assert.ok(last > 30, 'a well-known card should reach month-scale intervals');
});

/* ---------------- queueing ---------------- */

const card = (id, srs) => ({ id, front: id, back: id, page: 1, srs });

test('dueQueue omits cards that are not due yet', () => {
  const cards = [card('a', newSchedule()), card('b', { ...newSchedule(), due: T0 + DAY })];
  assert.deepEqual(dueQueue(cards, T0).map((c) => c.id), ['a']);
});

test('dueQueue puts reviews before learning before new', () => {
  const cards = [
    card('new', newSchedule()),
    card('learn', { ...newSchedule(), stage: 'learning', due: T0 - MINUTE }),
    card('rev', { ...newSchedule(), stage: 'review', due: T0 - DAY }),
  ];
  assert.deepEqual(dueQueue(cards, T0).map((c) => c.id), ['rev', 'learn', 'new']);
});

test('dueQueue shows the most overdue review first', () => {
  const cards = [
    card('recent', { ...newSchedule(), stage: 'review', due: T0 - MINUTE }),
    card('ancient', { ...newSchedule(), stage: 'review', due: T0 - 30 * DAY }),
  ];
  assert.deepEqual(dueQueue(cards, T0).map((c) => c.id), ['ancient', 'recent']);
});

test('dueQueue keeps new cards in document order', () => {
  const cards = ['a', 'b', 'c'].map((id) => card(id, newSchedule()));
  assert.deepEqual(dueQueue(cards, T0).map((c) => c.id), ['a', 'b', 'c']);
});

test('deckStats counts each stage and the due total', () => {
  const cards = [
    card('a', newSchedule()),
    card('b', newSchedule()),
    card('c', { ...newSchedule(), stage: 'review', due: T0 + DAY }),
  ];
  const s = deckStats(cards, T0);
  assert.equal(s.total, 3);
  assert.equal(s.new, 2);
  assert.equal(s.review, 1);
  assert.equal(s.due, 2);
});

/* ---------------- labels ---------------- */

test('describeNext gives the interval each button would produce', () => {
  assert.equal(describeNext(newSchedule(), 'again', T0), '1m');
  assert.equal(describeNext(newSchedule(), 'good', T0), '10m');
  assert.equal(describeNext(newSchedule(), 'easy', T0), '4d');
});

test('describeNext scales its unit with the interval', () => {
  const long = run(Array(8).fill('easy'));
  assert.match(describeNext(long, 'easy', long.due), /(mo|y)$/);
});

test('every grade produces a label, never an empty string', () => {
  const s = reviewCard();
  for (const g of GRADES) assert.ok(describeNext(s, g, T0).length > 0, g);
});
