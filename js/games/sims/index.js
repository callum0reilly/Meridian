// The Sims 5 — screens, the isometric renderer, and every impure thing.
//
// Single-player, so no net.js: one rules.js state owned here, stepped 20 times
// a second and drawn as fast as rAF allows. The two clocks follow the house
// convention (see impostor/index.js:484): simulation on a setInterval with an
// accumulator, because rAF stops dead in a background tab — though unlike
// impostor both clocks stop in onHide, because a hidden single-player household
// should be paused, not quietly starving to death behind another tab.
//
// ---- The iso view ----
// Classic 2:1 diamonds, 64×32 logical pixels per tile, drawn with explicit
// world→screen math rather than a ctx transform so the same two functions serve
// drawing AND picking. Painter's algorithm: floors first, then everything else
// tile by tile in ascending x+y (a tile's north and west walls, then its
// objects, then whoever is standing on it), then a HUD overlay pass that is
// never occluded. Camera-side walls of interior rooms draw as stubs so you can
// see into the house — the flood-filled room map in rules.derived decides
// which side of a wall is "inside".
//
// ---- Build undo ----
// Snapshots, not inverse ops: entering a build drag pushes {lot, funds} as
// JSON, undo pops one back and rebuilds derived state. Twenty copies of a
// 24×24 lot is a few hundred KB of short-lived memory, which is a fair price
// for undo that cannot desync from the ops it reverses.

import * as R from './rules.js';
import {
  NEEDS, TRAITS, OBJECTS, CAREERS, SOCIALS, FLOORS, CATS, BUYABLE, SHIRTS,
  objectTiles, rotSize, START_FUNDS, MAX_SIMS, LOT_DOOR,
} from './catalogue.js';
import { load, save, wipe } from './store.js';

const GAME = 'sims';

/* ---- iso geometry (logical px at zoom 1) ---- */
const HW = 32, HH = 16;              // half a tile diamond
const WALL_H = 56;                   // full wall height
const STUB_H = 12;                   // cutaway wall height
const SIM_H = 42;

const AUTOSAVE_DEBOUNCE = 2000;
const TOAST_MS = 5000;

/* ============================== templates ============================== */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TITLE_HTML = `
  <div class="lobby">
    <div class="lobby-card simstitle">
      <div class="biglogo"><span class="plumb"></span>The Sims 5</div>
      <p class="hint">Move a family in. Keep them fed, employed and loved.
      They will do <em>nothing</em> you don't tell them to.</p>
      <div class="titlebtns">
        <button class="primary continue" hidden>Continue</button>
        <div class="continfo hint" hidden></div>
        <button class="newhouse">New Household</button>
      </div>
    </div>
  </div>
`;

const CAS_HTML = `
  <div class="cas">
    <div class="cas-card">
      <h2 class="cas-title">Create a Household</h2>
      <div class="cas-rows"></div>
      <div class="cas-foot">
        <button class="ghost addsim">+ Add a Sim</button>
        <span class="hint">The family starts with §${START_FUNDS.toLocaleString('en-IE')} and an empty lot.</span>
        <button class="primary movein">Move In</button>
      </div>
      <div class="err cas-err" hidden></div>
    </div>
  </div>
`;

const GAME_HTML = `
  <div class="world">
    <canvas class="view"></canvas>
    <div class="toasts"></div>
    <div class="ctxmenu" hidden></div>
    <div class="buildpanel" hidden>
      <div class="bp-tools">
        <button data-tool="buy" class="tool">Buy</button>
        <button data-tool="wall" class="tool">Wall</button>
        <button data-tool="door" class="tool">Door</button>
        <button data-tool="window" class="tool">Window</button>
        <button data-tool="floor" class="tool">Floor</button>
        <button data-tool="move" class="tool">Move</button>
        <button data-tool="sell" class="tool">Sell</button>
        <button class="undo ghost">Undo</button>
        <button class="exitbuild primary">Done</button>
      </div>
      <div class="bp-body">
        <div class="bp-cat"></div>
        <div class="bp-floors" hidden></div>
        <div class="bp-hint hint"></div>
      </div>
    </div>
    <div class="bottombar">
      <div class="portraits"></div>
      <div class="bb-mid">
        <div class="simhead"><span class="simname"></span><span class="simjob hint"></span></div>
        <div class="needsgrid"></div>
        <div class="queue"></div>
      </div>
      <div class="bb-right">
        <div class="funds"></div>
        <button class="paybills" hidden></button>
        <div class="clock"></div>
        <div class="speeds">
          <button data-sp="0" title="Pause (\`)">⏸</button><button data-sp="1" title="Normal (1)">1×</button><button data-sp="3" title="Fast (2)">3×</button><button data-sp="10" title="Blistering (3)">10×</button>
        </div>
        <div class="bb-btns">
          <button class="buildbtn">Build</button>
          <button class="wallsbtn ghost" title="Toggle wall height">Walls</button>
        </div>
      </div>
    </div>
  </div>
  <div class="modal" hidden></div>
`;

const GRAVE_HTML = `
  <div class="lobby">
    <div class="lobby-card grave">
      <h2 class="grave-title">The household has passed on</h2>
      <ul class="grave-list"></ul>
      <p class="grave-sum hint"></p>
      <button class="primary refound">Found a New Household</button>
      <p class="hint">The house, the furniture and the urns stay. The town remembers nothing.</p>
    </div>
  </div>
`;

/* ============================== module ============================== */

function init(root, header) {
  let game = null;                   // the one rules.js state
  let shown = false;
  let refounding = false;            // CAS is re-housing the same lot

  let simTimer = null;
  let raf = null;
  let acc = 0, lastTick = 0;
  const MAX_CATCHUP = 3;

  let selectedId = null;
  let cam = { x: 0, y: 0, zoom: 1 };
  let wallsUp = false;
  let hitList = [];                  // rebuilt every frame, walked on click

  // build mode
  let tool = 'buy';
  let buyDef = null, buyRot = 0;
  let moveState = null;              // { id, rot }
  let hover = null;                  // world float coords under the pointer
  let undoStack = [];
  let prevSpeed = 1;

  let saveTimer = null;
  let saveFailWarned = false;
  let hudCounter = 0;

  const el = (sel) => root.querySelector('.' + sel);

  header.innerHTML = '<div class="tag simstag">no free will</div>' +
                     '<button class="tomenu ghost" hidden>Main menu</button>';
  const menuBtn = header.querySelector('.tomenu');
  menuBtn.onclick = () => { autosaveNow(); showTitle(); };

  /* ============================ screens ============================ */

  function showTitle() {
    stopClocks();
    game = null;
    menuBtn.hidden = true;
    root.innerHTML = TITLE_HTML;
    const saved = load();
    if (saved) {
      const cont = el('continue');
      cont.hidden = false;
      const info = el('continfo');
      info.hidden = false;
      info.textContent = `Day ${saved.time.day} · §${Math.round(saved.funds).toLocaleString('en-IE')} · ` +
        (saved.sims.map((s) => s.name).join(', ') || 'nobody home');
      cont.onclick = () => { game = saved; enterGame(); };
    }
    el('newhouse').onclick = () => {
      if (saved) {
        confirmModal('Start over? The saved household will be lost forever.', () => {
          wipe(); refounding = false; showCAS();
        });
      } else {
        refounding = false; showCAS();
      }
    };
  }

  // The title card has no modal element, so confirmation borrows the pattern
  // with a transient one.
  function confirmModal(msg, onYes) {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="modal-card"><p>${esc(msg)}</p>
      <div class="row"><button class="primary yes">Do it</button><button class="ghost no">Cancel</button></div></div>`;
    root.appendChild(m);
    m.querySelector('.yes').onclick = () => { m.remove(); onYes(); };
    m.querySelector('.no').onclick = () => m.remove();
  }

  /* ---- create-a-sim ---- */

  function showCAS() {
    stopClocks();
    menuBtn.hidden = true;
    root.innerHTML = CAS_HTML;
    const rows = el('cas-rows');
    const addRow = () => {
      if (rows.children.length >= MAX_SIMS) return;
      const i = rows.children.length;
      const row = document.createElement('div');
      row.className = 'cas-row';
      row.innerHTML = `
        <canvas class="cas-prev" width="56" height="84"></canvas>
        <input class="cas-name" maxlength="12" placeholder="Name" value="">
        <div class="cas-swatches">${SHIRTS.map((c, j) =>
          `<button class="sw${j === i % SHIRTS.length ? ' on' : ''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>
        <select class="cas-t1">${TRAITS.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join('')}</select>
        <select class="cas-t2">${TRAITS.map((t, j) => `<option value="${t.id}"${j === 1 ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
        <select class="cas-career">${Object.entries(CAREERS).map(([id, c]) => `<option value="${id}">${esc(c.label)}</option>`).join('')}</select>
        <button class="ghost cas-del" title="Remove">✕</button>`;
      rows.appendChild(row);
      const prev = row.querySelector('.cas-prev');
      const paint = () => paintPreview(prev, row.querySelector('.sw.on')?.dataset.c || SHIRTS[0]);
      row.querySelectorAll('.sw').forEach((b) => b.onclick = () => {
        row.querySelectorAll('.sw').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        paint();
      });
      row.querySelector('.cas-del').onclick = () => { if (rows.children.length > 1) row.remove(); };
      paint();
    };
    addRow();
    el('addsim').onclick = addRow;
    el('movein').onclick = () => {
      const specs = [...rows.children].map((row) => ({
        name: row.querySelector('.cas-name').value.trim(),
        shirt: row.querySelector('.sw.on')?.dataset.c || SHIRTS[0],
        traits: [row.querySelector('.cas-t1').value, row.querySelector('.cas-t2').value]
          .filter((v, i, a) => a.indexOf(v) === i),
        career: row.querySelector('.cas-career').value,
      }));
      if (specs.some((s) => !s.name)) {
        const err = el('cas-err');
        err.hidden = false;
        err.textContent = 'Everyone needs a name.';
        return;
      }
      if (refounding && game) {
        R.refound(game, specs);
      } else {
        game = R.createState(specs, { seed: (Math.random() * 2 ** 31) | 0 });
      }
      autosaveNow();
      enterGame();
    };
  }

  function paintPreview(canvas, shirt) {
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, canvas.width, canvas.height);
    drawCapsule(c, canvas.width / 2, canvas.height - 6, 1.6, shirt, { preview: true });
  }

  /* ---- the graveyard ---- */

  function showGrave() {
    stopClocks();
    menuBtn.hidden = true;
    root.innerHTML = GRAVE_HTML;
    const list = el('grave-list');
    list.innerHTML = game.deadLog.map((d) =>
      `<li><b>${esc(d.name)}</b> — day ${d.day}, ${esc(d.cause)}</li>`).join('') || '<li>Nobody, somehow.</li>';
    el('grave-sum').textContent =
      `${game.time.day} days on the lot · §${Math.round(game.funds).toLocaleString('en-IE')} left behind`;
    el('refound').onclick = () => { refounding = true; showCAS(); };
  }

  /* ============================ the game screen ============================ */

  let canvas, ctx, resizeObs;

  function enterGame() {
    refounding = false;
    menuBtn.hidden = false;
    root.innerHTML = GAME_HTML;
    canvas = el('view');
    ctx = canvas.getContext('2d');
    selectedId = game.sims[0]?.id || null;
    wallsUp = false;
    undoStack = [];
    tool = 'buy'; buyDef = null; moveState = null;

    resizeObs?.disconnect();
    resizeObs = new ResizeObserver(fitCanvas);
    resizeObs.observe(el('world'));
    fitCanvas();
    fitCamera();

    bindGameUI();
    bindPointer();
    buildHud();
    if (shown) startClocks();
  }

  function fitCanvas() {
    if (!canvas) return;
    const box = el('world').getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    canvas.style.width = box.width + 'px';
    canvas.style.height = box.height + 'px';
    canvas._dpr = dpr;
    canvas._w = box.width;
    canvas._h = box.height;
  }

  function fitCamera() {
    const spanX = (R.LOT_W + R.LOT_H) * HW;
    const spanY = (R.LOT_W + R.LOT_H) * HH + WALL_H;
    cam.zoom = clampNum(Math.min(canvas._w / (spanX + 80), (canvas._h - 120) / (spanY + 60)), 0.4, 2);
    // World centre corner (w/2, h/2) lands mid-canvas, a little high of centre
    // to leave room for the bottom bar.
    cam.x = canvas._w / 2;
    cam.y = (canvas._h - 110) / 2 - (R.LOT_W / 2 + R.LOT_H / 2) * HH * cam.zoom;
  }

  const w2sx = (x, y) => (x - y) * HW * cam.zoom + cam.x;
  const w2sy = (x, y) => (x + y) * HH * cam.zoom + cam.y;
  function s2w(px, py) {
    const a = (px - cam.x) / (HW * cam.zoom);
    const b = (py - cam.y) / (HH * cam.zoom);
    return { x: (a + b) / 2, y: (b - a) / 2 };
  }

  /* ============================ clocks ============================ */

  function startClocks() {
    if (!game || !canvas) return;
    if (simTimer === null) {
      lastTick = performance.now();
      acc = 0;
      simTimer = setInterval(() => {
        const now = performance.now();
        acc += now - lastTick;
        lastTick = now;
        let n = 0;
        while (acc >= R.TICK_MS && n < MAX_CATCHUP) {
          acc -= R.TICK_MS;
          n++;
          if (game && game.mode === 'live') handleEvents(R.step(game).events);
        }
        if (acc >= R.TICK_MS) acc = 0;   // throttled tab: drop the backlog, don't sprint
        if (++hudCounter % 5 === 0) updateHud();
      }, R.TICK_MS);
    }
    if (raf === null) {
      const frame = () => { raf = requestAnimationFrame(frame); drawFrame(); };
      raf = requestAnimationFrame(frame);
    }
  }

  function stopClocks() {
    if (simTimer !== null) { clearInterval(simTimer); simTimer = null; }
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
  }

  function handleEvents(events) {
    for (const ev of events) {
      switch (ev.t) {
        case 'toast': toast(ev.msg); break;
        case 'doorbell': toast(`🔔 ${ev.name} is at the door.`); break;
        case 'starving': toast(`⚠️ ${nameOf(ev.simId)} is STARVING. Six hours to live.`, 'bad'); break;
        case 'bill': toast(`📬 Bills: §${ev.due}. Two days to pay.`); autosaveSoon(); break;
        case 'repossess': toast(`The repo man took the ${ev.label.toLowerCase()}.`, 'bad'); break;
        case 'fire': toast(`🔥 ${ev.msg}`, 'bad'); break;
        case 'promotion': toast(`⭐ ${ev.name} was promoted to ${ev.title}!`); autosaveSoon(); break;
        case 'demotion': toast(`${ev.name} was demoted to ${ev.title}.`, 'bad'); break;
        case 'death':
          toast(`💀 ${ev.name} has died (${ev.cause}).`, 'bad');
          if (selectedId && !R.simById(game, selectedId)) selectedId = game.sims[0]?.id || null;
          autosaveSoon();
          break;
        case 'hourly': autosaveSoon(); break;
        case 'gameover': autosaveNow(); showGrave(); return;
      }
    }
  }

  const nameOf = (id) => R.simById(game, id)?.name || 'Someone';

  /* ============================ saving ============================ */

  function autosaveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; autosaveNow(); }, AUTOSAVE_DEBOUNCE);
  }

  function autosaveNow() {
    if (!game) return;
    const res = save(game);
    if (!res.ok && !saveFailWarned) {
      saveFailWarned = true;
      toast(res.message, 'bad');
    }
  }

  /* ============================ HUD ============================ */

  function bindGameUI() {
    root.querySelectorAll('.speeds button').forEach((b) => {
      b.onclick = () => setSpeed(Number(b.dataset.sp));
    });
    el('buildbtn').onclick = toggleBuild;
    el('wallsbtn').onclick = () => { wallsUp = !wallsUp; };
    el('paybills').onclick = () => {
      const res = R.payBills(game);
      if (!res.ok) toast(res.msg, 'bad'); else { toast('Bills paid.'); autosaveSoon(); }
      updateHud();
    };
    el('exitbuild').onclick = toggleBuild;
    el('undo').onclick = popUndo;
    root.querySelectorAll('.bp-tools .tool').forEach((b) => {
      b.onclick = () => { setTool(b.dataset.tool); };
    });
  }

  function setSpeed(sp) {
    if (!game || game.mode !== 'live') return;
    game.time.speed = sp;
    updateHud();
  }

  function buildHud() {
    const grid = el('needsgrid');
    grid.innerHTML = [...NEEDS.map((n) => n.id), 'room'].map((id) =>
      `<div class="need"><span class="nlabel">${id === 'room' ? 'Room' : esc(NEEDS.find((n) => n.id === id).label)}</span>
       <div class="nbar"><div class="nfill" data-need="${id}"></div></div></div>`).join('');
    updateHud();
  }

  function updateHud() {
    if (!game || !canvas) return;
    const bar = el('bottombar');
    if (!bar) return;

    // portraits
    const ps = el('portraits');
    const want = game.sims.map((s) => s.id).join(',');
    if (ps.dataset.for !== want) {
      ps.dataset.for = want;
      ps.innerHTML = game.sims.map((s) =>
        `<button class="portrait" data-id="${s.id}" style="--shirt:${s.shirt}" title="${esc(s.name)}">
           <span class="pface"></span><span class="pname">${esc(s.name[0] || '?')}</span></button>`).join('');
      ps.querySelectorAll('.portrait').forEach((b) => {
        b.onclick = () => { selectedId = b.dataset.id; updateHud(); };
        b.ondblclick = () => {
          const s = R.simById(game, b.dataset.id);
          if (s && !s.atWork) { cam.x += canvas._w / 2 - w2sx(s.pos.x, s.pos.y); cam.y += canvas._h / 2 - w2sy(s.pos.x, s.pos.y); }
        };
      });
    }
    ps.querySelectorAll('.portrait').forEach((b) => {
      const s = R.simById(game, b.dataset.id);
      if (!s) return;
      b.classList.toggle('on', b.dataset.id === selectedId);
      b.classList.toggle('away', !!s.atWork);
      b.classList.toggle('danger', s.starveDeadline != null || !!s.dying);
      const m = R.mood(game, s);
      b.style.setProperty('--mood', moodColor(m));
    });

    const sim = selectedId ? R.simById(game, selectedId) : null;
    el('simname').textContent = sim ? sim.name : '';
    if (sim) {
      const c = CAREERS[sim.job.career];
      const lvl = c.levels[sim.job.level - 1];
      el('simjob').textContent =
        ` · ${lvl.title} (${c.label}) · Cook ${sim.skills.cooking.toFixed(1)} · Cha ${sim.skills.charisma.toFixed(1)} · Fit ${sim.skills.fitness.toFixed(1)}` +
        (sim.atWork ? ' · at work' : '');
    } else {
      el('simjob').textContent = '';
    }

    root.querySelectorAll('.nfill').forEach((f) => {
      const id = f.dataset.need;
      const v = !sim ? 0 : id === 'room' ? R.roomScoreAt(game, sim.pos.x, sim.pos.y) : sim.needs[id];
      f.style.width = v + '%';
      f.style.background = moodColor(v);
    });

    // queue chips
    const q = el('queue');
    q.innerHTML = !sim ? '' : sim.queue.map((a) =>
      `<span class="chip${a.state === 'running' ? ' running' : ''}">${esc(actionLabel(a))}<button data-aid="${a.aid}">✕</button></span>`).join('');
    q.querySelectorAll('button').forEach((b) => {
      b.onclick = () => { R.cancelAction(game, selectedId, Number(b.dataset.aid)); updateHud(); };
    });

    el('funds').textContent = `§${Math.round(game.funds).toLocaleString('en-IE')}`;
    const pb = el('paybills');
    pb.hidden = game.bills.due <= 0;
    if (game.bills.due > 0) pb.textContent = `Pay Bills §${game.bills.due}`;
    const min = Math.floor(game.time.minute);
    el('clock').textContent = `Day ${game.time.day} · ${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    root.querySelectorAll('.speeds button').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.sp) === game.time.speed && game.mode === 'live');
    });
  }

  function actionLabel(a) {
    if (a.kind === 'go') return 'Go here';
    if (a.kind === 'work') return 'Go to work';
    if (a.kind === 'extinguish') return 'Extinguish';
    if (a.kind === 'social') return `${SOCIALS.find((s) => s.id === a.def)?.label || a.def}: ${nameOf(a.targetId)}`;
    const obj = R.objectById(game, a.objectId);
    const ia = obj && OBJECTS[obj.def].interactions.find((i) => i.id === a.def);
    return ia ? ia.label : '…';
  }

  const moodColor = (v) => v > 66 ? 'var(--win, #30a46c)' : v > 33 ? '#ffc53d' : 'var(--danger, #e5484d)';

  function toast(msg, cls = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + cls;
    t.textContent = msg;
    el('toasts')?.appendChild(t);
    setTimeout(() => t.remove(), TOAST_MS);
  }

  /* ============================ build mode ============================ */

  function toggleBuild() {
    if (!game) return;
    closeMenu();
    if (game.mode === 'live') {
      prevSpeed = game.time.speed || 1;
      game.mode = 'build';
      game.time.speed = 0;
      el('buildpanel').hidden = false;
      setTool('buy');
    } else {
      game.mode = 'live';
      game.time.speed = prevSpeed;
      el('buildpanel').hidden = true;
      buyDef = null; moveState = null;
      R.repathMovers(game);
      autosaveNow();
    }
    updateHud();
  }

  function setTool(t) {
    tool = t;
    moveState = null;
    root.querySelectorAll('.bp-tools .tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    el('bp-cat').hidden = t !== 'buy';
    el('bp-floors').hidden = t !== 'floor';
    if (t === 'buy') fillCatalogue();
    if (t === 'floor') fillFloors();
    el('bp-hint').textContent = {
      buy: 'Pick something, then click the lot. R rotates. Esc puts it away.',
      wall: 'Drag along tile edges to build walls, §14 each.',
      door: 'Click a wall to fit a door, §60.',
      window: 'Click a wall to fit a window, §40.',
      floor: 'Pick a finish, then click or drag over tiles, §6 each.',
      move: 'Click a thing to pick it up, click again to put it down.',
      sell: 'Click a thing to sell it back at 75%.',
    }[t] || '';
  }

  function fillCatalogue() {
    const cat = el('bp-cat');
    if (cat.dataset.filled) return;
    cat.dataset.filled = '1';
    cat.innerHTML = CATS.map((c) =>
      `<div class="bp-cathead">${esc(c)}</div><div class="bp-grid">${BUYABLE.filter((k) => OBJECTS[k].cat === c).map((k) =>
        `<button class="bp-item" data-def="${k}"><canvas width="64" height="52"></canvas>
          <span>${esc(OBJECTS[k].label)}</span><span class="hint">§${OBJECTS[k].price}</span></button>`).join('')}</div>`).join('');
    cat.querySelectorAll('.bp-item').forEach((b) => {
      const def = b.dataset.def;
      paintThumb(b.querySelector('canvas'), def);
      b.onclick = () => {
        buyDef = def; buyRot = 0;
        cat.querySelectorAll('.bp-item').forEach((x) => x.classList.toggle('on', x === b));
      };
    });
  }

  function paintThumb(cv, def) {
    const c = cv.getContext('2d');
    const o = OBJECTS[def];
    const scale = Math.min(1, 2.2 / (o.w + o.d));
    c.save();
    c.translate(cv.width / 2, cv.height - 12 - o.h * 0.3 * scale);
    c.scale(scale * 0.55, scale * 0.55);
    drawIsoBoxRaw(c, 0, 0, o.w, o.d, o.h, o.color, 1);
    c.restore();
  }

  function fillFloors() {
    const fl = el('bp-floors');
    if (fl.dataset.filled) return;
    fl.dataset.filled = '1';
    fl.innerHTML = FLOORS.filter((f) => f.id !== 0).map((f) =>
      `<button class="bp-floor" data-f="${f.id}"><span style="background:${f.color}"></span>${esc(f.label)}</button>`).join('');
    fl.querySelectorAll('.bp-floor').forEach((b, i) => {
      if (i === 0) { b.classList.add('on'); floorId = Number(b.dataset.f); }
      b.onclick = () => {
        floorId = Number(b.dataset.f);
        fl.querySelectorAll('.bp-floor').forEach((x) => x.classList.toggle('on', x === b));
      };
    });
  }
  let floorId = 1;

  function pushUndo() {
    undoStack.push(JSON.stringify({ lot: R.serialize(game).lot, funds: game.funds }));
    if (undoStack.length > 20) undoStack.shift();
  }

  function popUndo() {
    const snap = undoStack.pop();
    if (!snap) return;
    const { lot, funds } = JSON.parse(snap);
    game.lot = lot;
    game.funds = funds;
    R.rebuildDerived(game);
    updateHud();
  }

  /* ---- edge picking ---- */

  // Which tile edge is the pointer nearest? N edges run along whole-number y,
  // W edges along whole-number x; whichever fraction is closer wins.
  function pickEdge(wx, wy) {
    const fy = Math.abs(wy - Math.round(wy));
    const fx = Math.abs(wx - Math.round(wx));
    if (fy <= fx) {
      const x = Math.floor(wx), y = Math.round(wy);
      if (x >= 0 && x < R.LOT_W && y >= 0 && y <= R.LOT_H) return { side: 'N', x, y };
    } else {
      const x = Math.round(wx), y = Math.floor(wy);
      if (x >= 0 && x <= R.LOT_W && y >= 0 && y < R.LOT_H) return { side: 'W', x, y };
    }
    return null;
  }

  /* ============================ pointer ============================ */

  function bindPointer() {
    let down = null;                 // { px, py, camx, camy, panned, dragTool }
    canvas.onpointerdown = (e) => {
      canvas.setPointerCapture(e.pointerId);
      const p = ptr(e);
      down = { ...p, camx: cam.x, camy: cam.y, panned: false, dragTool: null };
      closeMenu();
      // Build drags snapshot once, up front, so one undo undoes one gesture.
      if (game.mode === 'build' && (tool === 'wall' || tool === 'floor')) {
        down.dragTool = tool;
        pushUndo();
        applyBuildAt(p.px, p.py, true);
      }
    };
    canvas.onpointermove = (e) => {
      const p = ptr(e);
      hover = s2w(p.px, p.py);
      if (!down) return;
      if (down.dragTool) { applyBuildAt(p.px, p.py, false); return; }
      const dx = p.px - down.px, dy = p.py - down.py;
      if (down.panned || Math.hypot(dx, dy) > 5) {
        down.panned = true;
        cam.x = down.camx + dx;
        cam.y = down.camy + dy;
      }
    };
    canvas.onpointerup = (e) => {
      const p = ptr(e);
      const wasPan = down?.panned;
      const wasDrag = !!down?.dragTool;
      down = null;
      if (wasPan || wasDrag) return;
      onClick(p.px, p.py, e);
    };
    canvas.onwheel = (e) => {
      e.preventDefault();
      const p = ptr(e);
      const before = s2w(p.px, p.py);
      cam.zoom = clampNum(cam.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.4, 2.5);
      // Zoom toward the cursor: keep the world point under it fixed.
      cam.x = p.px - (before.x - before.y) * HW * cam.zoom;
      cam.y = p.py - (before.x + before.y) * HH * cam.zoom;
    };
  }

  function ptr(e) {
    const box = canvas.getBoundingClientRect();
    return { px: e.clientX - box.left, py: e.clientY - box.top };
  }

  function onKey(e) {
    if (!shown || !game || !canvas) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === '`') setSpeed(0);
    else if (e.key === '1') setSpeed(1);
    else if (e.key === '2') setSpeed(3);
    else if (e.key === '3') setSpeed(10);
    else if (e.key === 'b' || e.key === 'B') toggleBuild();
    else if (e.key === 'r' || e.key === 'R') {
      if (moveState) moveState.rot = (moveState.rot + 1) & 3;
      else buyRot = (buyRot + 1) & 3;
    } else if (e.key === 'Escape') {
      closeMenu();
      buyDef = null;
      moveState = null;
      root.querySelectorAll('.bp-item').forEach((x) => x.classList.remove('on'));
    } else if (e.key === 'z' && (e.ctrlKey || e.metaKey) && game.mode === 'build') {
      e.preventDefault();
      popUndo();
    }
  }

  function applyBuildAt(px, py, first) {
    const w = s2w(px, py);
    if (tool === 'wall') {
      const edge = pickEdge(w.x, w.y);
      if (edge) {
        const res = R.setEdge(game, edge.side, edge.x, edge.y, 1);
        if (!res.ok && first && res.msg) toast(res.msg, 'bad');
      }
    } else if (tool === 'floor') {
      const x = Math.floor(w.x), y = Math.floor(w.y);
      R.paintFloor(game, x, y, floorId);
    }
    updateHud();
  }

  /* ---- clicking ---- */

  function onClick(px, py, e) {
    if (!game) return;
    if (game.mode === 'build') return onBuildClick(px, py);

    // Walk the frame's draw list back to front; the topmost thing wins.
    for (let i = hitList.length - 1; i >= 0; i--) {
      const h = hitList[i];
      if (px < h.x0 - 4 || px > h.x1 + 4 || py < h.y0 - 4 || py > h.y1 + 4) continue;
      if (h.kind === 'sim') {
        if (game.sims.some((s) => s.id === h.id)) { selectedId = h.id; updateHud(); }
        else openSocialMenu(px, py, h.id);      // a townie
        return;
      }
      if (h.kind === 'object') { openObjectMenu(px, py, h.id); return; }
    }
    // Ground.
    const w = s2w(px, py);
    const x = Math.floor(w.x), y = Math.floor(w.y);
    if (x < 0 || y < 0 || x >= R.LOT_W || y >= R.LOT_H) { closeMenu(); return; }
    openGroundMenu(px, py, x, y);
  }

  function onBuildClick(px, py) {
    const w = s2w(px, py);
    const x = Math.floor(w.x), y = Math.floor(w.y);
    if (tool === 'buy' && buyDef) {
      pushUndo();
      const res = R.placeObject(game, buyDef, x, y, buyRot);
      if (!res.ok) { undoStack.pop(); if (res.msg) toast(res.msg, 'bad'); }
      updateHud();
      return;
    }
    if (tool === 'door' || tool === 'window') {
      const edge = pickEdge(w.x, w.y);
      if (edge) {
        pushUndo();
        const res = R.setEdge(game, edge.side, edge.x, edge.y, tool === 'door' ? 2 : 3);
        if (!res.ok) { undoStack.pop(); if (res.msg) toast(res.msg, 'bad'); }
      }
      updateHud();
      return;
    }
    if (tool === 'move' || tool === 'sell') {
      if (moveState && tool === 'move') {
        pushUndo();
        const res = R.moveObject(game, moveState.id, x, y, moveState.rot);
        if (!res.ok) { undoStack.pop(); if (res.msg) toast(res.msg, 'bad'); return; }
        moveState = null;
        updateHud();
        return;
      }
      for (let i = hitList.length - 1; i >= 0; i--) {
        const h = hitList[i];
        if (h.kind !== 'object') continue;
        if (px < h.x0 || px > h.x1 || py < h.y0 || py > h.y1) continue;
        if (tool === 'move') {
          const obj = R.objectById(game, h.id);
          if (obj) moveState = { id: obj.id, rot: obj.rot };
        } else {
          pushUndo();
          const res = R.sellObject(game, h.id);
          if (!res.ok) { undoStack.pop(); toast(res.msg, 'bad'); }
          else toast(`Sold for §${res.refund}.`);
        }
        updateHud();
        return;
      }
    }
    if (tool === 'wall') {
      // Right-click-free bulldoze: clicking an existing wall with the wall
      // tool removes it (drags build; taps toggle).
      const edge = pickEdge(w.x, w.y);
      if (edge) {
        const arr = edge.side === 'N' ? game.lot.wallsN : game.lot.wallsW;
        if (arr[edge.y]?.[edge.x] > 0) { pushUndo(); R.setEdge(game, edge.side, edge.x, edge.y, 0); updateHud(); }
      }
    }
  }

  /* ---- context menus ---- */

  function menuEl() { return el('ctxmenu'); }
  function closeMenu() { const m = menuEl(); if (m) m.hidden = true; }

  function openMenu(px, py, rows) {
    const m = menuEl();
    if (!rows.length) { m.hidden = true; return; }
    m.innerHTML = rows.map((r, i) =>
      `<button class="mrow" data-i="${i}" ${r.disabled ? 'disabled' : ''}>
         <span>${esc(r.label)}</span>${r.sub ? `<span class="hint">${esc(r.sub)}</span>` : ''}</button>`).join('');
    m.hidden = false;
    const mw = Math.min(240, canvas._w - 12);
    m.style.left = Math.min(px, canvas._w - mw - 8) + 'px';
    m.style.top = Math.min(py, canvas._h - rows.length * 34 - 60) + 'px';
    m.querySelectorAll('.mrow').forEach((b) => {
      b.onclick = () => { closeMenu(); rows[Number(b.dataset.i)].run?.(); };
    });
  }

  const selectedSim = () => (selectedId ? game.sims.find((s) => s.id === selectedId) : null);

  function openObjectMenu(px, py, objectId) {
    const sim = selectedSim();
    const obj = R.objectById(game, objectId);
    if (!obj) return;
    if (!sim || sim.atWork) { closeMenu(); return; }
    const rows = R.availableInteractions(game, obj).map((ia) => ({
      label: ia.label,
      sub: `~${ia.minutes}m`,
      run: () => {
        const res = R.queueObjectAction(game, sim.id, obj.id, ia.id);
        if (!res.ok) toast(res.msg, 'bad');
        updateHud();
      },
    }));
    // The self-serve extras.
    const missing = OBJECTS[obj.def].interactions.filter((ia) =>
      ia.requires?.object && !game.lot.objects.some((o) => o.def === ia.requires.object));
    for (const ia of missing) {
      rows.push({ label: ia.label, sub: `needs a ${OBJECTS[ia.requires.object].label.toLowerCase()}`, disabled: true });
    }
    openMenu(px, py, rows);
  }

  function openSocialMenu(px, py, targetId) {
    const sim = selectedSim();
    const target = R.simById(game, targetId);
    if (!sim || !target || sim.id === targetId || sim.atWork) { closeMenu(); return; }
    const rows = R.availableSocials(sim, target).map((g) => ({
      label: g.social.label,
      sub: g.ok ? `~${g.social.minutes}m` : g.why,
      disabled: !g.ok,
      run: () => {
        const res = R.queueSocial(game, sim.id, targetId, g.social.id);
        if (!res.ok) toast(res.msg, 'bad');
        updateHud();
      },
    }));
    openMenu(px, py, rows);
  }

  function openGroundMenu(px, py, x, y) {
    const sim = selectedSim();
    if (!sim || sim.atWork) { closeMenu(); return; }
    const rows = [{
      label: 'Go here',
      run: () => { R.queueGo(game, sim.id, x, y); updateHud(); },
    }];
    if (R.canGoToWork(game, sim)) {
      const c = CAREERS[sim.job.career];
      rows.push({
        label: 'Go to work',
        sub: `${c.label}, ${c.start}:00–${c.end}:00`,
        run: () => { R.queueGoToWork(game, sim.id); updateHud(); },
      });
    }
    if (game.fires.length) {
      const f = game.fires[0];
      rows.push({
        label: 'Extinguish fire',
        run: () => { R.queueExtinguish(game, sim.id, f.x, f.y); updateHud(); },
      });
    }
    openMenu(px, py, rows);
  }

  /* ============================ rendering ============================ */

  function drawFrame() {
    if (!game || !canvas) return;
    const dpr = canvas._dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas._w, canvas._h);
    hitList = [];

    drawFloors();
    drawWorld();
    drawNight();
    drawOverlay();
  }

  function drawFloors() {
    const { w, h } = game.lot;
    const build = game.mode === 'build';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const f = FLOORS[game.lot.floor[y][x]] || FLOORS[0];
        diamond(x, y);
        ctx.fillStyle = f.id === 0 ? ((x + y) % 2 ? '#5d8a4a' : '#618f4e') : f.color;
        ctx.fill();
        if (build) { ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 1; ctx.stroke(); }
      }
    }
    // Build-mode ghosts live on the floor layer, under the furniture.
    if (build && hover) drawBuildGhost();
  }

  function diamond(x, y) {
    ctx.beginPath();
    ctx.moveTo(w2sx(x, y), w2sy(x, y));
    ctx.lineTo(w2sx(x + 1, y), w2sy(x + 1, y));
    ctx.lineTo(w2sx(x + 1, y + 1), w2sy(x + 1, y + 1));
    ctx.lineTo(w2sx(x, y + 1), w2sy(x, y + 1));
    ctx.closePath();
  }

  function drawBuildGhost() {
    const x = Math.floor(hover.x), y = Math.floor(hover.y);
    if (tool === 'buy' && buyDef) {
      const ok = R.canPlace(game, buyDef, x, y, buyRot);
      ghostFootprint(buyDef, x, y, buyRot, ok);
    } else if (tool === 'move' && moveState) {
      const obj = R.objectById(game, moveState.id);
      if (obj) ghostFootprint(obj.def, x, y, moveState.rot, R.canPlace(game, obj.def, x, y, moveState.rot, obj.id));
    } else if (tool === 'wall' || tool === 'door' || tool === 'window') {
      const edge = pickEdge(hover.x, hover.y);
      if (edge) {
        const [x1, y1, x2, y2] = edge.side === 'N'
          ? [edge.x, edge.y, edge.x + 1, edge.y] : [edge.x, edge.y, edge.x, edge.y + 1];
        ctx.strokeStyle = '#ffc53d';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(w2sx(x1, y1), w2sy(x1, y1));
        ctx.lineTo(w2sx(x2, y2), w2sy(x2, y2));
        ctx.stroke();
      }
    } else if (tool === 'floor') {
      if (x >= 0 && y >= 0 && x < R.LOT_W && y < R.LOT_H) {
        diamond(x, y);
        ctx.fillStyle = 'rgba(255,255,255,.25)';
        ctx.fill();
      }
    }
  }

  function ghostFootprint(def, x, y, rot, ok) {
    const { w, d } = rotSize(def, rot);
    for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < d; dy++) {
      diamond(x + dx, y + dy);
      ctx.fillStyle = ok ? 'rgba(48,164,108,.4)' : 'rgba(229,72,77,.4)';
      ctx.fill();
    }
  }

  // One pass in ascending x+y. Per tile: its north wall, its west wall, any
  // object anchored here (anchor = the footprint tile with the greatest x+y,
  // so the box draws after everything it stands in front of), then bodies.
  function drawWorld() {
    const { w, h } = game.lot;
    const z = cam.zoom;

    // Anchor map, rebuilt per frame — cheap at ~30 objects.
    const anchors = new Map();
    for (const obj of game.lot.objects) {
      const tiles = objectTiles(obj);
      let best = tiles[0], bs = -1;
      for (const t of tiles) if (t[0] + t[1] > bs) { bs = t[0] + t[1]; best = t; }
      const key = best[0] + ',' + best[1];
      (anchors.get(key) || anchors.set(key, []).get(key)).push(obj);
    }
    const bodies = [...game.sims.filter((s) => !s.atWork), ...game.townies.filter((t) => t.present)];
    const ghosts = game.ghosts.filter((g) => g.active && g.pos);

    for (let s = 0; s <= w + h - 2; s++) {
      for (let x = Math.max(0, s - h + 1); x <= Math.min(w - 1, s); x++) {
        const y = s - x;
        drawEdge('N', x, y, game.lot.wallsN[y][x]);
        drawEdge('W', x, y, game.lot.wallsW[y][x]);
        const list = anchors.get(x + ',' + y);
        if (list) for (const obj of list) drawObject(obj);
        for (const f of game.fires) if (f.x === x && f.y === y) drawFire(x, y);
        for (const b of bodies) {
          if (Math.floor(b.pos.x) === x && Math.floor(b.pos.y) === y) drawBody(b);
        }
        for (const g of ghosts) {
          if (Math.floor(g.pos.x) === x && Math.floor(g.pos.y) === y) drawGhost(g);
        }
      }
    }
    // The lot's far-south and far-east border walls belong to no tile above.
    for (let x = 0; x < w; x++) drawEdge('N', x, h, game.lot.wallsN[h][x]);
    for (let y = 0; y < h; y++) drawEdge('W', w, y, game.lot.wallsW[y][w]);
  }

  // A wall segment along an edge, full height or cutaway stub. On screen a
  // wall rises upward and overlaps the tile BEHIND it (lower x+y): (x,y−1)
  // for a north edge, (x−1,y) for a west edge. When that tile is interior the
  // wall would hide the room, so it drops to a stub — unless the player has
  // forced walls up for a screenshot.
  function drawEdge(side, x, y, val) {
    if (!val) return;
    const z = cam.zoom;
    const roomId = game.derived.roomId;
    const behind = side === 'N' ? roomId[y - 1]?.[x] : roomId[y]?.[x - 1];
    const cut = !wallsUp && (behind ?? 0) > 0;
    const hpx = (cut ? STUB_H : WALL_H) * z;

    const [x2, y2] = side === 'N' ? [x + 1, y] : [x, y + 1];
    const ax = w2sx(x, y), ay = w2sy(x, y);
    const bx = w2sx(x2, y2), by = w2sy(x2, y2);
    const base = side === 'N' ? '#c9c2b4' : '#a89f8e';

    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx, by - hpx);
    ctx.lineTo(ax, ay - hpx);
    ctx.closePath();
    ctx.fillStyle = base;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.25)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (val === 2 && hpx > STUB_H * z + 1) {
      // A door: knock a gap out of the middle, leave a lintel.
      const mx1 = ax + (bx - ax) * 0.25, my1 = ay + (by - ay) * 0.25;
      const mx2 = ax + (bx - ax) * 0.75, my2 = ay + (by - ay) * 0.75;
      ctx.beginPath();
      ctx.moveTo(mx1, my1);
      ctx.lineTo(mx2, my2);
      ctx.lineTo(mx2, my2 - hpx * 0.8);
      ctx.lineTo(mx1, my1 - hpx * 0.8);
      ctx.closePath();
      ctx.fillStyle = 'rgba(20,24,28,.85)';
      ctx.fill();
    }
    if (val === 3 && hpx > STUB_H * z + 1) {
      const mx1 = ax + (bx - ax) * 0.3, my1 = ay + (by - ay) * 0.3;
      const mx2 = ax + (bx - ax) * 0.7, my2 = ay + (by - ay) * 0.7;
      ctx.beginPath();
      ctx.moveTo(mx1, my1 - hpx * 0.35);
      ctx.lineTo(mx2, my2 - hpx * 0.35);
      ctx.lineTo(mx2, my2 - hpx * 0.75);
      ctx.lineTo(mx1, my1 - hpx * 0.75);
      ctx.closePath();
      ctx.fillStyle = 'rgba(150,210,235,.9)';
      ctx.fill();
    }
    if (val === 2 && hpx <= STUB_H * z + 1) {
      // A cutaway door: mark the gap so it reads as a doorway, not a fence.
      ctx.fillStyle = 'rgba(20,24,28,.5)';
      ctx.fillRect((ax + bx) / 2 - 3, (ay + by) / 2 - hpx - 2, 6, 3);
    }
  }

  function drawObject(obj) {
    const def = OBJECTS[obj.def];
    const { w, d } = rotSize(obj.def, obj.rot);
    const moving = moveState && moveState.id === obj.id;
    drawIsoBox(obj.x, obj.y, w, d, def.h, def.color, moving ? 0.4 : 1);
    // Dress a couple of shapes so the room reads at a glance.
    if (obj.def === 'bed' || obj.def === 'bigbed') {
      drawIsoBox(obj.x, obj.y, w, 0.6, def.h + 6, '#e8ecef', moving ? 0.4 : 1);
    }
    if (obj.def === 'tv') {
      drawIsoBox(obj.x + 0.15, obj.y + 0.15, Math.max(0.7, w - 0.3), Math.max(0.7, d - 0.3), def.h + 8, '#1c2026', moving ? 0.4 : 1);
    }
    // Screen AABB: leftmost corner (x, y+d), rightmost (x+w, y), top of the
    // back corner raised by the box height, bottom at the front corner.
    hit('object', obj.id,
      w2sx(obj.x, obj.y + d), w2sy(obj.x, obj.y) - def.h * cam.zoom,
      w2sx(obj.x + w, obj.y), w2sy(obj.x + w, obj.y + d));
  }

  function drawIsoBox(x, y, w, d, hpx, color, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(w2sx(x, y), w2sy(x, y));
    ctx.scale(cam.zoom, cam.zoom);
    drawIsoBoxRaw(ctx, 0, 0, w, d, hpx, color, 1);
    ctx.restore();
  }

  // Draws at origin in logical px: the caller has translated/scaled. Top face
  // lighter, left (SW) face base, right (SE) face darker — one light source,
  // no perspective, exactly enough shading to read as a solid.
  function drawIsoBoxRaw(c, x, y, w, d, hpx, color) {
    const px = (wx, wy) => [(wx - wy) * HW, (wx + wy) * HH];
    const [ax, ay] = px(x, y);             // back corner
    const [bx, by] = px(x + w, y);         // right
    const [cx2, cy2] = px(x + w, y + d);   // front
    const [dx2, dy2] = px(x, y + d);       // left
    const face = (pts, fill) => {
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
      c.closePath();
      c.fillStyle = fill;
      c.fill();
    };
    face([[ax, ay - hpx], [bx, by - hpx], [cx2, cy2 - hpx], [dx2, dy2 - hpx]], shade(color, 0.18));
    face([[dx2, dy2 - hpx], [cx2, cy2 - hpx], [cx2, cy2], [dx2, dy2]], color);
    face([[bx, by - hpx], [cx2, cy2 - hpx], [cx2, cy2], [bx, by]], shade(color, -0.22));
  }

  function drawBody(b) {
    const isTownie = b.id?.startsWith('t');
    const sim = isTownie ? null : b;
    const sx = w2sx(b.pos.x + 0.5, b.pos.y + 0.5);
    const sy = w2sy(b.pos.x + 0.5, b.pos.y + 0.5);
    const z = cam.zoom;
    const lying = sim && (sim.passedOutUntil != null || isSleepingHead(sim));
    const moving = b.path && b.path.length > 0;
    const bob = moving ? Math.sin(performance.now() / 90) * 1.5 * z : 0;

    if (lying) {
      ctx.save();
      ctx.globalAlpha = sim.passedOutUntil != null ? 0.85 : 1;
      rounded(sx - 14 * z, sy - 8 * z, 28 * z, 10 * z, 5 * z, b.shirt);
      circleOn(ctx, sx + 16 * z, sy - 5 * z, 5.5 * z, '#e8c39e');
      ctx.restore();
    } else {
      drawCapsule(ctx, sx, sy + bob, z, b.shirt, { townie: isTownie });
    }
    hit('sim', b.id, sx - 12 * z, sy - (SIM_H + 14) * z, sx + 12 * z, sy + 6 * z);

    if (sim && sim.dying) drawReaper(sx - 26 * z, sy, z);
  }

  // The whole cast is this one capsule: dark legs, coloured shirt, a head.
  function drawCapsule(c, sx, sy, z, shirt, { townie = false, ghost = false, preview = false } = {}) {
    c.save();
    if (ghost) c.globalAlpha = 0.45;
    rounded(sx - 6 * z, sy - 16 * z, 12 * z, 16 * z, 5 * z, '#343a44', c);
    rounded(sx - 7 * z, sy - 34 * z, 14 * z, 20 * z, 6 * z, shirt, c);
    circleOn(c, sx, sy - 40 * z, 6.5 * z, ghost ? shirt : '#e8c39e');
    if (townie && !preview) {
      // A visitor wears a name-tag stripe so guests read differently to family.
      c.fillStyle = 'rgba(255,255,255,.7)';
      c.fillRect(sx - 5 * z, sy - 30 * z, 10 * z, 2.5 * z);
    }
    c.restore();
  }

  function drawGhost(g) {
    const z = cam.zoom;
    const hover2 = Math.sin(performance.now() / 400) * 3 * z;
    const sx = w2sx(g.pos.x + 0.5, g.pos.y + 0.5);
    const sy = w2sy(g.pos.x + 0.5, g.pos.y + 0.5) - 6 * z + hover2;
    drawCapsule(ctx, sx, sy, z, g.shirt, { ghost: true });
  }

  function drawReaper(sx, sy, z) {
    ctx.save();
    rounded(sx - 8 * z, sy - 38 * z, 16 * z, 38 * z, 7 * z, '#14161a');
    circleOn(ctx, sx, sy - 42 * z, 7 * z, '#23262d');
    ctx.strokeStyle = '#9aa4ae';
    ctx.lineWidth = 2 * z;
    ctx.beginPath();
    ctx.moveTo(sx + 10 * z, sy);
    ctx.lineTo(sx + 10 * z, sy - 52 * z);
    ctx.lineTo(sx + 22 * z, sy - 58 * z);
    ctx.stroke();
    ctx.restore();
  }

  function drawFire(x, y) {
    const z = cam.zoom;
    const sx = w2sx(x + 0.5, y + 0.5), sy = w2sy(x + 0.5, y + 0.5);
    const t = performance.now() / 120;
    for (let i = 0; i < 3; i++) {
      const f = Math.sin(t + i * 2.1) * 0.5 + 0.5;
      ctx.beginPath();
      ctx.moveTo(sx - (8 - i * 2) * z, sy);
      ctx.lineTo(sx, sy - (26 + f * 10 - i * 6) * z);
      ctx.lineTo(sx + (8 - i * 2) * z, sy);
      ctx.closePath();
      ctx.fillStyle = ['#e5484d', '#f7861c', '#ffc53d'][i];
      ctx.fill();
    }
  }

  function drawNight() {
    const hr = game.time.minute / 60;
    // Full dark 23–5, dusk/dawn ramps either side, clear 7–19.
    let a = 0;
    if (hr >= 19 && hr < 23) a = (hr - 19) / 4;
    else if (hr >= 23 || hr < 5) a = 1;
    else if (hr >= 5 && hr < 7) a = (7 - hr) / 2;
    if (a > 0) {
      ctx.fillStyle = `rgba(10, 16, 38, ${0.35 * a})`;
      ctx.fillRect(0, 0, canvas._w, canvas._h);
    }
  }

  // HUD floats: never occluded by walls or furniture.
  function drawOverlay() {
    const z = cam.zoom;
    const now = R.absMin(game);
    for (const sim of game.sims) {
      if (sim.atWork) continue;
      const sx = w2sx(sim.pos.x + 0.5, sim.pos.y + 0.5);
      const sy = w2sy(sim.pos.x + 0.5, sim.pos.y + 0.5);
      if (sim.id === selectedId) drawPlumbob(sx, sy - 56 * z, z, R.mood(game, sim));
      if (sim.starveDeadline != null) {
        const left = Math.max(0, sim.starveDeadline - now);
        tag(sx, sy - 70 * z, `STARVING ${Math.floor(left / 60)}h ${Math.floor(left % 60)}m`, '#e5484d');
      } else if (sim.dying) {
        tag(sx, sy - 70 * z, 'DEATH IS HERE', '#e5484d');
      } else if (sim.passedOutUntil != null) {
        tag(sx, sy - 40 * z, 'passed out', '#8b8f98');
      }
    }
    if (game.mode === 'build' && (buyDef || moveState)) {
      const d = buyDef || R.objectById(game, moveState.id)?.def;
      if (d) tag(canvas._w / 2, 24, `${OBJECTS[d].label} — R to rotate, Esc to put away`, '#8b8f98');
    }
  }

  function drawPlumbob(sx, sy, z, m) {
    const t = performance.now() / 600;
    const wob = Math.abs(Math.sin(t)) * 0.6 + 0.4;
    const col = m > 66 ? '#30e07a' : m > 33 ? '#ffc53d' : '#e5484d';
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(wob, 1);
    ctx.beginPath();
    ctx.moveTo(0, -10 * z);
    ctx.lineTo(7 * z, 0);
    ctx.lineTo(0, 10 * z);
    ctx.lineTo(-7 * z, 0);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.restore();
  }

  function tag(sx, sy, text, color) {
    ctx.font = '600 11px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = 'rgba(12,14,18,.85)';
    ctx.beginPath();
    ctx.roundRect(sx - w / 2, sy - 9, w, 18, 5);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, sx, sy);
  }

  /* ---- tiny paint helpers ---- */

  function rounded(x, y, w, h, r, fill, c = ctx) {
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    c.fillStyle = fill;
    c.fill();
  }
  function circleOn(c, x, y, r, fill) {
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
  }
  function hit(kind, id, x0, y0, x1, y1) { hitList.push({ kind, id, x0, y0, x1, y1 }); }

  function isSleepingHead(sim) {
    const head = sim.queue[0];
    if (!head || head.state !== 'running' || head.kind !== 'object') return false;
    const obj = R.objectById(game, head.objectId);
    return !!(obj && OBJECTS[obj.def].interactions.find((i) => i.id === head.def)?.until);
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => Math.max(0, Math.min(255, Math.round(v + 255 * amt)));
    return `rgb(${ch(n >> 16)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
  }
  const clampNum = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

  /* ============================ boot ============================ */

  window.addEventListener('keydown', onKey);   // once; onKey gates on `shown`
  showTitle();

  sims.onShow = () => {
    shown = true;
    if (game && root.querySelector('.world')) { fitCanvas(); startClocks(); }
  };
  sims.onHide = () => {
    shown = false;
    stopClocks();
    autosaveNow();
  };
}

// The shell reads onShow/onHide off the module object, but they need to close
// over this run's timers and state, so they are hung on at boot (same note as
// snake/index.js).
const sims = { id: GAME, title: 'The Sims 5', init };
export default sims;
