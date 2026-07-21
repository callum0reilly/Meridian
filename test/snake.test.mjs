// Tests for the Snake rules.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLS, ROWS, START_LENGTH, GROW_PER_FOOD,
  MIN_LEVEL, MAX_LEVEL, DEFAULT_LEVEL, TICK_MS,
  DIRS, createState, turn, step, restart,
  freeCells, placeFood, inBounds, samePoint,
  tickMs, clampLevel, pointsPerFood,
} from '../js/games/snake/rules.js';

/* ---------------- helpers ---------------- */

/**
 * A game with the food parked somewhere it can't be reached by accident, so a
 * test about movement is only ever about movement. Tests that care about
 * eating put the pellet where they want it themselves.
 */
function game(opts = {}) {
  const s = createState({ rng: () => 0, ...opts });
  s.food = { x: s.cols - 1, y: 0 };
  return s;
}

/** Run n steps, returning the last result. */
function steps(s, n) {
  let res;
  for (let i = 0; i < n; i++) res = step(s);
  return res;
}

/**
 * Step until the game ends, returning the result that ended it.
 *
 * Not `steps(s, plenty)`: a step taken after the snake is already dead reports
 * `died: false`, quite correctly — nothing died on that tick — so overshooting
 * would hand back a no-op and lose the cause of death.
 */
function runToEnd(s, cap = 500) {
  let res;
  for (let i = 0; i < cap && s.phase === 'playing'; i++) res = step(s);
  assert.notEqual(s.phase, 'playing', 'game never ended');
  return res;
}

const head = (s) => s.snake[0];
const cells = (s) => s.snake.map((p) => `${p.x},${p.y}`);

/* ---------------- setup ---------------- */

test('a new game starts short, mid-height, heading right', () => {
  const s = game();
  assert.equal(s.phase, 'playing');
  assert.equal(s.snake.length, START_LENGTH);
  assert.equal(s.dir, 'right');
  assert.equal(s.score, 0);
  assert.equal(s.eaten, 0);
  assert.equal(s.cause, null);
  // Head is ahead of the tail, or the first step eats the body.
  assert.equal(head(s).x, START_LENGTH - 1);
  assert.equal(s.snake[s.snake.length - 1].x, 0);
  assert.ok(s.snake.every((p) => p.y === Math.floor(ROWS / 2)));
});

test('the default grid is the one the canvas is sized for', () => {
  const s = createState();
  assert.equal(s.cols, COLS);
  assert.equal(s.rows, ROWS);
});

test('levels are clamped into range, and each one has a speed', () => {
  assert.equal(clampLevel(0), MIN_LEVEL);
  assert.equal(clampLevel(99), MAX_LEVEL);
  assert.equal(clampLevel('4'), 4);
  assert.equal(clampLevel(undefined), DEFAULT_LEVEL);
  assert.equal(clampLevel(NaN), DEFAULT_LEVEL);
  assert.equal(TICK_MS.length, MAX_LEVEL - MIN_LEVEL + 1);
  assert.equal(createState({ level: 42 }).level, MAX_LEVEL);
});

test('higher levels are strictly faster', () => {
  for (let lv = MIN_LEVEL; lv < MAX_LEVEL; lv++) {
    assert.ok(tickMs(lv) > tickMs(lv + 1), `level ${lv} vs ${lv + 1}`);
  }
});

/* ---------------- moving ---------------- */

test('a step slides the whole snake along, keeping its length', () => {
  const s = game();
  const before = cells(s);
  const res = step(s);

  assert.equal(res.moved, true);
  assert.equal(res.ate, false);
  assert.equal(s.snake.length, START_LENGTH);
  assert.equal(head(s).x, START_LENGTH);
  // The old head is now the second segment and the old tail is gone.
  assert.deepEqual(cells(s).slice(1), before.slice(0, -1));
});

test('turning changes the axis on the next step, not this one', () => {
  const s = game();
  assert.equal(turn(s, 'up'), true);
  assert.equal(s.dir, 'right', 'the queued turn has not been applied yet');

  const y = head(s).y;
  step(s);
  assert.equal(s.dir, 'up');
  assert.equal(head(s).y, y - 1);
});

/* ---------------- steering rules ---------------- */

test('a 180 is refused, and so is the direction already being travelled', () => {
  const s = game();               // heading right
  assert.equal(turn(s, 'left'), false);
  assert.equal(turn(s, 'right'), false);
  assert.equal(s.queue.length, 0);
  assert.equal(turn(s, 'nowhere'), false);
});

test('two turns inside one tick both happen, in order', () => {
  // The double-tap that used to kill you: right, then up+left in one tick.
  const s = game();
  assert.equal(turn(s, 'up'), true);
  assert.equal(turn(s, 'left'), true, 'left is legal *after* the queued up');

  step(s);
  assert.equal(s.dir, 'up');
  step(s);
  assert.equal(s.dir, 'left');
  assert.equal(s.phase, 'playing', 'the snake turned the corner instead of dying');
});

test('reversal is judged against the last queued turn, not the current one', () => {
  const s = game();               // heading right
  turn(s, 'up');
  assert.equal(turn(s, 'down'), false, 'down would reverse the queued up');
});

test('the queue holds two turns and no more', () => {
  const s = game();
  assert.equal(turn(s, 'up'), true);
  assert.equal(turn(s, 'left'), true);
  assert.equal(turn(s, 'down'), false, 'queue is full');
  assert.equal(s.queue.length, 2);
});

test('a dead snake ignores steering and further steps', () => {
  const s = game();
  s.phase = 'dead';
  assert.equal(turn(s, 'up'), false);
  const res = step(s);
  assert.equal(res.moved, false);
});

/* ---------------- eating ---------------- */

test('eating scores, grows the snake, and re-lays the pellet', () => {
  const s = game();
  s.food = { x: head(s).x + 1, y: head(s).y };

  const res = step(s);
  assert.equal(res.ate, true);
  assert.equal(s.eaten, 1);
  assert.equal(s.score, pointsPerFood(s.level));
  assert.ok(s.food && !samePoint(s.food, head(s)), 'a fresh pellet, not under us');

  // Growth is paid out one segment per step, so the length arrives over the
  // next few moves rather than all at once.
  assert.equal(s.snake.length, START_LENGTH);
  assert.equal(s.grow, GROW_PER_FOOD);
  steps(s, GROW_PER_FOOD);
  assert.equal(s.snake.length, START_LENGTH + GROW_PER_FOOD);

  const len = s.snake.length;
  step(s);
  assert.equal(s.snake.length, len, 'and then it stops growing');
});

test('a pellet is worth its level, so speed is where the points are', () => {
  assert.equal(pointsPerFood(1), 1);
  assert.equal(pointsPerFood(MAX_LEVEL), MAX_LEVEL);

  const s = createState({ level: 7, rng: () => 0 });
  s.food = { x: head(s).x + 1, y: head(s).y };
  step(s);
  assert.equal(s.score, 7);
});

test('food never lands under the snake', () => {
  const s = game();
  const taken = new Set(cells(s));
  // Walk the rng across the whole range; every draw must miss the snake.
  for (let i = 0; i < 40; i++) {
    s.rng = () => i / 40;
    const f = placeFood(s);
    assert.ok(inBounds(s, f));
    assert.ok(!taken.has(`${f.x},${f.y}`), `pellet landed on the snake at draw ${i}`);
  }
});

test('free cells account for every square the snake is not on', () => {
  const s = game();
  assert.equal(freeCells(s).length, s.cols * s.rows - s.snake.length);
});

/* ---------------- dying ---------------- */

test('running into a wall ends the game and says which one', () => {
  const s = game();
  const res = runToEnd(s);            // straight on into the right-hand wall

  assert.equal(res.died, true);
  assert.equal(res.cause, 'wall');
  assert.equal(s.phase, 'dead');
  assert.equal(s.cause, 'wall');
});

test('every wall kills, not just the one straight ahead', () => {
  for (const dir of ['up', 'down', 'left']) {
    const s = game();
    // Turn twice where needed; left is a reversal, so go up and then across.
    if (dir === 'left') { turn(s, 'up'); step(s); turn(s, 'left'); }
    else turn(s, dir);

    const res = runToEnd(s);
    assert.equal(res.cause, 'wall', `heading ${dir}`);
  }
});

test('biting your own body kills you', () => {
  const s = game();
  // Grow long enough to be able to reach round onto itself.
  s.grow = 8;
  steps(s, 8);

  // A tight anticlockwise box back into the neck.
  turn(s, 'up');   step(s);
  turn(s, 'left'); step(s);
  turn(s, 'down'); const res = step(s);

  assert.equal(res.died, true);
  assert.equal(res.cause, 'self');
  assert.equal(s.phase, 'dead');
});

test('the vacated tail square is safe to move into', () => {
  // The tail leaves the same tick the head arrives, so following it round is
  // legal — as on the phone. Only true while the snake is not growing.
  const s = game();
  s.grow = 0;
  s.snake = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 6 }, { x: 5, y: 6 }];
  s.dir = 'right';
  turn(s, 'down');
  step(s);                            // head to 5,6 — where the tail just was
  assert.equal(s.phase, 'playing');
  assert.ok(samePoint(head(s), { x: 5, y: 6 }));
});

test('but the tail square is deadly while the snake is still growing', () => {
  const s = game();
  s.snake = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 6 }, { x: 5, y: 6 }];
  s.dir = 'right';
  s.grow = 2;                         // the tail is staying put this tick
  turn(s, 'down');
  const res = step(s);
  assert.equal(res.cause, 'self');
});

/* ---------------- winning ---------------- */

test('filling the board wins instead of trapping the game', () => {
  // A 2x2 arena with the snake covering three of it and one segment still owed
  // from the last pellet, so the tail stays put and the snake ends up on all
  // four squares. There is then nowhere to lay a pellet, which is a win rather
  // than a crash. (Without the owed growth the tail vacates as the head
  // arrives, the board is never full, and the game just carries on.)
  const s = createState({ cols: 2, rows: 2, rng: () => 0 });
  s.snake = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
  s.dir = 'right';
  s.grow = 1;
  s.food = { x: 1, y: 0 };

  const res = step(s);
  assert.equal(res.ate, true);
  assert.equal(res.won, true);
  assert.equal(s.phase, 'won');
  assert.equal(s.food, null);
  assert.equal(step(s).moved, false, 'a won game stops');
});

test('placeFood gives up cleanly on a full board', () => {
  const s = createState({ cols: 1, rows: 2, rng: () => 0 });
  s.snake = [{ x: 0, y: 0 }, { x: 0, y: 1 }];
  assert.equal(placeFood(s), null);
});

/* ---------------- restarting ---------------- */

test('restart gives a fresh game, keeping the grid and taking a new level', () => {
  const s = game({ level: 2 });
  steps(s, 4);
  s.score = 50;

  const fresh = restart(s, 6);
  assert.equal(fresh.level, 6);
  assert.equal(fresh.score, 0);
  assert.equal(fresh.phase, 'playing');
  assert.equal(fresh.snake.length, START_LENGTH);
  assert.equal(fresh.cols, s.cols);
  assert.equal(fresh.rows, s.rows);
  assert.equal(restart(s).level, 2, 'and keeps the level when not given one');
});

/* ---------------- geometry ---------------- */

test('bounds are the arena, and the directions are unit vectors', () => {
  const s = game();
  assert.ok(inBounds(s, { x: 0, y: 0 }));
  assert.ok(inBounds(s, { x: s.cols - 1, y: s.rows - 1 }));
  assert.ok(!inBounds(s, { x: -1, y: 0 }));
  assert.ok(!inBounds(s, { x: s.cols, y: 0 }));
  assert.ok(!inBounds(s, { x: 0, y: s.rows }));

  for (const [name, d] of Object.entries(DIRS)) {
    assert.equal(Math.abs(d.x) + Math.abs(d.y), 1, name);
  }
});
