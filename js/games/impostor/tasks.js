// The four jobs, as self-contained widgets.
//
// Each one is `open(body, station, done)`: fill the element, call `done()` when
// solved, and return a teardown function. They know nothing about the game —
// no state, no network, no idea whether the player running them is a crewmate
// doing real work or an impostor standing in a doorway looking busy. index.js
// wires the result up; if it never comes, nothing happened.
//
// ---- Why they are all short ----
//
// A task is not the game. It is the thing you are looking at instead of the
// corridor behind you, and every second of it is a second someone could be
// walking up. Two to four seconds each is enough to be worth interrupting and
// short enough that finishing one feels like getting away with something.
//
// ---- Why none of them are drag-only where it can be helped ----
//
// Wiring connects by click, not by drag, because a drag that starts on the
// wrong pixel does nothing and reads as the game being broken. Alignment and
// the card reader are drags — sliding *is* the interaction in both — so they
// take arrow keys and a tap as well.

const WIRE_COLORS = ['#e5484d', '#3d7dff', '#ffc53d', '#f07eb8'];

const shuffle = (list) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * A rAF loop that stops itself on teardown.
 * @param {(dt: number) => void} onFrame dt in milliseconds, capped.
 */
function ticker(onFrame) {
  let raf = null, last = 0;
  const frame = (ts) => {
    raf = requestAnimationFrame(frame);
    // A backgrounded tab returns with a huge dt. Cap it, or a meter that was
    // draining empties in one frame while you were reading another window.
    const dt = last ? Math.min(100, ts - last) : 0;
    last = ts;
    onFrame(dt);
  };
  raf = requestAnimationFrame(frame);
  return () => { if (raf !== null) cancelAnimationFrame(raf); raf = null; };
}

/* ============================== wiring ============================== */

function openWires(body, _station, done) {
  const right = shuffle(WIRE_COLORS.map((c, i) => ({ c, i })));

  body.innerHTML = `
    <div class="mg-hint">Connect each wire to its colour.</div>
    <div class="mg-wires">
      <div class="side left">
        ${WIRE_COLORS.map((c, i) => `<button class="node" data-side="l" data-i="${i}" style="--c:${c}"></button>`).join('')}
      </div>
      <svg class="links" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>
      <div class="side right">
        ${right.map((r) => `<button class="node" data-side="r" data-i="${r.i}" style="--c:${r.c}"></button>`).join('')}
      </div>
    </div>`;

  const svg = body.querySelector('.links');
  const nodes = [...body.querySelectorAll('.node')];
  const joined = new Set();
  let picked = null;

  // Rows are evenly spaced, so a node's y is a function of its position in its
  // column — no measuring, and it survives the panel being resized mid-task.
  const rowY = (el) => {
    const col = [...el.parentElement.children];
    return ((col.indexOf(el) + 0.5) / col.length) * 100;
  };

  function link(a, b, color) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', 0);
    line.setAttribute('y1', rowY(a));
    line.setAttribute('x2', 100);
    line.setAttribute('y2', rowY(b));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', 3);
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(line);
  }

  const onClick = (ev) => {
    const el = ev.target.closest('.node');
    if (!el || el.classList.contains('wired')) return;

    if (el.dataset.side === 'l') {
      picked?.classList.remove('picked');
      picked = picked === el ? null : el;
      picked?.classList.add('picked');
      return;
    }
    if (!picked) return;

    if (picked.dataset.i !== el.dataset.i) {
      // Wrong colour: say so and drop the selection rather than silently
      // ignoring the click, which looks like a dead button.
      el.classList.add('wrong');
      setTimeout(() => el.classList.remove('wrong'), 260);
      picked.classList.remove('picked');
      picked = null;
      return;
    }

    link(picked, el, WIRE_COLORS[+el.dataset.i]);
    picked.classList.remove('picked');
    picked.classList.add('wired');
    el.classList.add('wired');
    joined.add(el.dataset.i);
    picked = null;
    if (joined.size === WIRE_COLORS.length) setTimeout(done, 260);
  };

  body.addEventListener('click', onClick);
  nodes[0].focus();
  return () => body.removeEventListener('click', onClick);
}

/* ============================== card swipe ============================== */

const SWIPE_MIN_MS = 320;
const SWIPE_MAX_MS = 950;

function openSwipe(body, _station, done) {
  body.innerHTML = `
    <div class="mg-hint">Swipe the card left to right — not too fast.</div>
    <div class="mg-reader">
      <div class="slot"><div class="card" tabindex="0">ID</div></div>
      <div class="verdict"></div>
    </div>`;

  const slot = body.querySelector('.slot');
  const card = body.querySelector('.card');
  const verdict = body.querySelector('.verdict');

  let dragging = false, startedAt = 0, pos = 0;   // pos is 0..1 across the slot

  const place = () => { card.style.left = (pos * 100) + '%'; };

  function reset(msg, bad) {
    pos = 0;
    dragging = false;
    place();
    card.classList.toggle('bad', !!bad);
    verdict.textContent = msg || '';
    if (bad) setTimeout(() => card.classList.remove('bad'), 400);
  }

  function finish() {
    const ms = performance.now() - startedAt;
    if (ms < SWIPE_MIN_MS) return reset('Too fast — swipe again.', true);
    if (ms > SWIPE_MAX_MS) return reset('Too slow — swipe again.', true);
    verdict.textContent = 'Accepted.';
    card.classList.add('good');
    dragging = false;
    setTimeout(done, 320);
  }

  const onDown = (ev) => {
    if (card.classList.contains('good')) return;
    dragging = true;
    startedAt = performance.now();
    verdict.textContent = '';
    card.setPointerCapture?.(ev.pointerId);
  };

  const onMove = (ev) => {
    if (!dragging) return;
    const r = slot.getBoundingClientRect();
    pos = clamp01((ev.clientX - r.left - card.offsetWidth / 2) / (r.width - card.offsetWidth));
    place();
    if (pos >= 0.995) finish();
  };

  // Letting go halfway is a failed swipe, not a paused one. The reader has no
  // idea you changed your mind.
  const onUp = () => { if (dragging && pos < 0.995) reset('Swipe all the way through.', true); dragging = false; };

  // Keyboard: hold right to run the card through. The timing window applies
  // the same way, which is what makes this a real alternative and not a
  // shortcut past the task.
  const onKey = (ev) => {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    ev.preventDefault();
    if (card.classList.contains('good')) return;
    if (!dragging) { dragging = true; startedAt = performance.now(); verdict.textContent = ''; }
    pos = clamp01(pos + (ev.key === 'ArrowRight' ? 0.06 : -0.06));
    place();
    if (pos >= 0.995) finish();
  };

  card.addEventListener('pointerdown', onDown);
  card.addEventListener('pointermove', onMove);
  card.addEventListener('pointerup', onUp);
  card.addEventListener('pointercancel', onUp);
  card.addEventListener('keydown', onKey);
  place();
  card.focus();

  return () => {
    card.removeEventListener('pointerdown', onDown);
    card.removeEventListener('pointermove', onMove);
    card.removeEventListener('pointerup', onUp);
    card.removeEventListener('pointercancel', onUp);
    card.removeEventListener('keydown', onKey);
  };
}

/* ============================== hold ============================== */

const HOLD_MS = 2600;

function openHold(body, station, done) {
  body.innerHTML = `
    <div class="mg-hint">Hold the button until the gauge is full.</div>
    <div class="mg-hold">
      <div class="gauge"><div class="fill"></div></div>
      <button class="holdbtn">${station.kind === 'hold' ? 'HOLD' : 'HOLD'}</button>
    </div>`;

  const fill = body.querySelector('.fill');
  const btn = body.querySelector('.holdbtn');
  let held = false, at = 0, finished = false;

  const stop = ticker((dt) => {
    if (finished) return;
    // Draining is faster than filling, so letting go to check the corridor
    // costs you something. Not enough to be cruel — you keep most of it.
    at = clamp01(at + (held ? dt / HOLD_MS : -dt / (HOLD_MS * 1.6)));
    fill.style.width = (at * 100) + '%';
    if (at >= 1) {
      finished = true;
      btn.classList.add('good');
      setTimeout(done, 260);
    }
  });

  const grab = (ev) => { ev.preventDefault(); held = true; btn.classList.add('down'); };
  const let_go = () => { held = false; btn.classList.remove('down'); };
  const key = (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); held = true; btn.classList.add('down'); } };
  const keyUp = (ev) => { if (ev.key === ' ' || ev.key === 'Enter') let_go(); };

  btn.addEventListener('pointerdown', grab);
  btn.addEventListener('keydown', key);
  btn.addEventListener('keyup', keyUp);
  window.addEventListener('pointerup', let_go);
  window.addEventListener('pointercancel', let_go);
  btn.addEventListener('pointerleave', let_go);
  btn.focus();

  return () => {
    stop();
    window.removeEventListener('pointerup', let_go);
    window.removeEventListener('pointercancel', let_go);
  };
}

/* ============================== alignment ============================== */

const LOCK_MS = 1500;      // time held inside the band to finish
const BAND = 0.13;         // half-width of the target, as a fraction of the track

function openAlign(body, _station, done) {
  body.innerHTML = `
    <div class="mg-hint">Hold the marker inside the band.</div>
    <div class="mg-align">
      <div class="track">
        <div class="band"></div>
        <div class="marker" tabindex="0"></div>
      </div>
      <div class="gauge"><div class="fill"></div></div>
    </div>`;

  const track = body.querySelector('.track');
  const band = body.querySelector('.band');
  const marker = body.querySelector('.marker');
  const fill = body.querySelector('.fill');

  let pos = 0.5;                                    // the marker, 0..1
  let lock = 0;
  let t = Math.random() * 10;
  let dragging = false, finished = false;
  // Two sines of unrelated periods, so the drift never settles into a rhythm
  // you can just park on and wait out.
  const centre = () => 0.5 + Math.sin(t * 0.9) * 0.26 + Math.sin(t * 2.3) * 0.09;

  band.style.width = (BAND * 200) + '%';

  const stop = ticker((dt) => {
    if (finished) return;
    t += dt / 1000;
    const c = centre();
    band.style.left = (c * 100) + '%';
    marker.style.left = (pos * 100) + '%';

    const inside = Math.abs(pos - c) < BAND;
    lock = clamp01(lock + (inside ? dt / LOCK_MS : -dt / (LOCK_MS * 1.2)));
    fill.style.width = (lock * 100) + '%';
    marker.classList.toggle('locked', inside);

    if (lock >= 1) {
      finished = true;
      marker.classList.add('good');
      setTimeout(done, 260);
    }
  });

  const setFromEvent = (ev) => {
    const r = track.getBoundingClientRect();
    pos = clamp01((ev.clientX - r.left) / r.width);
  };
  const onDown = (ev) => { dragging = true; marker.setPointerCapture?.(ev.pointerId); setFromEvent(ev); };
  const onMove = (ev) => { if (dragging) setFromEvent(ev); };
  const onUp = () => { dragging = false; };
  const onKey = (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    pos = clamp01(pos + (ev.key === 'ArrowRight' ? 0.05 : -0.05));
  };

  // Listening on the track, not the marker, so a click anywhere on the bar
  // jumps to it — chasing a moving target with a 12px grab handle is a test
  // of mousemanship, not of nerve.
  track.addEventListener('pointerdown', onDown);
  track.addEventListener('pointermove', onMove);
  track.addEventListener('pointerup', onUp);
  track.addEventListener('pointercancel', onUp);
  marker.addEventListener('keydown', onKey);
  marker.focus();

  return () => {
    stop();
    track.removeEventListener('pointerdown', onDown);
    track.removeEventListener('pointermove', onMove);
    track.removeEventListener('pointerup', onUp);
    track.removeEventListener('pointercancel', onUp);
  };
}

/* ============================== dispatch ============================== */

const KINDS = { wires: openWires, swipe: openSwipe, hold: openHold, align: openAlign };

/**
 * Run the minigame for `station` inside `body`.
 * @returns {() => void} teardown — always call it, solved or abandoned.
 */
export function openTask(body, station, done) {
  const open = KINDS[station.kind];
  if (!open) {
    // An unknown kind is a bug in map.js, not something the player can fix, so
    // it hands them the completion rather than a locked door.
    body.innerHTML = '<div class="mg-hint">This console is out of order.</div>';
    setTimeout(done, 400);
    return () => {};
  }
  return open(body, station, done);
}
