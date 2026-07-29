// Flappy Bird — canvas, controls, and the run loop around rules.js.
//
// Like Snake, this is one player against a machine, so there is no net.js in
// here: no room code, no seats, nothing to broadcast. It keeps the shell's tab
// contract (`init(root, header)`, `onShow`/`onHide`) and the rules/DOM split,
// and drops the rest.
//
// ---- Why the loop looks like this and not like Snake's ----
//
// Snake moves on a grid a few times a second, so a chained setTimeout is the
// natural clock. A bird falling under gravity needs to be drawn every frame or
// it stutters, but it must be *simulated* on a fixed step or the physics
// becomes a function of the monitor's refresh rate. So: rAF drives painting,
// and an accumulator spends the elapsed time on whole 1/60s steps from
// rules.js. See rules.js for why that matters.

import {
  WIDTH, HEIGHT, GROUND_H, FLOOR, TICK_MS,
  PIPE_GAP, PIPE_W, BIRD_R,
  createState, flap as flapBird, step, restart,
} from './rules.js';

const GAME = 'flappy';

const BEST_KEY = 'meridian.flappy.best';

/** Longest gap we will simulate through in one frame, in steps.
 *  A frame that took half a second — a slow first paint, a dragged window —
 *  should not be paid back as thirty steps of flightless falling. */
const MAX_CATCHUP = 5;

/* Palette, straight off the canvas. Kept here rather than in the stylesheet
   because the canvas can't read CSS custom properties without a getComputedStyle
   per repaint, and these never change. */
const SKY = '#70c5ce';
const GROUND = '#ded895';
const GROUND_EDGE = '#c0b768';

const TABLE_HTML = `
  <div class="table">
    <div class="stage">
      <div class="screen">
        <canvas class="board" width="${WIDTH}" height="${HEIGHT}"
                aria-label="Flappy Bird playfield"></canvas>
        <div class="overlay" hidden></div>
      </div>
    </div>
    <aside>
      <div class="loghead">How to play</div>
      <ul class="keys">
        <li><kbd>Space</kbd><span>flap — or click, or tap the sky</span></li>
        <li><kbd>P</kbd><span>pause</span></li>
        <li><kbd>Enter</kbd><span>start, or play again</span></li>
      </ul>
      <div class="blurb">
        Through the gap, not the pipe. The ceiling only bumps you; the ground
        is the end of it.
      </div>
      <div class="loghead">Best score</div>
      <div class="best"></div>
      <div class="loghead">This run</div>
      <ul class="stats">
        <li><span class="nm">Pipes cleared</span><span class="pts sc">0</span></li>
      </ul>
    </aside>
  </div>
`;

/* ---- best score ----
   Storage is best-effort: private windows and locked-down profiles throw on
   access, and a forgotten high score is not worth taking the game down over. */

function loadBest() {
  try {
    const n = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function saveBest(best) {
  try {
    localStorage.setItem(BEST_KEY, String(best));
  } catch {
    /* nothing to do — the score just doesn't outlive the tab */
  }
}

function init(root, header) {
  let game = createState();   // a bobbing menu bird from the moment you arrive
  let screen = 'ready';       // ready | playing | paused | dead
  let best = loadBest();
  let record = false;         // did the run that just ended beat the best?

  let raf = null;
  let lastTs = 0;             // timestamp of the previous frame
  let acc = 0;                // unspent milliseconds owed to the simulation
  let active = false;         // is this tab on screen? gates the key handler

  const el = (sel) => root.querySelector('.' + sel);

  root.innerHTML = TABLE_HTML;
  const canvas = el('board');
  const ctx = canvas.getContext('2d');

  header.innerHTML = '<div class="tag flappytag">1 player</div>' +
                     '<button class="newgame">New game</button>';
  header.querySelector('.newgame').onclick = () => startRun();

  /* ============================ the run loop ============================ */

  function play() {
    if (raf !== null) return;
    lastTs = 0;
    acc = 0;
    raf = requestAnimationFrame(frame);
  }

  function pauseLoop() {
    if (raf === null) return;
    cancelAnimationFrame(raf);
    raf = null;
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);

    // First frame after a start or resume has no previous timestamp to measure
    // against, so it buys no steps — it just paints and sets the clock.
    const dt = lastTs ? ts - lastTs : 0;
    lastTs = ts;
    acc += dt;

    let n = 0;
    while (acc >= TICK_MS && n < MAX_CATCHUP) {
      acc -= TICK_MS;
      n += 1;
      if (!tick()) break;      // the run ended inside this frame
    }
    // Whatever is left after the cap is time the game was never going to get;
    // keeping it would only make the next frame lurch to catch up.
    if (acc >= TICK_MS * MAX_CATCHUP) acc = 0;

    draw();
  }

  /** One simulation step. Returns false if the loop should stop. */
  function tick() {
    const res = step(game);
    if (res.scored) renderStats();
    if (res.died) {
      finish();
      return false;
    }
    return true;
  }

  function startRun() {
    game = restart(game);
    screen = 'ready';
    record = false;
    renderAll();
    play();
  }

  function finish() {
    screen = 'dead';
    if (game.score > best) {
      record = true;
      best = game.score;
      saveBest(best);
    }

    // Hold the crash frame for a beat before the overlay covers it, so you can
    // see what you actually flew into. Dying and being told about it in the
    // same frame reads as the game having cheated you.
    setTimeout(() => {
      if (screen !== 'dead') return;   // a new run started during the pause
      pauseLoop();
      renderAll();
    }, 420);
  }

  function togglePause() {
    if (screen === 'playing' || screen === 'ready') {
      screen = 'paused';
      pauseLoop();
      renderAll();
    } else if (screen === 'paused') {
      // Back to whichever screen we interrupted: a run that hadn't started
      // yet resumes as the menu, not mid-flight.
      screen = game.phase === 'ready' ? 'ready' : 'playing';
      renderAll();
      play();
    }
  }

  /* ============================== input ============================== */

  function flap() {
    if (screen === 'paused' || screen === 'dead') return;
    if (flapBird(game) && screen === 'ready') {
      screen = 'playing';
      renderOverlay();     // the menu card goes as the bird takes off
    }
  }

  function onKey(ev) {
    if (!active) return;               // another tab is on screen
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    if (ev.key === ' ' || ev.code === 'Space') {
      // Space scrolls the page, which mid-run is ruinous. Only swallowed once
      // the key is known to be ours.
      ev.preventDefault();
      flap();
      return;
    }
    if (ev.key === 'p' || ev.key === 'P') {
      ev.preventDefault();
      togglePause();
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (screen === 'dead') startRun();
      else if (screen === 'paused') togglePause();
      else flap();
    }
  }

  window.addEventListener('keydown', onKey);

  // `pointerdown` rather than `click` so a tap registers on contact instead of
  // on release, which under gravity is a bird's-length of lag.
  canvas.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    flap();
  });

  /* ============================== drawing ============================== */

  function draw() {
    ctx.fillStyle = SKY;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    for (const p of game.pipes) drawPipe(p);

    ctx.fillStyle = GROUND;
    ctx.fillRect(0, FLOOR, WIDTH, GROUND_H);
    ctx.fillStyle = GROUND_EDGE;
    ctx.fillRect(0, FLOOR, WIDTH, 8);

    drawBird();
    drawScore();
  }

  function drawBird() {
    const bird = game.bird;
    ctx.save();
    ctx.translate(bird.x, bird.y);
    // Nose up when climbing, dive when falling — clamped either side so the
    // bird never ends up flying backwards on a long drop.
    ctx.rotate(Math.max(-0.5, Math.min(1.2, bird.vy / 12)));

    // body
    ctx.fillStyle = '#f8d347';
    ctx.beginPath();
    ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#c9a227';
    ctx.lineWidth = 2;
    ctx.stroke();

    // wing
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(-3, 2, 7, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // eye
    ctx.beginPath();
    ctx.arc(6, -5, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(7, -5, 2.2, 0, Math.PI * 2);
    ctx.fill();

    // beak
    ctx.fillStyle = '#e8792a';
    ctx.beginPath();
    ctx.moveTo(BIRD_R - 2, -2);
    ctx.lineTo(BIRD_R + 7, 0);
    ctx.lineTo(BIRD_R - 2, 4);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function drawPipe(p) {
    // Lit on the left, shaded on the right: a flat green rectangle reads as a
    // hole in the sky rather than a pipe standing in front of it.
    const grad = ctx.createLinearGradient(p.x, 0, p.x + PIPE_W, 0);
    grad.addColorStop(0, '#5aa832');
    grad.addColorStop(0.5, '#74c945');
    grad.addColorStop(1, '#4e9a2a');
    ctx.fillStyle = grad;

    // top pipe, then its lip
    ctx.fillRect(p.x, 0, PIPE_W, p.top);
    ctx.fillRect(p.x - 4, p.top - 24, PIPE_W + 8, 24);

    // bottom pipe, lip first this time
    const by = p.top + PIPE_GAP;
    ctx.fillRect(p.x, by, PIPE_W, FLOOR - by);
    ctx.fillRect(p.x - 4, by, PIPE_W + 8, 24);

    ctx.strokeStyle = '#3c7a1f';
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x, 0, PIPE_W, p.top);
    ctx.strokeRect(p.x, by, PIPE_W, FLOOR - by);
  }

  function drawScore() {
    // On the canvas rather than beside it: at speed your eyes are on the bird,
    // and a number in the side panel is a number you never actually read.
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 3;
    ctx.font = 'bold 42px sans-serif';
    ctx.textAlign = 'center';
    ctx.strokeText(game.score, WIDTH / 2, 70);
    ctx.fillText(game.score, WIDTH / 2, 70);
  }

  /* ============================== render ============================== */

  function renderAll() {
    renderOverlay();
    renderStats();
    renderBest();
    draw();
  }

  function renderStats() {
    el('sc').textContent = String(game.score);
  }

  function renderBest() {
    el('best').innerHTML = best
      ? `<span class="n">${best}</span><span class="u">pipe${best === 1 ? '' : 's'}</span>`
      : '<span class="none">Nothing yet. Mind the pipes.</span>';
  }

  function renderOverlay() {
    const o = el('overlay');
    o.hidden = screen === 'playing';
    if (o.hidden) { o.innerHTML = ''; return; }

    o.innerHTML = overlayHTML();
    o.className = 'overlay' + (screen === 'dead' ? ' dim' : '');
    o.querySelector('.go')?.addEventListener('click', () => {
      if (screen === 'paused') togglePause();
      else if (screen === 'dead') startRun();
      else flap();
    });
  }

  function overlayHTML() {
    if (screen === 'ready') {
      return card('FLAPPY BIRD', 'Space, click or tap to flap.', 'Start');
    }
    if (screen === 'paused') {
      return card('PAUSED', `${game.score} cleared so far`, 'Resume');
    }
    const sub = record
      ? `${game.score} pipes — a new best`
      : `${game.score} pipes · best ${best}`;
    return card('GAME OVER', sub, 'Play again',
      game.cause === 'ground' ? 'You hit the ground.' : 'You hit a pipe.');
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

  // The shell keeps every game's panel alive when you switch tabs. rAF is
  // already frozen while the browser tab is in the background, but switching
  // to Ludo *inside* the site leaves this one visible to the browser and
  // falling, so pause on the way out. Pausing rather than stopping means you
  // come back to your run.
  function onShow() {
    active = true;
    if (screen === 'playing' || screen === 'ready') play();
  }

  function onHide() {
    active = false;
    if (screen === 'playing' || screen === 'ready') togglePause();
    else pauseLoop();
  }

  // Same argument one level up. rAF stopping on a hidden browser tab means the
  // bird survives the trip, but it resumes the instant the tab comes back —
  // mid-air, before the player's hands are anywhere near the keys. Pause on
  // the way out and leave it paused on the way in.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && (screen === 'playing' || screen === 'ready')) togglePause();
  });

  // The shell reads onShow/onHide off the module object, but they need to
  // close over this run's loop and state, so they are hung on at boot rather
  // than declared up front. The shell only calls them after `init`, so there
  // is no window in which they are missing.
  flappy.onShow = onShow;
  flappy.onHide = onHide;

  renderAll();
}

const flappy = { id: GAME, title: 'Flappy', init };

export default flappy;
