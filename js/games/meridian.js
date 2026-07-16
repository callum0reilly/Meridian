// Meridian — guess the mystery country; warmer means closer.
//
// Ported from the original single-file build. The game logic is unchanged; the
// only structural difference is that everything touching the DOM now runs
// inside init() against a scoped root element instead of document-wide ids.

import { DATA } from '../data/countries.js';

/* ---------- geo helpers ---------- */
const R = 6371, RAD = Math.PI / 180;

function haversine(a, b) {
  const dLat = (b[1] - a[1]) * RAD, dLng = (b[0] - a[0]) * RAD;
  const la1 = a[1] * RAD, la2 = b[1] * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Distance between the nearest points of two countries, so that neighbours
// sharing a border read as 0 the way they do in Globle. Compared against a
// bounding-box floor first to skip pairs that can't beat the best so far.
function countryDistance(a, b) {
  let best = Infinity;
  for (const ra of a.g) for (const rb of b.g) {
    if (boxGap(ra.box, rb.box) >= best) continue;
    for (const pa of ra.pts) for (const pb of rb.pts) {
      const d = haversine(pa, pb);
      if (d < best) { best = d; if (best === 0) return 0; }
    }
  }
  return best;
}

// Cheap lower bound on the distance between two lat/lng boxes.
function boxGap(x, y) {
  const dLat = Math.max(0, Math.max(x[1] - y[3], y[1] - x[3]));
  let dLng = Math.max(0, Math.max(x[0] - y[2], y[0] - x[2]));
  if (dLng > 180) dLng = 360 - dLng;
  const lat = Math.max(Math.abs(x[1]), Math.abs(y[1])) * RAD;
  const kLat = 111.32, kLng = 111.32 * Math.max(0.05, Math.cos(Math.min(lat, 89 * RAD)));
  return Math.hypot(dLat * kLat, dLng * kLng);
}

function bearing(a, b) {
  const la1 = a[1] * RAD, la2 = b[1] * RAD, dLng = (b[0] - a[0]) * RAD;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}
const ARROWS = ['↑','↗','→','↘','↓','↙','←','↖'];
const arrowFor = (deg) => ARROWS[Math.round(deg / 45) % 8];

/* ---------- projection (Miller cylindrical) ---------- */
const SC = 100;
const projX = (lng) => lng * RAD * SC;
const projY = (lat) => {
  const p = Math.max(-89.5, Math.min(89.5, lat)) * RAD;
  return -1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * p)) * SC;
};

/* ---------- prep (pure, no DOM — safe at module scope) ---------- */
const countries = DATA.map((c) => ({
  name: c.n,
  region: c.r,
  centroid: c.c,
  aliases: c.a || [],
  g: c.g.map((pts) => {
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    for (const p of pts) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    return { pts, box: [x0, y0, x1, y1] };
  }),
}));
const playable = countries.filter((c) => c.region);

// Strip combining marks so "Türkiye"/"Côte d'Ivoire" match plain ASCII typing.
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').trim();
const lookup = new Map();
for (const c of playable) {
  lookup.set(norm(c.name), c);
  for (const a of c.aliases) lookup.set(norm(a), c);
}

/* ---------- colour ---------- */
const MAXD = 8000; // km at which a guess is fully "cold"
const STOPS = [[247,238,215], [235,178,90], [214,96,44], [150,26,26]];
function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
function heat(d) {
  let t = 1 - Math.min(d, MAXD) / MAXD;
  t = Math.pow(t, 0.65);                       // spread the cold end out
  const s = t * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(s));
  return 'rgb(' + mix(STOPS[i], STOPS[i + 1], s - i).join(',') + ')';
}

const fmt = (d) => d === 0 ? 'borders' : (d < 1000 ? Math.round(d) + ' km' : (d / 1000).toFixed(1) + 'k km');

const EMPTY_LIST =
  '<div class="empty">No guesses yet.<br>Every country in Europe, Africa, Asia, ' +
  'North America and South America is in play.</div>';

const TEMPLATE = `
  <div class="mapwrap">
    <svg class="map" preserveAspectRatio="xMidYMid meet"></svg>
    <div class="tip"></div>
    <div class="legend">
      <div>Proximity to the answer</div>
      <div class="bar"></div>
      <div class="ends"><span>far</span><span>bordering</span></div>
    </div>
    <div class="zoom">
      <button class="zin" title="Zoom in">+</button>
      <button class="zout" title="Zoom out">−</button>
      <button class="zreset" title="Reset view">⟲</button>
    </div>
    <div class="winwrap">
      <div class="card">
        <h2>Correct!</h2>
        <div class="ans winname"></div>
        <div class="sub winsub"></div>
        <button class="primary again">Play again</button>
      </div>
    </div>
  </div>

  <aside>
    <div class="pad entry">
      <input class="guess" autocomplete="off" autocorrect="off" spellcheck="false"
             placeholder="Type a country, or click the map…">
      <div class="ac"></div>
    </div>
    <div class="err"></div>

    <div class="status">
      <div class="count">Guesses: <b class="cnt">0</b></div>
      <div class="spacer"></div>
      <button class="hintbtn">Hint — costs 3 guesses</button>
    </div>

    <div class="hintbox">
      Reveal which continent the country is on?<br>
      This adds <span class="warn">+3 to your guess count</span> and you only get
      <span class="warn">one hint per game</span>.
      <div class="row">
        <button class="primary hintyes">Yes, +3</button>
        <button class="hintno">Cancel</button>
      </div>
    </div>

    <div class="revealed"></div>

    <div class="listhead"><span>Your guesses</span><span class="closest"></span></div>
    <div class="list">${EMPTY_LIST}</div>
  </aside>
`;

function init(root, header) {
  root.innerHTML = TEMPLATE;
  const $ = (sel) => root.querySelector('.' + sel);

  header.innerHTML =
    '<div class="tag">Guess the mystery country — warmer means closer</div>' +
    '<button class="newgame">New game</button>';

  $('bar').style.background =
    'linear-gradient(90deg,' + [0, .25, .5, .75, 1].map((f) => heat(MAXD * (1 - f))).join(',') + ')';

  /* ---------- render map ---------- */
  const svg = $('map');
  const NS = 'http://www.w3.org/2000/svg';
  const paths = new Map();
  let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;

  for (const c of countries) {
    let d = '';
    for (const ring of c.g) {
      d += 'M' + ring.pts.map((p) => {
        const x = projX(p[0]), y = projY(p[1]);
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join('L') + 'Z';
    }
    const el = document.createElementNS(NS, 'path');
    el.setAttribute('d', d);
    el.setAttribute('class', 'c ' + (c.region ? 'playable' : 'inert'));
    el.dataset.name = c.name;
    svg.appendChild(el);
    paths.set(c.name, el);
  }

  const HOME = [bx0 - 8, by0 - 8, bx1 - bx0 + 16, by1 - by0 + 16];
  let view = HOME.slice();
  const applyView = () => svg.setAttribute('viewBox', view.map((v) => v.toFixed(1)).join(' '));
  applyView();

  /* ---------- pan & zoom ---------- */
  function zoomAt(factor, cx, cy) {
    const nw = Math.min(HOME[2], Math.max(HOME[2] / 40, view[2] * factor));
    const k = nw / view[2];
    view = [cx - (cx - view[0]) * k, cy - (cy - view[1]) * k, nw, view[3] * k];
    clampView();
    applyView();
  }
  function clampView() {
    view[0] = Math.max(HOME[0] - 4, Math.min(HOME[0] + HOME[2] - view[2] + 4, view[0]));
    view[1] = Math.max(HOME[1] - 4, Math.min(HOME[1] + HOME[3] - view[3] + 4, view[1]));
  }
  const svgPoint = (ev) => {
    const r = svg.getBoundingClientRect();
    const s = Math.max(view[2] / r.width, view[3] / r.height); // preserveAspectRatio: meet
    return [
      view[0] + view[2] / 2 + (ev.clientX - r.left - r.width / 2) * s,
      view[1] + view[3] / 2 + (ev.clientY - r.top - r.height / 2) * s,
    ];
  };

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [cx, cy] = svgPoint(ev);
    zoomAt(ev.deltaY > 0 ? 1.18 : 1 / 1.18, cx, cy);
  }, { passive: false });

  let drag = null, moved = 0;
  svg.addEventListener('pointerdown', (ev) => {
    drag = { x: ev.clientX, y: ev.clientY, vx: view[0], vy: view[1] };
    moved = 0;
    svg.setPointerCapture(ev.pointerId);
    svg.classList.add('dragging');
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    const s = Math.max(view[2] / r.width, view[3] / r.height);
    moved = Math.max(moved, Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y));
    view[0] = drag.vx - (ev.clientX - drag.x) * s;
    view[1] = drag.vy - (ev.clientY - drag.y) * s;
    clampView();
    applyView();
  });
  const endDrag = () => { drag = null; svg.classList.remove('dragging'); };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  $('zin').onclick = () => zoomAt(1 / 1.4, view[0] + view[2] / 2, view[1] + view[3] / 2);
  $('zout').onclick = () => zoomAt(1.4, view[0] + view[2] / 2, view[1] + view[3] / 2);
  $('zreset').onclick = () => { view = HOME.slice(); applyView(); };

  /* ---------- map interaction ---------- */
  const tip = $('tip');
  const mapwrap = $('mapwrap');
  svg.addEventListener('pointermove', (ev) => {
    const el = ev.target.closest ? ev.target.closest('path.c') : null;
    if (!el || drag) { tip.style.opacity = 0; return; }
    const wrap = mapwrap.getBoundingClientRect();
    tip.textContent = el.dataset.name;
    tip.style.left = (ev.clientX - wrap.left) + 'px';
    tip.style.top = (ev.clientY - wrap.top) + 'px';
    tip.style.opacity = 1;
  });
  svg.addEventListener('pointerleave', () => { tip.style.opacity = 0; });
  svg.addEventListener('click', (ev) => {
    if (moved > 4) return;                        // was a drag, not a click
    const el = ev.target.closest('path.c');
    if (!el || !el.classList.contains('playable')) return;
    submit(el.dataset.name);
  });

  /* ---------- game state ---------- */
  let target = null, guesses = [], hintUsed = false, over = false;
  const recent = [];

  function newGame() {
    let pick;
    do { pick = playable[Math.floor(Math.random() * playable.length)]; }
    while (playable.length > recent.length && recent.includes(pick.name));
    recent.push(pick.name);
    if (recent.length > 25) recent.shift();

    target = pick;
    guesses = [];
    hintUsed = false;
    over = false;

    for (const el of paths.values()) {
      el.style.fill = '';
      el.classList.remove('target-win');
    }
    $('winwrap').classList.remove('show');
    $('hintbox').classList.remove('show');
    $('revealed').classList.remove('show');
    $('hintbtn').disabled = false;
    $('hintbtn').textContent = 'Hint — costs 3 guesses';
    $('guess').disabled = false;
    $('guess').value = '';
    $('err').textContent = '';
    $('closest').textContent = '';
    view = HOME.slice(); applyView();
    render();
    $('guess').focus();
  }

  const score = () => guesses.length + (hintUsed ? 3 : 0);

  function submit(raw) {
    if (over) return;
    const key = norm(raw);
    if (!key) return;
    const c = lookup.get(key);
    if (!c) { $('err').textContent = '"' + raw.trim() + '" is not a country in play.'; return; }
    if (guesses.some((g) => g.c === c)) { $('err').textContent = 'You already guessed ' + c.name + '.'; return; }
    $('err').textContent = '';

    const d = countryDistance(c, target);
    guesses.push({ c, d, correct: c === target });
    // The answer is 0 km, but so is any country bordering it, so it's ranked
    // explicitly rather than left to tie-breaking.
    guesses.sort((a, b) => (b.correct - a.correct) || (a.d - b.d));

    paths.get(c.name).style.fill = c === target ? '' : heat(d);
    if (c === target) win();
    render();

    $('guess').value = '';
    closeAc();
  }

  function win() {
    over = true;
    paths.get(target.name).classList.add('target-win');
    $('guess').disabled = true;
    $('hintbtn').disabled = true;
    $('hintbox').classList.remove('show');
    closeAc();
    $('winname').textContent = target.name;
    const n = guesses.length;
    $('winsub').innerHTML = n + ' guess' + (n === 1 ? '' : 'es')
      + (hintUsed ? ' + <b>3</b> hint penalty &middot; score <b>' + score() + '</b>' : ' &middot; score <b>' + score() + '</b>');
    $('winwrap').classList.add('show');
    $('again').focus();
  }

  function render() {
    $('cnt').textContent = score();
    const list = $('list');
    if (!guesses.length) { list.innerHTML = EMPTY_LIST; return; }
    const best = guesses[0];
    $('closest').textContent = best.correct ? 'found'
      : best.d === 0 ? 'bordering!'
      : 'closest ' + fmt(best.d);

    list.innerHTML = guesses.map((g) => {
      const arrow = g.correct ? '★' : arrowFor(bearing(g.c.centroid, target.centroid));
      const cls = g.correct ? 'g correct' : (g.d < 1200 ? 'g hot' : 'g');
      return '<div class="' + cls + '">'
        + '<div class="sw" style="background:' + (g.correct ? 'var(--win)' : heat(g.d)) + '"></div>'
        + '<div class="nm">' + g.c.name + '</div>'
        + '<div class="km">' + (g.correct ? '' : fmt(g.d)) + '</div>'
        + '<div class="ar">' + arrow + '</div>'
        + '</div>';
    }).join('');
  }

  /* ---------- hint ---------- */
  $('hintbtn').onclick = () => { if (!hintUsed && !over) $('hintbox').classList.add('show'); };
  $('hintno').onclick = () => $('hintbox').classList.remove('show');
  $('hintyes').onclick = () => {
    // The confirm box can still be open at the moment a map click wins the game;
    // without this the penalty would land after the answer was already found.
    if (hintUsed || over) { $('hintbox').classList.remove('show'); return; }
    hintUsed = true;
    $('hintbox').classList.remove('show');
    $('hintbtn').disabled = true;
    $('hintbtn').textContent = 'Hint used (+3)';
    $('revealed').innerHTML = 'The country is in <b>' + target.region + '</b>.';
    $('revealed').classList.add('show');
    render();
    $('guess').focus();
  };

  /* ---------- autocomplete ---------- */
  const input = $('guess'), ac = $('ac');
  let acItems = [], acSel = -1;

  function openAc(q) {
    const k = norm(q);
    if (!k) return closeAc();
    const guessed = new Set(guesses.map((g) => g.c.name));
    const starts = [], contains = [];
    for (const c of playable) {
      if (guessed.has(c.name)) continue;
      const n = norm(c.name);
      if (n.startsWith(k) || c.aliases.some((a) => norm(a).startsWith(k))) starts.push(c);
      else if (n.includes(k)) contains.push(c);
    }
    acItems = starts.concat(contains).slice(0, 8);
    if (!acItems.length) return closeAc();
    acSel = 0;
    ac.innerHTML = acItems.map((c, i) => '<div class="' + (i === 0 ? 'sel' : '') + '" data-i="' + i + '">' + c.name + '</div>').join('');
    ac.classList.add('open');
  }
  function closeAc() { ac.classList.remove('open'); acItems = []; acSel = -1; }
  function moveSel(step) {
    if (!acItems.length) return;
    acSel = (acSel + step + acItems.length) % acItems.length;
    [...ac.children].forEach((el, i) => el.classList.toggle('sel', i === acSel));
    ac.children[acSel].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', () => { $('err').textContent = ''; openAc(input.value); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSel(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSel(-1); }
    else if (ev.key === 'Escape') closeAc();
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      submit(acSel >= 0 && acItems.length ? acItems[acSel].name : input.value);
    }
  });
  ac.addEventListener('mousedown', (ev) => {
    const el = ev.target.closest('[data-i]');
    if (el) { ev.preventDefault(); submit(acItems[+el.dataset.i].name); }
  });
  input.addEventListener('blur', () => setTimeout(closeAc, 120));

  header.querySelector('.newgame').onclick = newGame;
  $('again').onclick = newGame;

  newGame();
}

export default { id: 'meridian', title: 'Meridian', init };
