// Snake — canvas, controls, and the run loop around rules.js.
//
// ---- Why this game has no net.js in it ----
//
// Ludo, Uno and X and O's all open the same way: create a room, share a code,
// wait for seats. Snake is one player against a grid, so there is no authority
// question to answer, nothing to broadcast and nobody to redact state from. It
// keeps the shell's tab contract (`init(root, header)`, `onShow`/`onHide`) and
// the rules/DOM split, and drops the rest.
//
// ---- Why a canvas ----
//
// The other games are a few dozen elements and are perfectly happy as DOM. A
// 24x16 arena is 384 cells being repainted up to fifteen times a second, which
// is the point where per-cell elements stop being free. It also buys the look:
// one small bitmap scaled up with `image-rendering: pixelated` is a real Nokia
// LCD, where scaled-up DOM boxes are just big smooth rectangles.

import {
  COLS, ROWS, MIN_LEVEL, MAX_LEVEL, DEFAULT_LEVEL,
  createState, turn, step, restart, tickMs, clampLevel, pointsPerFood,
} from './rules.js';

const GAME = 'snake';

/** Internal canvas pixels per grid cell. The canvas is drawn at exactly this
 *  scale and stretched by CSS, so every game pixel lands on a whole number. */
const CELL = 16;

/** Nokia 3310 LCD: dark grey-green ink on a pale green backlight. */
const INK = '#2f3b1f';
const LCD = '#c7dba0';

const HIGHS_KEY = 'meridian.snake.highs';

const TABLE_HTML = `
  <div class="table">
    <div class="phone">
      <div class="screen">
        <div class="hud">
          <span class="sc">0</span>
          <span class="lv"></span>
        </div>
        <canvas class="board" width="${COLS * CELL}" height="${ROWS * CELL}"
                aria-label="Snake arena"></canvas>
        <div class="overlay" hidden></div>
      </div>
      <div class="pad">
        <button class="up"    data-dir="up"    aria-label="Up">▲</button>
        <button class="left"  data-dir="left"  aria-label="Left">◀</button>
        <button class="right" data-dir="right" aria-label="Right">▶</button>
        <button class="down"  data-dir="down"  aria-label="Down">▼</button>
      </div>
    </div>
    <aside>
      <div class="loghead">How to play</div>
      <ul class="keys">
        <li><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd><span>or <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to steer</span></li>
        <li><kbd>Space</kbd><span>pause</span></li>
        <li><kbd>Enter</kbd><span>start, or play again</span></li>
      </ul>
      <div class="loghead">Level</div>
      <div class="levels"></div>
      <div class="lvhint"></div>
      <div class="loghead">Best scores</div>
      <ul class="highs"></ul>
    </aside>
  </div>
`;

/** Arrow keys and WASD, plus the arrows' names as browsers report them. */
const KEY_DIRS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
};

/* ---- best scores ----
   Per level, because a level 9 run and a level 1 run are not the same game and
   ranking them in one column would only ever show the slow one. Storage is
   best-effort: private windows and locked-down profiles throw on access, and a
   forgotten high score is not worth taking the game down over. */

function loadHighs() {
  try {
    const raw = JSON.parse(localStorage.getItem(HIGHS_KEY) || '{}');
    const out = {};
    for (let lv = MIN_LEVEL; lv <= MAX_LEVEL; lv++) {
      const n = Number(raw[lv]);
      if (Number.isFinite(n) && n > 0) out[lv] = Math.floor(n);
    }
    return out;
  } catch {
    return {};
  }
}

function saveHighs(highs) {
  try {
    localStorage.setItem(HIGHS_KEY, JSON.stringify(highs));
  } catch {
    /* nothing to do — the scores just don't outlive the tab */
  }
}

function init(root, header) {
  let game = null;        // rules.js state, once a run has started
  let screen = 'menu';    // menu | playing | paused | dead | won
  let level = DEFAULT_LEVEL;
  let highs = loadHighs();
  let record = false;     // did the run that just ended beat its level's best?

  let timer = null;       // the run loop's pending setTimeout
  let active = false;     // is this tab on screen? gates the key handler
  let flashUntil = 0;     // death flash: repaint inverted until this timestamp

  const el = (sel) => root.querySelector('.' + sel);

  root.innerHTML = TABLE_HTML;
  const canvas = el('board');
  const ctx = canvas.getContext('2d');

  header.innerHTML = '<div class="tag snaketag">1 player</div>' +
                     '<button class="newgame">New game</button>';
  header.querySelector('.newgame').onclick = () => startRun();

  /* ============================ the run loop ============================ */

  // A chained setTimeout rather than setInterval: the delay is read fresh each
  // time, so a level change between runs takes effect without tearing anything
  // down, and a tab that gets throttled in the background resumes on a whole
  // step instead of firing a burst of queued ones.
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(onTick, tickMs(game.level));
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  function onTick() {
    if (screen !== 'playing' || !game) return;
    const res = step(game);

    if (res.died || res.won) {
      stop();
      finish(res.won);
      return;
    }
    draw();
    schedule();
  }

  function startRun() {
    stop();
    game = game ? restart(game, level) : createState({ level });
    screen = 'playing';
    record = false;
    flashUntil = 0;
    renderAll();
    schedule();
  }

  function finish(won) {
    screen = won ? 'won' : 'dead';

    const best = highs[game.level] || 0;
    if (game.score > best) {
      record = true;
      highs = { ...highs, [game.level]: game.score };
      saveHighs(highs);
    }

    // Hold the final frame for a beat before the overlay covers it, so you can
    // see what you actually ran into. Dying and being told about it in the same
    // frame reads as the game having cheated you.
    flashUntil = performance.now() + 420;
    drawFlash();
    setTimeout(renderAll, 460);
  }

  function togglePause() {
    if (screen === 'playing') {
      screen = 'paused';
      stop();
      renderAll();
    } else if (screen === 'paused') {
      screen = 'playing';
      renderAll();
      schedule();
    }
  }

  /* ============================== input ============================== */

  function steer(dir) {
    if (screen !== 'playing' || !game) return;
    turn(game, dir);
  }

  function onKey(ev) {
    if (!active) return;               // another tab is on screen
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    const dir = KEY_DIRS[ev.key] || KEY_DIRS[ev.key?.toLowerCase?.()];
    if (dir) {
      // Arrows scroll the page and space scrolls it further, both of which are
      // ruinous mid-run. Only swallowed once the key is known to be ours.
      ev.preventDefault();
      steer(dir);
      return;
    }
    if (ev.key === ' ') {
      ev.preventDefault();
      togglePause();
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (screen !== 'playing' && screen !== 'paused') startRun();
      else if (screen === 'paused') togglePause();
    }
  }

  window.addEventListener('keydown', onKey);

  // Touch: `pointerdown` rather than `click` so a tap registers on contact
  // instead of on release, which at level 9 is a whole step of lag.
  for (const btn of root.querySelectorAll('.pad button')) {
    btn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();          // don't let a long press select or scroll
      steer(btn.dataset.dir);
    });
  }

  /* ============================== drawing ============================== */

  function draw(invert = false) {
    const bg = invert ? INK : LCD;
    const fg = invert ? LCD : INK;

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!game) return;

    ctx.fillStyle = fg;

    if (game.food) drawFood(game.food, bg);

    game.snake.forEach((seg, i) => {
      const x = seg.x * CELL;
      const y = seg.y * CELL;
      ctx.fillStyle = fg;
      ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
      // Body segments are hollow and the head is solid. On the phone every
      // segment was a plain block, but a paused or just-died snake is then a
      // rope with two identical ends and no way to tell which way it was going.
      if (i > 0) {
        ctx.fillStyle = bg;
        ctx.fillRect(x + 5, y + 5, CELL - 10, CELL - 10);
      }
    });
  }

  /** Food is a plus, not a block — a pellet shaped like a body segment is one
   *  more thing to squint at when the snake is long and the arena is busy. */
  function drawFood(food, bg) {
    const x = food.x * CELL;
    const y = food.y * CELL;
    ctx.fillRect(x + 6, y + 2, 4, CELL - 4);
    ctx.fillRect(x + 2, y + 6, CELL - 4, 4);
    ctx.fillStyle = bg;
    ctx.fillRect(x + 6, y + 6, 4, 4);
    ctx.fillStyle = INK;
  }

  /** The death flash: the arena inverts a few times, LCD-style. */
  function drawFlash() {
    const now = performance.now();
    if (now >= flashUntil) { draw(); return; }
    draw(Math.floor(now / 70) % 2 === 0);
    requestAnimationFrame(drawFlash);
  }

  /* ============================== render ============================== */

  function renderAll() {
    renderHud();
    renderOverlay();
    renderLevels();
    renderHighs();
    draw();
  }

  function renderHud() {
    el('sc').textContent = game ? String(game.score) : '0';
    el('lv').textContent = 'L' + (game ? game.level : level);
  }

  function renderLevels() {
    const wrap = el('levels');
    // Rebuilt only when the selection moves, so holding a button doesn't have
    // the element replaced out from under the press.
    if (wrap.dataset.sel !== String(level)) {
      wrap.dataset.sel = String(level);
      wrap.innerHTML = '';
      for (let lv = MIN_LEVEL; lv <= MAX_LEVEL; lv++) {
        const b = document.createElement('button');
        b.className = 'lvbtn' + (lv === level ? ' on' : '');
        b.textContent = String(lv);
        b.setAttribute('aria-pressed', String(lv === level));
        b.onclick = () => { level = clampLevel(lv); renderAll(); };
        wrap.appendChild(b);
      }
    }
    // Changing level mid-run would rewrite the speed a score was earned at, so
    // it is chosen between games and applies to the next one.
    const mid = screen === 'playing' || screen === 'paused';
    for (const b of wrap.children) b.disabled = mid;
    el('lvhint').textContent = mid
      ? 'Level is fixed for this run.'
      : `Level ${level} · ${Math.round(1000 / tickMs(level))} moves a second · ${pointsPerFood(level)} a pellet`;
  }

  function renderHighs() {
    const rows = Object.keys(highs)
      .map(Number)
      .sort((a, b) => highs[b] - highs[a] || a - b)
      .slice(0, 5);

    el('highs').innerHTML = rows.length
      ? rows.map((lv) => `
          <li${lv === level ? ' class="on"' : ''}>
            <div class="nm">Level ${lv}</div>
            <div class="pts">${highs[lv]}</div>
          </li>`).join('')
      : '<li class="empty">Nothing yet. Go and eat something.</li>';
  }

  function renderOverlay() {
    const o = el('overlay');
    o.hidden = screen === 'playing';
    if (o.hidden) { o.innerHTML = ''; return; }

    o.innerHTML = overlayHTML();
    o.querySelector('.go')?.addEventListener('click', () => {
      if (screen === 'paused') togglePause();
      else startRun();
    });
  }

  function overlayHTML() {
    if (screen === 'menu') {
      return card('SNAKE', `Level ${level} · eat, grow, don't touch anything.`, 'Start');
    }
    if (screen === 'paused') {
      return card('PAUSED', `Score ${game.score}`, 'Resume');
    }
    if (screen === 'won') {
      return card('PERFECT', `You filled the arena. ${game.score} points.`, 'Play again');
    }
    const best = highs[game.level] || 0;
    const sub = record
      ? `${game.score} points — new best for level ${game.level}`
      : `${game.score} points · best ${best}`;
    return card('GAME OVER', sub, 'Play again',
      game.cause === 'wall' ? 'You hit the wall.' : 'You ate yourself.');
  }

  function card(title, sub, action, note) {
    return `
      <div class="card2">
        <h2>${esc(title)}</h2>
        ${note ? `<div class="cause">${esc(note)}</div>` : ''}
        <div class="sub">${esc(sub)}</div>
        <button class="primary go">${esc(action)}</button>
      </div>`;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  /* ============================ tab lifecycle ============================ */

  // The shell keeps every game's panel alive when you switch tabs, so without
  // this a run would carry on ticking — and dying — while you were off looking
  // at the map. Pausing rather than stopping means you come back to your run.
  function onShow() {
    active = true;
  }

  function onHide() {
    active = false;
    if (screen === 'playing') togglePause();
  }

  // The same argument one level up: switching *browser* tabs leaves the run
  // going, and a hidden tab has its timers clamped to about a second, so the
  // snake crawls on at a fifth of its proper speed and is usually dead against
  // a wall by the time you look back. Pause on the way out; leave it paused on
  // the way in, since a run that resumes the instant the tab appears starts
  // before the player's hands are anywhere near the keys.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && screen === 'playing') togglePause();
  });

  // The shell reads onShow/onHide off the module object, but they need to close
  // over this run's timer and state, so they are hung on at boot rather than
  // declared up front. The shell only calls them after `init`, so there is no
  // window in which they are missing.
  snake.onShow = onShow;
  snake.onHide = onHide;

  renderAll();
}

const snake = { id: GAME, title: 'Snake', init };

export default snake;
