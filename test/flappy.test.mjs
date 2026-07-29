// Tests for the Flappy Bird rules.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WIDTH, HEIGHT, GROUND_H, FLOOR, TICK_MS,
  GRAVITY, FLAP_V, BIRD_X, BIRD_R,
  PIPE_GAP, PIPE_W, PIPE_SPEED, PIPE_SPACING, PIPE_COUNT, FIRST_PIPE_X,
  MIN_TOP, MAX_TOP,
  createState, makePipe, flap, step, hits, restart,
} from '../js/games/flappy/rules.js';

/* ---------------- helpers ---------------- */

/** A game with a fixed pellet-of-a-gap, so a test about flight is only ever
 *  about flight. `at` picks where in the random range every gap lands. */
function game(at = 0.5) {
  return createState({ rng: () => at });
}

/** A game already in the air, with the pipes pushed far enough off to the
 *  right that they cannot interrupt whatever is being measured. */
function flying(at = 0.5) {
  const s = game(at);
  flap(s);
  for (const p of s.pipes) p.x = WIDTH * 4;
  return s;
}

/** Run n steps, returning the last result. */
function steps(s, n) {
  let res;
  for (let i = 0; i < n; i++) res = step(s);
  return res;
}

/**
 * Step n times with the bird pinned level at `y`.
 *
 * Tests about pipes are not tests about gravity: left to itself the bird
 * climbs out of the flap it started with and clips the top lip halfway
 * through, which fails the test for the wrong reason. Holding it still makes
 * the pipe the only thing moving.
 */
function glide(s, n, y) {
  for (let i = 0; i < n && s.phase === 'playing'; i++) {
    s.bird.y = y;
    s.bird.vy = 0;
    step(s);
  }
}

/** Step until the run ends, returning the result that ended it.
 *
 *  Not `steps(s, plenty)`: a step taken after the bird is already dead reports
 *  `died: false`, quite correctly — nothing died on that tick — so overshooting
 *  would hand back a no-op and lose the cause of death. */
function runToEnd(s, cap = 2000) {
  let res;
  for (let i = 0; i < cap && s.phase !== 'dead'; i++) res = step(s);
  assert.equal(s.phase, 'dead', 'the run never ended');
  return res;
}

/* ---------------- setup ---------------- */

test('a new game waits, mid-air, with pipes queued off screen', () => {
  const s = game();
  assert.equal(s.phase, 'ready');
  assert.equal(s.score, 0);
  assert.equal(s.cause, null);
  assert.equal(s.bird.x, BIRD_X);
  assert.equal(s.bird.vy, 0);
  assert.equal(s.pipes.length, PIPE_COUNT);
  assert.ok(s.pipes.every((p) => p.x >= WIDTH), 'nothing is on screen yet');
  assert.ok(s.pipes.every((p) => !p.passed));
});

test('pipes are spaced evenly, starting off the right-hand edge', () => {
  const s = game();
  assert.equal(s.pipes[0].x, FIRST_PIPE_X);
  for (let i = 1; i < s.pipes.length; i++) {
    assert.equal(s.pipes[i].x - s.pipes[i - 1].x, PIPE_SPACING);
  }
});

test('the playfield is the one the canvas is sized for', () => {
  assert.equal(FLOOR, HEIGHT - GROUND_H);
  assert.equal(Math.round(TICK_MS * 60), 1000);
});

/* ---------------- gaps ---------------- */

test('every gap is reachable and clear of the ceiling and the ground', () => {
  const s = game();
  // Walk the rng across its whole range; every draw must be a flyable gap.
  for (let i = 0; i <= 40; i++) {
    s.rng = () => i / 40;
    const p = makePipe(s, WIDTH);
    assert.ok(p.top >= MIN_TOP, `gap ${i} starts above the ceiling margin`);
    assert.ok(p.top + PIPE_GAP <= FLOOR - 0, `gap ${i} ends below the ground`);
    assert.ok(p.top <= MAX_TOP, `gap ${i} leaves room under it`);
  }
});

test('the gap is taller than the bird, or the game is unwinnable', () => {
  assert.ok(PIPE_GAP > BIRD_R * 2);
});

/* ---------------- flying ---------------- */

test('the first flap starts the run and beats the wings on the same press', () => {
  const s = game();
  assert.equal(flap(s), true);
  assert.equal(s.phase, 'playing');
  assert.equal(s.bird.vy, FLAP_V);
});

test('a waiting bird bobs on the spot and nothing else moves', () => {
  const s = game();
  const x = s.pipes[0].x;
  const res = steps(s, 20);

  assert.equal(res.moved, false);
  assert.equal(s.phase, 'ready');
  assert.equal(s.pipes[0].x, x, 'the pipes wait for you');
  assert.notEqual(s.bird.y, HEIGHT / 2);
  assert.ok(Math.abs(s.bird.y - HEIGHT / 2) <= 8, 'and it is only a bob');
});

test('gravity accumulates: each step falls further than the last', () => {
  const s = flying();
  s.bird.vy = 0;
  s.bird.y = 100;

  step(s);
  const first = s.bird.y - 100;
  const mark = s.bird.y;
  step(s);
  const second = s.bird.y - mark;

  assert.ok(second > first, 'the bird is speeding up');
  assert.equal(Math.round((second - first) * 100), Math.round(GRAVITY * 100));
});

test('a flap sets the climb rather than adding to it', () => {
  const s = flying();
  s.bird.vy = -4;
  flap(s);
  assert.equal(s.bird.vy, FLAP_V, 'hammering the key does not stack');
});

test('flapping repeatedly holds the bird up', () => {
  const s = flying();
  const start = s.bird.y;
  for (let i = 0; i < 60; i++) { flap(s); step(s); }
  assert.ok(s.bird.y < start, 'a flap a frame climbs');
  assert.equal(s.phase, 'playing');
});

test('left alone, the bird falls out of the sky', () => {
  const s = flying();
  const res = runToEnd(s);
  assert.equal(res.died, true);
  assert.equal(res.cause, 'ground');
  assert.equal(s.phase, 'dead');
});

test('the bird lands on the ground, not in it', () => {
  const s = flying();
  runToEnd(s);
  assert.equal(s.bird.y, FLOOR - BIRD_R);
});

test('the ceiling bumps you instead of killing you', () => {
  const s = flying();
  s.bird.y = 20;
  for (let i = 0; i < 30; i++) { flap(s); step(s); }

  assert.equal(s.phase, 'playing', 'still alive up there');
  assert.equal(s.bird.y, BIRD_R, 'pinned to the ceiling');
  assert.equal(s.bird.vy, 0, 'and the climb is cancelled, not kept');
});

/* ---------------- pipes ---------------- */

test('pipes drift left at a steady rate', () => {
  const s = flying();
  const x = s.pipes[0].x;
  steps(s, 10);
  assert.equal(Math.round(s.pipes[0].x), Math.round(x - PIPE_SPEED * 10));
});

test('clearing a pipe scores exactly once', () => {
  const s = flying();
  const y = HEIGHT / 2;
  // Park a pipe just about to clear the bird, with the gap around it so the
  // scoring is not decided by a collision first.
  s.pipes = [{ x: BIRD_X - PIPE_W + 1, top: y - PIPE_GAP / 2, passed: false }];

  glide(s, 2, y);
  assert.equal(s.score, 1);

  glide(s, 10, y);
  assert.equal(s.score, 1, 'the same pipe does not pay twice');
});

test('a pipe scores on its trailing edge, not on first contact', () => {
  const s = flying();
  const y = HEIGHT / 2;
  s.pipes = [{ x: BIRD_X + 1, top: y - PIPE_GAP / 2, passed: false }];

  glide(s, 1, y);
  assert.equal(s.score, 0, 'the bird is still inside the gap');
  glide(s, Math.ceil(PIPE_W / PIPE_SPEED) + 1, y);
  assert.equal(s.score, 1);
  assert.equal(s.phase, 'playing', 'and it flew through rather than into it');
});

test('flying into a pipe ends the run and says so', () => {
  const s = flying();
  s.bird.vy = 0;
  s.bird.y = HEIGHT / 2;
  // A wall of pipe with the gap far above: the bird is level with the lower
  // pipe and about to be overtaken by it.
  s.pipes = [{ x: BIRD_X + BIRD_R, top: 60, passed: false }];

  const res = runToEnd(s, 100);
  assert.equal(res.died, true);
  assert.equal(res.cause, 'pipe');
  assert.equal(s.cause, 'pipe');
});

test('the gap is genuinely flyable — dead centre gets you through', () => {
  const s = flying();
  const top = 200;
  s.pipes = [{ x: WIDTH, top, passed: false }];

  // Held in the middle of the gap: the point of the test is the geometry, not
  // whether a human could fly it.
  glide(s, 200, top + PIPE_GAP / 2);
  assert.equal(s.phase, 'playing');
  assert.equal(s.score, 1);
  assert.equal(s.pipes.length, 1, 'a lone pipe recycles without falling over');
});

test('collision is judged against the bird as a box, both lips and neither side', () => {
  const p = { x: 100, top: 200, passed: false };
  const at = (x, y) => ({ x, y, vy: 0, r: BIRD_R });

  assert.equal(hits(at(50, 300), p), false, 'well short of the pipe');
  assert.equal(hits(at(300, 300), p), false, 'well past it');
  assert.equal(hits(at(130, 280), p), false, 'in the gap');
  assert.equal(hits(at(130, 100), p), true, 'through the top pipe');
  assert.equal(hits(at(130, 500), p), true, 'through the bottom pipe');
  assert.equal(hits(at(130, 200 + PIPE_GAP + 1), p), true, 'just under the lower lip');
  assert.equal(hits(at(100 - BIRD_R - 1, 100), p), false, 'a whisker before the leading edge');
});

test('pipes are recycled off the left and re-laid behind the last one', () => {
  const s = flying();
  s.pipes = [
    { x: -PIPE_W - 1, top: 200, passed: true },
    { x: 200, top: 200, passed: false },
    { x: 200 + PIPE_SPACING, top: 200, passed: false },
  ];

  step(s);
  assert.equal(s.pipes.length, 3, 'the field stays a fixed size');
  const last = s.pipes[s.pipes.length - 1];
  const prev = s.pipes[s.pipes.length - 2];
  assert.equal(Math.round(last.x - prev.x), PIPE_SPACING);
  assert.equal(last.passed, false, 'the new one is worth a point');
});

test('a long run never grows the pipe field', () => {
  // Every gap in the same place, and the bird held in the middle of it, so the
  // run goes on long enough for the recycler to come round several times.
  const s = game();
  flap(s);
  for (let i = 0; i < 900; i++) {
    s.bird.y = HEIGHT / 2;
    s.bird.vy = 0;
    step(s);
    assert.equal(s.pipes.length, PIPE_COUNT, `after ${i} steps`);
  }
  assert.equal(s.phase, 'playing');
  assert.ok(s.score >= 3, 'and it did actually score along the way');
});

/* ---------------- ending ---------------- */

test('a dead bird ignores flaps and further steps', () => {
  const s = flying();
  runToEnd(s);

  assert.equal(flap(s), false);
  const res = step(s);
  assert.equal(res.moved, false);
  assert.equal(res.died, false, 'nothing died on this tick — it was already dead');
  assert.equal(res.cause, 'ground', 'but the run still knows what killed it');
});

test('the score survives the crash', () => {
  const s = flying();
  s.pipes = [{ x: BIRD_X - PIPE_W + 1, top: s.bird.y - PIPE_GAP / 2, passed: false }];
  steps(s, 2);
  assert.equal(s.score, 1);

  s.pipes = [];
  runToEnd(s);
  assert.equal(s.score, 1);
});

/* ---------------- restarting ---------------- */

test('restart gives a fresh run on the same random source', () => {
  const s = game(0.25);
  flap(s);
  steps(s, 30);
  s.score = 12;

  const fresh = restart(s);
  assert.equal(fresh.phase, 'ready');
  assert.equal(fresh.score, 0);
  assert.equal(fresh.cause, null);
  assert.equal(fresh.bird.y, HEIGHT / 2);
  assert.equal(fresh.bird.vy, 0);
  assert.equal(fresh.pipes.length, PIPE_COUNT);
  assert.equal(fresh.pipes[0].top, s.pipes[0].top, 'same rng, same gaps');
});

test('the same seed replays the same run', () => {
  const seeded = () => {
    // A tiny deterministic generator: enough to prove the game takes its
    // randomness from `rng` and nowhere else.
    let n = 1;
    return () => (n = (n * 48271) % 2147483647) / 2147483647;
  };

  const a = createState({ rng: seeded() });
  const b = createState({ rng: seeded() });
  for (let i = 0; i < 400; i++) {
    if (i % 12 === 0) { flap(a); flap(b); }
    step(a);
    step(b);
  }
  assert.deepEqual(b.pipes.map((p) => p.top), a.pipes.map((p) => p.top));
  assert.equal(b.score, a.score);
  assert.equal(b.bird.y, a.bird.y);
  assert.equal(b.phase, a.phase);
});
