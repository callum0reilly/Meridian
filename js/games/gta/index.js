// GTA: Dublin — lobby, network, host simulation, and the Three.js city.
//
// ---- Authority ----
//
// Same star topology as Impostor: the host runs rules.js at 20Hz and pushes
// the result out; clients send intents. Unlike Impostor nothing is secret —
// the whole city is public — so one snapshot is broadcast to everyone rather
// than culled per player.
//
// ---- Prediction ----
//
// Your own body (and your own car) simulate locally with the exact step
// functions the host runs, then ease onto the host's answer as it arrives.
// Everyone else interpolates one snapshot behind. Cars at 500 units/sec make
// this non-negotiable: an unpredicted car on a 100ms round trip steers like a
// canal barge.
//
// ---- Three.js ----
//
// Loaded from the CDN on first game start, not at page load — it is ~600KB
// and someone here to play Uno shouldn't pay for it. The city itself is built
// once from city.js data: every player renders the identical Dublin without
// a byte of geometry on the wire.

import { createRoom, joinRoom, normaliseCode } from '../../net.js';
import * as CITY from './city.js';
import * as R from './rules.js';

const GAME = 'gta';
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

/* ---- client-side smoothing (see impostor/index.js for the reasoning) ---- */
const INTERP_MS = 80;
const SNAP_FOOT = 90;
const SNAP_CAR = 150;
const MAX_CATCHUP = 3;

const KINDS = ['civ', 'garda', 'target'];
const KIND_IDX = { civ: 0, garda: 1, target: 2 };

const CIV_COLORS = [0xc23b3b, 0x3a6fc4, 0x3f9d5a, 0xc9c9ce, 0xcaa54a, 0x7b52ab];
const TARGET_COLOR = 0x8b1f1f;
const PED_COLORS = [0x6b705c, 0x4a5568, 0x805e73, 0x5c6b70, 0x77675a, 0x50607a];

const LOBBY_HTML = `
  <div class="lobby">
    <div class="lobby-card">
      <h2>GTA 7: Dublin</h2>
      <div class="lead">Drive, rob and cause chaos around the Liffey. Create a room and
        share the code — friends can join any time, even mid-rampage.</div>

      <div class="field">
        <label for="gta-name">Your name</label>
        <input id="gta-name" class="name" maxlength="12" placeholder="Nickname" autocomplete="off">
      </div>

      <button class="primary create">Create a room</button>

      <div class="or">or</div>

      <div class="field">
        <label for="gta-code">Room code</label>
        <div class="row">
          <input id="gta-code" class="code-input codein" maxlength="5" placeholder="ABC12"
                 autocomplete="off" autocorrect="off" spellcheck="false">
          <button class="join">Join</button>
        </div>
      </div>

      <div class="err lobbyerr"></div>
    </div>
  </div>
`;

const WAIT_HTML = `
  <div class="lobby">
    <div class="lobby-card">
      <h2>The city awaits</h2>
      <div class="lead">Share this code. You can head in alone — the rest can catch up.</div>
      <div class="code-display">
        <div class="cap">Room code</div>
        <div class="code codeval"></div>
        <button class="copy">Copy code</button>
      </div>
      <ul class="seats"></ul>
      <button class="primary start">Hit the streets</button>
      <div class="hint starthint"></div>
      <div class="err waiterr"></div>
    </div>
  </div>
`;

const GAME_HTML = `
  <div class="city">
    <div class="viewport">
      <canvas class="gl"></canvas>
      <div class="loading">Loading Dublin…</div>
      <div class="hud">
        <canvas class="minimap" width="200" height="154"></canvas>
        <div class="status">
          <div class="money">$0</div>
          <div class="stars"><span>★</span><span>★</span><span>★</span><span>★</span><span>★</span></div>
          <div class="hpbar"><div class="hpfill"></div></div>
        </div>
        <div class="missionbox" hidden>
          <div class="mname"></div>
          <div class="mline"></div>
          <div class="mtime"></div>
        </div>
        <div class="feed"></div>
        <div class="prompts"></div>
        <div class="keysheet">WASD drive/walk · Shift sprint · E car/job · Space shoot · Tab scores</div>
        <div class="wasted" hidden><div class="big">WASTED</div><div class="sub">Waking up at the Mater…</div></div>
        <div class="scores" hidden></div>
      </div>
    </div>
  </div>
`;

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

let threePromise = null;
const loadThree = () => (threePromise ??= import(THREE_URL));

function init(root, header) {
  let room = null;
  let state = null;         // host only
  let view = null;          // seats + log, from room pushes
  let selfId = null;
  let myName = 'Player';

  /* ---- the local model, rebuilt from snapshots ---- */
  let plEnts = new Map();   // seat -> eased entity
  let carEnts = new Map();  // carId -> eased entity
  let pedEnts = [];         // index-aligned with the host's ped array
  let me = null;            // { x, y, yaw, ix, iy, sprint } — predicted on foot
  let predCar = null;       // { x, y, yaw, speed, kind } — predicted at the wheel
  let myCarId = -1;
  let myRow = null;         // my slice of the latest snapshot (hp, money, wanted…)
  let myMission = null;     // [defIdx, secs, count, tx, ty]

  let raf = null;
  let simTimer = null;
  let simLast = 0, acc = 0, predictAcc = 0;
  let active = false;

  let keys = new Set();
  let fireHeld = false, lastFire = 0;
  let lastFoot = { x: 0, y: 0, sp: false };
  let lastDrv = { s: 0, th: 0 };
  let showScores = false;

  /* ---- three ---- */
  let THREE = null;
  let gl = null;            // { renderer, scene, camera, … } — null until built
  let sceneBuilding = false;
  let camYaw = Math.PI / 2;
  let fx = [];              // transient meshes: tracers, explosions
  let mapBase = null;       // prerendered minimap background

  const el = (sel) => root.querySelector('.' + sel);

  header.innerHTML = '<div class="tag gtatag">Sure look, it’s grand.</div>' +
                     '<button class="leave" hidden>Leave room</button>';
  const leaveBtn = header.querySelector('.leave');
  leaveBtn.onclick = () => {
    if (!confirm('Leave the room? This ends the game for you.')) return;
    teardown();
    showLobby();
  };

  function teardown() {
    stopSim();
    stopRender();
    room?.close();
    room = null; state = null; view = null; selfId = null;
    plEnts = new Map(); carEnts = new Map(); pedEnts = [];
    me = null; predCar = null; myCarId = -1; myRow = null; myMission = null;
    keys.clear(); fireHeld = false;
    if (gl) { gl.renderer.dispose(); gl = null; }
    fx = [];
    leaveBtn.hidden = true;
  }

  /* ============================== lobby ============================== */

  function showLobby(err) {
    root.innerHTML = LOBBY_HTML;
    leaveBtn.hidden = true;
    const nameIn = el('name');
    nameIn.value = myName === 'Player' ? '' : myName;
    if (err) el('lobbyerr').textContent = err;

    const codeIn = el('codein');
    codeIn.addEventListener('input', () => { codeIn.value = normaliseCode(codeIn.value); });

    const takeName = () => {
      myName = (nameIn.value || '').trim().slice(0, 12) || 'Player';
      return myName;
    };
    const busy = (btn, label) => { btn.disabled = true; btn.textContent = label; };

    el('create').onclick = async () => {
      const btn = el('create');
      takeName();
      busy(btn, 'Creating…');
      el('lobbyerr').textContent = '';
      try {
        room = await createRoom(GAME, { onJoin, onMessage: onHostMessage, onLeave, onError: onNetError });
        selfId = room.selfId;
        state = {
          phase: 'lobby',
          code: room.code,
          hostId: selfId,
          seats: [{ id: selfId, name: myName, color: R.COLORS[0], connected: true }],
          game: null,
        };
        leaveBtn.hidden = false;
        pushRoom();
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Create a room';
        el('lobbyerr').textContent = e.message;
      }
    };

    el('join').onclick = async () => {
      const btn = el('join');
      const code = normaliseCode(codeIn.value);
      takeName();
      el('lobbyerr').textContent = '';
      if (code.length !== 5) { el('lobbyerr').textContent = 'Enter the 5-character room code.'; return; }
      busy(btn, '…');
      try {
        room = await joinRoom(GAME, code, { onMessage: onClientMessage, onLeave: onHostGone, onError: onNetError });
        selfId = room.selfId;
        room.send(null, { t: 'hello', name: myName });
        leaveBtn.hidden = false;
        root.innerHTML = '<div class="lobby"><div class="lobby-card">' +
          '<h2>Heading in…</h2><div class="lead">Connected. Waiting for the host.</div>' +
          '</div></div>';
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Join';
        el('lobbyerr').textContent = e.message;
      }
    };

    codeIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') el('join').click(); });
    nameIn.focus();
  }

  /* ========================= host: the room ========================= */

  function intent(msg) {
    if (room?.isHost) onHostMessage(msg, selfId);
    else room?.send(null, msg);
  }

  function onJoin(peerId) {
    if (state.seats.length >= R.MAX_PLAYERS) {
      room.send(peerId, { t: 'denied', msg: `That room is full (${R.MAX_PLAYERS} players).` });
    }
    // Mid-game joins are welcome — the seat is dealt when 'hello' arrives.
  }

  function onLeave(peerId) {
    if (!state) return;
    const seat = state.seats.find((s) => s.id === peerId);
    if (!seat) return;
    if (state.phase === 'lobby') {
      state.seats = state.seats.filter((s) => s.id !== peerId);
      state.seats.forEach((s, i) => { s.color = R.COLORS[i % R.COLORS.length]; });
    } else {
      seat.connected = false;
      R.applyLeave(state.game, peerId);
    }
    pushRoom();
  }

  function onHostMessage(msg, fromId) {
    if (!state) return;
    const seat = state.seats.find((s) => s.id === fromId);

    if (msg.t === 'hello') {
      if (seat) return;
      if (state.seats.length >= R.MAX_PLAYERS) {
        room.send(fromId, { t: 'denied', msg: `That room is full (${R.MAX_PLAYERS} players).` });
        return;
      }
      const newSeat = {
        id: fromId,
        name: String(msg.name || 'Player').trim().slice(0, 12) || 'Player',
        color: R.COLORS[state.seats.length % R.COLORS.length],
        connected: true,
      };
      state.seats.push(newSeat);
      if (state.phase === 'playing') R.addPlayer(state.game, newSeat);
      pushRoom();
      return;
    }

    if (!seat) return;

    if (msg.t === 'start') {
      if (fromId !== state.hostId || state.phase !== 'lobby') return;
      state.phase = 'playing';
      state.game = R.createState(state.seats, { seed: Date.now() >>> 0 });
      startSim();
      pushRoom();
      return;
    }

    const g = state.game;
    if (!g) return;
    if (msg.t === 'in') { R.setFootInput(g, fromId, +msg.x || 0, +msg.y || 0, !!msg.sp); return; }
    if (msg.t === 'drv') { R.setDriveInput(g, fromId, +msg.s || 0, +msg.th || 0); return; }
    if (msg.t === 'fire') { R.applyFire(g, fromId); return; }
    if (msg.t === 'use') { if (R.applyUse(g, fromId)) pushRoom(); }
  }

  /* ==================== host: push and snapshot ==================== */

  function roomView() {
    return {
      phase: state.phase,
      code: state.code,
      hostId: state.hostId,
      seats: state.seats.map((s) => ({ id: s.id, name: s.name, color: s.color, connected: s.connected })),
      log: state.game ? state.game.log.slice(-10) : [],
    };
  }

  function pushRoom() {
    if (!room?.isHost) return;
    const msg = { t: 'room', room: roomView() };
    room.broadcast(msg);
    applyRoom(msg.room);
  }

  function buildSnapshot() {
    const g = state.game;
    const pl = [], mis = [];
    g.seats.forEach((s, i) => {
      const p = g.players[s.id];
      if (!p || p.left) return;
      pl.push([i, Math.round(p.x), Math.round(p.y), Math.round(p.yaw * 100),
        Math.round(p.hp), R.wantedOf(p), p.alive ? 1 : 0, p.carId ?? -1,
        p.money, p.kills, p.deaths]);
      if (p.mission) {
        const m = p.mission;
        const def = CITY.MISSION_DEFS[m.def];
        let tx = 0, ty = 0, count = 0;
        if (def.kind === 'delivery') { tx = def.drop.x; ty = def.drop.y; }
        else if (def.kind === 'fetch') {
          count = m.targets.length;
          let bd = Infinity;
          for (const t of m.targets) {
            const d = (t.x - p.x) ** 2 + (t.y - p.y) ** 2;
            if (d < bd) { bd = d; tx = t.x; ty = t.y; }
          }
        } else {
          const car = g.cars.find((c) => c.id === m.carId);
          if (car) { tx = car.x; ty = car.y; }
        }
        mis.push([i, m.def, Math.max(0, Math.ceil((m.endsAt - g.tick) / R.TICK_HZ)),
          count, Math.round(tx), Math.round(ty)]);
      }
    });

    return {
      t: 's',
      pl,
      mis,
      cars: g.cars.map((c) => [c.id, KIND_IDX[c.kind], c.model,
        Math.round(c.x), Math.round(c.y), Math.round(c.yaw * 100), Math.round(c.speed * 10),
        c.driver == null ? -1 : c.driver === 'ai' ? -2 : (g.players[c.driver]?.seat ?? -1),
        Math.round(c.hp), c.dead ? 1 : 0]),
      peds: g.peds.map((pd) => [Math.round(pd.x), Math.round(pd.y),
        Math.round(pd.yaw * 100), pd.dead ? 1 : 0]),
      sh: g.shots,
      bm: g.booms,
    };
  }

  /* ======================= host: simulation clock ======================= */

  function startSim() {
    if (!room?.isHost || simTimer !== null) return;
    simLast = performance.now();
    acc = 0;
    simTimer = setInterval(() => {
      const now = performance.now();
      acc += now - simLast;
      simLast = now;

      let n = 0, sync = false;
      while (acc >= R.TICK_MS && n < MAX_CATCHUP) {
        acc -= R.TICK_MS;
        n += 1;
        if (R.step(state.game).sync) sync = true;
      }
      if (acc >= R.TICK_MS * MAX_CATCHUP) acc = 0;
      if (!n) return;

      const snap = buildSnapshot();
      room.broadcast(snap);
      applySnapshot(snap);
      if (sync) pushRoom();
    }, R.TICK_MS);
  }

  function stopSim() {
    if (simTimer === null) return;
    clearInterval(simTimer);
    simTimer = null;
  }

  /* ======================= client: messages ======================= */

  function onClientMessage(msg) {
    if (msg.t === 'room') { applyRoom(msg.room); leaveBtn.hidden = false; }
    else if (msg.t === 's') applySnapshot(msg);
    else if (msg.t === 'denied') { teardown(); showLobby(msg.msg); }
  }

  function onHostGone() {
    if (!view) return;
    teardown();
    showLobby('The host left, so the city closed. WebRTC games live in the host’s browser tab.');
  }

  function onNetError(err) {
    const target = root.querySelector('.lobbyerr') || root.querySelector('.waiterr');
    if (target) target.textContent = err.message;
    else console.error('[gta] net error', err);
  }

  function applyRoom(next) {
    const wasPlaying = view?.phase === 'playing';
    view = next;
    if (view.phase === 'playing' && !wasPlaying) enterCity();
    render();
  }

  async function enterCity() {
    root.innerHTML = GAME_HTML;
    if (!sceneBuilding && !gl) {
      sceneBuilding = true;
      try {
        THREE = await loadThree();
        buildScene();
        buildMinimapBase();
      } catch (e) {
        console.error('[gta] three failed to load', e);
        const load = el('loading');
        if (load) load.textContent = 'Couldn’t load the 3D engine — check your connection and reopen the tab.';
        sceneBuilding = false;
        return;
      }
      sceneBuilding = false;
    }
    const load = el('loading');
    if (load) load.hidden = true;
    startRender();
  }

  const mySeat = () => view?.seats.findIndex((s) => s.id === selfId) ?? -1;

  let lastSnapshotPl = [];

  function applySnapshot(s) {
    if (view?.phase !== 'playing') return;
    const now = performance.now();
    const seat = mySeat();
    lastSnapshotPl = s.pl;         // kept raw for the leaderboard

    /* cars first, so a just-entered car exists before the player row needs it */
    const seenCars = new Set();
    for (const row of s.cars) {
      const [id, kind, model, x, y, yaw100, spd10, driverSeat, hp, dead] = row;
      seenCars.add(id);
      let e = carEnts.get(id);
      if (!e) {
        e = { x, y, fx: x, fy: y, tx: x, ty: y, t0: now, yawF: yaw100 / 100, yawT: yaw100 / 100 };
        carEnts.set(id, e);
      } else {
        e.fx = e.x; e.fy = e.y; e.tx = x; e.ty = y;
        e.yawF = e.yaw ?? e.yawT; e.yawT = yaw100 / 100;
        e.t0 = now;
      }
      Object.assign(e, { kind, model, speed: spd10 / 10, driverSeat, hp, dead: !!dead });
    }
    for (const id of [...carEnts.keys()]) if (!seenCars.has(id)) { carEnts.delete(id); }

    const seenPl = new Set();
    myRow = null;
    for (const row of s.pl) {
      const [i, x, y, yaw100] = row;
      seenPl.add(i);
      if (i === seat) { myRow = row; reconcileSelf(row); continue; }
      let e = plEnts.get(i);
      if (!e) {
        e = { x, y, fx: x, fy: y, tx: x, ty: y, t0: now, yawF: yaw100 / 100, yawT: yaw100 / 100 };
        plEnts.set(i, e);
      } else {
        e.fx = e.x; e.fy = e.y; e.tx = x; e.ty = y;
        e.yawF = e.yaw ?? e.yawT; e.yawT = yaw100 / 100;
        e.t0 = now;
      }
      Object.assign(e, { hp: row[4], wanted: row[5], alive: !!row[6], carId: row[7] });
    }
    for (const i of [...plEnts.keys()]) if (!seenPl.has(i)) plEnts.delete(i);

    pedEnts.length = s.peds.length;
    for (let i = 0; i < s.peds.length; i++) {
      const [x, y, yaw100, dead] = s.peds[i];
      let e = pedEnts[i];
      if (!e || (Math.hypot(x - e.x, y - e.y) > SNAP_FOOT)) {
        pedEnts[i] = { x, y, fx: x, fy: y, tx: x, ty: y, t0: now, yawF: yaw100 / 100, yawT: yaw100 / 100, dead: !!dead };
      } else {
        e.fx = e.x; e.fy = e.y; e.tx = x; e.ty = y;
        e.yawF = e.yaw ?? e.yawT; e.yawT = yaw100 / 100;
        e.t0 = now;
        e.dead = !!dead;
      }
    }

    myMission = s.mis.find((m) => m[0] === seat) ?? null;
    if (gl) {
      for (const [x1, y1, x2, y2] of s.sh) spawnTracer(x1, y1, x2, y2);
      for (const [x, y] of s.bm) spawnBoom(x, y);
    }
  }

  /** Fold the host's answer into our predicted self — foot or wheel. */
  function reconcileSelf(row) {
    const [, x, y, yaw100, , , alive, carId] = row;
    const wasCar = myCarId;
    myCarId = carId;

    if (carId >= 0) {
      const host = carEnts.get(carId);
      if (!predCar || wasCar !== carId) {
        predCar = host
          ? { x: host.tx, y: host.ty, yaw: host.yawT, speed: host.speed, kind: KINDS[host.kind] }
          : { x, y, yaw: yaw100 / 100, speed: 0, kind: 'civ' };
      } else if (host) {
        if (Math.hypot(host.tx - predCar.x, host.ty - predCar.y) > SNAP_CAR) {
          predCar.x = host.tx; predCar.y = host.ty; predCar.yaw = host.yawT;
        } else {
          predCar.x += (host.tx - predCar.x) * 0.2;
          predCar.y += (host.ty - predCar.y) * 0.2;
          predCar.yaw += shortest(predCar.yaw, host.yawT) * 0.3;
        }
        predCar.speed = host.speed;
        predCar.kind = KINDS[host.kind];
      }
      if (me) { me.x = x; me.y = y; }
      return;
    }

    predCar = null;
    if (!me || !alive) { me = { x, y, yaw: yaw100 / 100, ix: 0, iy: 0, sprint: false }; return; }
    if (Math.hypot(x - me.x, y - me.y) > SNAP_FOOT) { me.x = x; me.y = y; return; }
    me.x += (x - me.x) * 0.25;
    me.y += (y - me.y) * 0.25;
  }

  /* ============================== input ============================== */

  const controllable = () => active && view?.phase === 'playing' && myRow?.[6] === 1;

  function onKeyDown(ev) {
    if (!active || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (k === 'tab') { ev.preventDefault(); showScores = true; return; }
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
      if (k.startsWith('arrow')) ev.preventDefault();
      keys.add(k);
      return;
    }
    if (!controllable()) return;
    if (k === ' ') { ev.preventDefault(); fireHeld = true; }
    else if (k === 'e') { ev.preventDefault(); intent({ t: 'use' }); }
  }

  function onKeyUp(ev) {
    const k = ev.key.toLowerCase();
    if (k === 'tab') { showScores = false; return; }
    if (k === ' ') { fireHeld = false; return; }
    keys.delete(k);
  }

  const releaseAll = () => { keys.clear(); fireHeld = false; pumpInput(); };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);

  root.addEventListener('pointerdown', (ev) => {
    if (!controllable() || !ev.target.classList?.contains('gl')) return;
    intent({ t: 'fire' });
    lastFire = performance.now();
  });

  const held = (a, b) => (keys.has(a) || keys.has(b) ? 1 : 0);

  /** Sent on change, not on a clock — holding W for ten seconds is one packet. */
  function pumpInput() {
    const fwd = held('w', 'arrowup') - held('s', 'arrowdown');
    const side = held('d', 'arrowright') - held('a', 'arrowleft');
    const can = controllable();

    if (can && myCarId >= 0) {
      const drv = { s: side, th: fwd };
      if (drv.s !== lastDrv.s || drv.th !== lastDrv.th) {
        lastDrv = drv;
        intent({ t: 'drv', s: drv.s, th: drv.th });
      }
      if (lastFoot.x || lastFoot.y) { lastFoot = { x: 0, y: 0, sp: false }; intent({ t: 'in', x: 0, y: 0 }); }
    } else {
      // Camera-relative: W walks away from the camera, D walks screen-right.
      let x = 0, y = 0;
      if (can && (fwd || side)) {
        x = fwd * Math.cos(camYaw) - side * Math.sin(camYaw);
        y = fwd * Math.sin(camYaw) + side * Math.cos(camYaw);
        const len = Math.hypot(x, y);
        x /= len; y /= len;
      }
      const sp = can && keys.has('shift');
      if (x !== lastFoot.x || y !== lastFoot.y || sp !== lastFoot.sp) {
        lastFoot = { x, y, sp };
        intent({ t: 'in', x: +x.toFixed(3), y: +y.toFixed(3), sp });
      }
      if (me) { me.ix = x; me.iy = y; me.sprint = sp; }
      if (lastDrv.s || lastDrv.th) { lastDrv = { s: 0, th: 0 }; intent({ t: 'drv', s: 0, th: 0 }); }
    }

    if (fireHeld && can && performance.now() - lastFire > 240) {
      lastFire = performance.now();
      intent({ t: 'fire' });
    }
  }

  /** Run our own body forward on the same clock the host uses. */
  function predict(dt) {
    if (!controllable()) return;
    predictAcc = Math.min(predictAcc + dt, R.TICK_MS * MAX_CATCHUP);
    while (predictAcc >= R.TICK_MS) {
      predictAcc -= R.TICK_MS;
      if (predCar) R.stepCarPhysics(predCar, lastDrv.s, lastDrv.th);
      else if (me) R.stepFoot(me);
    }
  }

  /* ============================== the loop ============================== */

  function startRender() {
    if (raf !== null || !active) return;
    predictAcc = 0;
    let last = performance.now();
    const frame = (ts) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(120, ts - last);
      last = ts;
      pumpInput();
      predict(dt);
      if (gl) drawFrame(ts, dt);
      drawHUD(ts);
    };
    raf = requestAnimationFrame(frame);
  }

  function stopRender() {
    if (raf === null) return;
    cancelAnimationFrame(raf);
    raf = null;
  }

  /* ============================== three: the city ============================== */

  function buildScene() {
    const canvas = el('gl');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xa9bac9);           // Dublin overcast
    scene.fog = new THREE.Fog(0xa9bac9, 700, 2400);

    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 4000);

    scene.add(new THREE.HemisphereLight(0xcfd9e4, 0x3e4650, 1.05));
    const sun = new THREE.DirectionalLight(0xfff2dd, 0.9);
    sun.position.set(-600, 900, -400);
    scene.add(sun);

    buildGround(scene);
    buildBuildings(scene);
    buildLandmarks(scene);

    const markers = CITY.MISSION_DEFS.map((def) => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(26, 3, 8, 28),
        new THREE.MeshBasicMaterial({ color: 0xffc53d, transparent: true, opacity: 0.85 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(def.marker.x, 10, def.marker.y);
      scene.add(ring);
      return ring;
    });

    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(9, 9, 340, 10, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffc53d, transparent: true, opacity: 0.32, side: THREE.DoubleSide }),
    );
    beacon.position.y = 170;
    beacon.visible = false;
    scene.add(beacon);

    gl = {
      renderer, scene, camera, markers, beacon,
      playerMeshes: new Map(), carMeshes: new Map(), pedMeshes: [],
      camPos: new THREE.Vector3(1540, 90, 900),
    };

    const viewport = el('viewport');
    const fit = () => {
      const w = viewport.clientWidth, h = viewport.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    new ResizeObserver(fit).observe(viewport);
    fit();
  }

  const plane = (w, h, color, x, y, z, extra = {}) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshLambertMaterial({ color, ...extra }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    return m;
  };

  const box = (w, ht, d, color, x, y, z, extra = {}) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, ht, d),
      new THREE.MeshLambertMaterial({ color, ...extra }),
    );
    m.position.set(x, y, z);
    return m;
  };

  function buildGround(scene) {
    const { WORLD_W: W, WORLD_H: H } = CITY;
    scene.add(plane(W, H, 0x565c63, W / 2, 0, H / 2));                    // pavement

    for (const r of CITY.ROADS) {
      scene.add(plane(r.w, r.h, r.ped ? 0x6a6f75 : 0x373c42, r.x + r.w / 2, 0.6, r.y + r.h / 2));
      if (r.ped) continue;
      // Dashed centre line down the long axis.
      const alongX = r.w >= r.h;
      const len = alongX ? r.w : r.h;
      for (let d = 30; d < len - 30; d += 70) {
        scene.add(plane(alongX ? 26 : 3, alongX ? 3 : 26, 0xb9bec4,
          alongX ? r.x + d : r.x + r.w / 2, 0.7, alongX ? r.y + r.h / 2 : r.y + d));
      }
    }

    // The Liffey, sunk below quay walls that stop you falling in politely.
    scene.add(plane(CITY.WORLD_W, CITY.RIVER.h, 0x2e5f86, W / 2, -7, CITY.RIVER.y + CITY.RIVER.h / 2));
    for (const w of CITY.WATER) {
      scene.add(box(w.w, 9, 5, 0x6f7880, w.x + w.w / 2, 3, w.y - 2));
      scene.add(box(w.w, 9, 5, 0x6f7880, w.x + w.w / 2, 3, w.y + w.h + 2));
    }
    for (const b of CITY.BRIDGES) {
      const cx = b.x + b.w / 2, cz = CITY.RIVER.y + CITY.RIVER.h / 2;
      scene.add(plane(b.w, CITY.RIVER.h + 8, b.ped ? 0x8b9096 : 0x40454b, cx, 0.8, cz));
      scene.add(box(4, 8, CITY.RIVER.h, b.ped ? 0xe8e9ec : 0x8a9097, b.x + 2, 4, cz));
      scene.add(box(4, 8, CITY.RIVER.h, b.ped ? 0xe8e9ec : 0x8a9097, b.x + b.w - 2, 4, cz));
      if (b.ped) {
        // The Ha'penny's white ribs.
        for (const off of [8, b.w - 8]) {
          const arch = new THREE.Mesh(
            new THREE.TorusGeometry(62, 2.4, 8, 24, Math.PI),
            new THREE.MeshLambertMaterial({ color: 0xf0f1f4 }),
          );
          arch.rotation.y = Math.PI / 2;
          arch.position.set(b.x + off, 2, cz);
          scene.add(arch);
        }
      }
    }

    for (const b of CITY.BLOCKS) {
      if (b.kind !== 'park') continue;
      scene.add(plane(b.w, b.h, 0x2f6b45, b.x + b.w / 2, 0.5, b.y + b.h / 2));
    }
    for (const [x, y] of CITY.TREES) {
      scene.add(box(4, 12, 4, 0x5a4633, x, 6, y));
      const top = new THREE.Mesh(
        new THREE.SphereGeometry(11, 8, 6),
        new THREE.MeshLambertMaterial({ color: 0x3a7a4d }),
      );
      top.position.set(x, 20, y);
      scene.add(top);
    }
  }

  /** One shared window texture; multiplied by each building's colour. */
  function windowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, 128, 128);
    x.fillStyle = '#4d545e';
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 4; col++) {
        x.fillRect(10 + col * 30, 12 + row * 24, 16, 14);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    return tex;
  }

  function buildBuildings(scene) {
    const tex = windowTexture();
    for (const b of CITY.BUILDINGS) {
      const side = new THREE.MeshLambertMaterial({ color: b.color, map: tex });
      const roof = new THREE.MeshLambertMaterial({ color: 0x3c4046 });
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(b.w, b.ht, b.h),
        [side, side, roof, roof, side, side],
      );
      mesh.position.set(b.x + b.w / 2, b.ht / 2, b.y + b.h / 2);
      scene.add(mesh);
    }
  }

  function textSprite(text, { size = 16, color = '#ffffff' } = {}) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = '700 44px ui-sans-serif, system-ui, sans-serif';
    c.width = Math.max(2, Math.ceil(ctx.measureText(text).width) + 24);
    c.height = 60;
    const ctx2 = c.getContext('2d');
    ctx2.font = '700 44px ui-sans-serif, system-ui, sans-serif';
    ctx2.fillStyle = 'rgba(10,14,20,0.55)';
    ctx2.fillRect(0, 0, c.width, c.height);
    ctx2.fillStyle = color;
    ctx2.textBaseline = 'middle';
    ctx2.fillText(text, 12, 32);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), depthTest: true,
    }));
    sprite.scale.set(size * (c.width / c.height), size, 1);
    return sprite;
  }

  function sign(scene, text, x, ht, y, color = '#fff') {
    const s = textSprite(text, { size: 22, color });
    s.position.set(x, ht, y);
    scene.add(s);
  }

  function buildLandmarks(scene) {
    // The Spire: 120m of stainless steel; here, a very confident cone.
    const spire = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 5, 250, 12),
      new THREE.MeshLambertMaterial({ color: 0xc6ccd2 }),
    );
    spire.position.set(CITY.SPIRE.x, 125, CITY.SPIRE.y);
    scene.add(spire);

    for (const b of CITY.BLOCKS) {
      const cx = b.x + b.w / 2, cz = b.y + b.h / 2;
      switch (b.kind) {
        case 'gpo': {
          scene.add(box(b.w, 70, b.h, 0x9aa0a4, cx, 35, cz));
          for (let i = 0; i < 6; i++) {
            const col = new THREE.Mesh(
              new THREE.CylinderGeometry(4, 4, 52, 8),
              new THREE.MeshLambertMaterial({ color: 0xe6e2d8 }),
            );
            col.position.set(b.x + b.w + 6, 26, b.y + 22 + i * 31);
            scene.add(col);
          }
          scene.add(box(14, 8, b.h, 0xe6e2d8, b.x + b.w + 6, 56, cz));
          sign(scene, 'GPO', cx, 84, cz);
          break;
        }
        case 'custom': {
          scene.add(box(b.w, 52, b.h, 0xd9d2c0, cx, 26, cz));
          const dome = new THREE.Mesh(
            new THREE.SphereGeometry(26, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
            new THREE.MeshLambertMaterial({ color: 0x3f7a5c }),
          );
          dome.position.set(cx, 66, cz);
          scene.add(box(30, 16, 30, 0xd9d2c0, cx, 58, cz));
          scene.add(dome);
          sign(scene, 'CUSTOM HOUSE', cx, 100, cz);
          break;
        }
        case 'garda': {
          scene.add(box(b.w, 46, b.h, 0x9fb4c8, cx, 23, cz));
          sign(scene, 'GARDA', cx, 60, cz, '#cfe4ff');
          break;
        }
        case 'hospital': {
          scene.add(box(b.w, 58, b.h, 0xe8e9ec, cx, 29, cz));
          scene.add(box(20, 6, 6, 0xe5484d, cx, 62, cz, { emissive: 0xe5484d }));
          scene.add(box(6, 6, 20, 0xe5484d, cx, 62, cz, { emissive: 0xe5484d }));
          sign(scene, 'THE MATER', cx, 78, cz);
          break;
        }
        case 'bank': {
          scene.add(box(b.w, 54, b.h, 0x848b93, cx, 27, cz));
          for (let i = 0; i < 4; i++) {
            const col = new THREE.Mesh(
              new THREE.CylinderGeometry(4, 4, 40, 8),
              new THREE.MeshLambertMaterial({ color: 0xb8bec5 }),
            );
            col.position.set(b.x - 6, 20, b.y + 24 + i * 44);
            scene.add(col);
          }
          break;
        }
        case 'trinity': {
          scene.add(plane(b.w - 16, b.h - 16, 0x3a7a4d, cx, 0.8, cz));
          scene.add(box(b.w, 10, 6, 0x5b5f66, cx, 5, b.y + 3));
          scene.add(box(b.w, 10, 6, 0x5b5f66, cx, 5, b.y + b.h - 3));
          scene.add(box(6, 10, b.h, 0x5b5f66, b.x + 3, 5, cz));
          scene.add(box(6, 10, b.h, 0x5b5f66, b.x + b.w - 3, 5, cz));
          scene.add(box(150, 48, 60, 0xa7a49a, b.x + 90, 24, b.y + 60));
          scene.add(box(180, 44, 70, 0xa7a49a, b.x + b.w - 120, 22, b.y + b.h - 80));
          const tower = new THREE.Mesh(
            new THREE.CylinderGeometry(11, 11, 84, 10),
            new THREE.MeshLambertMaterial({ color: 0xd9d5c9 }),
          );
          tower.position.set(b.x + 280, 42, cz);
          scene.add(tower);
          const cap = new THREE.Mesh(
            new THREE.SphereGeometry(13, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
            new THREE.MeshLambertMaterial({ color: 0x8f9aa3 }),
          );
          cap.position.set(b.x + 280, 84, cz);
          scene.add(cap);
          sign(scene, 'TRINITY COLLEGE', b.x + 120, 70, b.y + 30);
          break;
        }
        case 'christ': {
          scene.add(box(b.w, 58, b.h, 0xa8a396, cx, 29, cz));
          scene.add(box(40, 96, 40, 0x9b968a, b.x + 30, 48, b.y + 30));
          const steeple = new THREE.Mesh(
            new THREE.ConeGeometry(22, 40, 4),
            new THREE.MeshLambertMaterial({ color: 0x6f6b60 }),
          );
          steeple.position.set(b.x + 30, 116, b.y + 30);
          scene.add(steeple);
          sign(scene, 'CHRIST CHURCH', cx, 78, cz);
          break;
        }
        case 'templebar':
          sign(scene, 'THE TEMPLE BAR', cx, 58, cz, '#ffd9a0');
          break;
        case 'guinness': {
          scene.add(box(b.w, 64, b.h, 0x33302c, cx, 32, cz));
          sign(scene, "ST JAMES'S GATE", cx, 84, cz, '#f0d9a8');
          break;
        }
        case 'park':
          sign(scene, "ST STEPHEN'S GREEN", cx, 44, cz, '#c9ecd4');
          break;
      }
    }
  }

  /* ---- dynamic meshes ---- */

  let wheelGeo = null;
  function makeCarMesh(kind, model) {
    const color = kind === 1 ? 0xf2f4f6 : kind === 2 ? TARGET_COLOR : CIV_COLORS[model % CIV_COLORS.length];
    const g = new THREE.Group();
    const body = box(44, 12, 20, color, 0, 8, 0);
    const cabin = box(22, 9, 16, kind === 1 ? 0xf2f4f6 : 0x232830, -3, 18, 0);
    g.add(body, cabin);
    g.add(box(3, 3, 5, 0xfff3c4, 21, 8, -6, { emissive: 0xfff3c4, emissiveIntensity: 0.6 }));
    g.add(box(3, 3, 5, 0xfff3c4, 21, 8, 6, { emissive: 0xfff3c4, emissiveIntensity: 0.6 }));

    wheelGeo ??= (() => {
      const geo = new THREE.CylinderGeometry(5, 5, 4, 10);
      geo.rotateX(Math.PI / 2);
      return geo;
    })();
    const wheels = [];
    for (const [wx, wz] of [[14, 11], [14, -11], [-14, 11], [-14, -11]]) {
      const wheel = new THREE.Mesh(wheelGeo, new THREE.MeshLambertMaterial({ color: 0x1a1d22 }));
      wheel.position.set(wx, 5, wz);
      g.add(wheel);
      wheels.push(wheel);
    }

    let bar = null;
    if (kind === 1) {
      g.add(box(30, 2, 20, 0x2b4d8f, -3, 13.5, 0));   // the stripe
      bar = new THREE.Group();
      const blue = box(5, 3, 6, 0x3d7dff, -3, 0, -4, { emissive: 0x3d7dff, emissiveIntensity: 1 });
      const red = box(5, 3, 6, 0xe5484d, -3, 0, 4, { emissive: 0xe5484d, emissiveIntensity: 1 });
      bar.add(blue, red);
      bar.position.y = 24;
      bar.userData = { blue, red };
      g.add(bar);
    }
    g.userData = { wheels, bar, body, cabin, roll: 0, husk: false };
    return g;
  }

  function huskify(g) {
    if (g.userData.husk) return;
    g.userData.husk = true;
    g.traverse((o) => {
      if (o.isMesh) o.material = new THREE.MeshLambertMaterial({ color: 0x24262a });
    });
  }

  function makePersonMesh(colorHex, name) {
    const g = new THREE.Group();
    const torso = new THREE.Mesh(
      new THREE.CylinderGeometry(6.5, 7.5, 16, 10),
      new THREE.MeshLambertMaterial({ color: colorHex }),
    );
    torso.position.y = 16;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(5.5, 10, 8),
      new THREE.MeshLambertMaterial({ color: 0xe8c39e }),
    );
    head.position.y = 29;
    g.add(torso, head);

    const legs = [];
    for (const z of [-3.5, 3.5]) {
      const hip = new THREE.Group();
      hip.position.set(0, 9, z);
      const leg = box(4, 9, 4, 0x2b3038, 0, -4.5, 0);
      hip.add(leg);
      g.add(hip);
      legs.push(hip);
    }
    if (name) {
      const label = textSprite(name, { size: 12 });
      label.position.y = 42;
      g.add(label);
    }
    g.userData = { legs, phase: 0 };
    return g;
  }

  /* ---- fx ---- */

  function spawnTracer(x1, y1, x2, y2) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x1, 14, y1), new THREE.Vector3(x2, 14, y2),
    ]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true }));
    gl.scene.add(line);
    fx.push({ mesh: line, t0: performance.now(), ttl: 90, kind: 'tracer' });
  }

  function spawnBoom(x, y) {
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(20, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xff8c3b, transparent: true, opacity: 0.95 }),
    );
    ball.position.set(x, 18, y);
    gl.scene.add(ball);
    fx.push({ mesh: ball, t0: performance.now(), ttl: 550, kind: 'boom' });
  }

  function stepFx(now) {
    fx = fx.filter((f) => {
      const k = (now - f.t0) / f.ttl;
      if (k >= 1) {
        gl.scene.remove(f.mesh);
        f.mesh.geometry?.dispose();
        f.mesh.material?.dispose();
        return false;
      }
      if (f.kind === 'boom') {
        f.mesh.scale.setScalar(1 + k * 3.2);
        f.mesh.material.opacity = 0.95 * (1 - k);
      } else {
        f.mesh.material.opacity = 1 - k;
      }
      return true;
    });
  }

  /* ---- per-frame scene update ---- */

  const lerpK = (e, now) => Math.min(1, (now - e.t0) / INTERP_MS);
  function eased(e, now) {
    const k = lerpK(e, now);
    e.x = e.fx + (e.tx - e.fx) * k;
    e.y = e.fy + (e.ty - e.fy) * k;
    e.yaw = e.yawF + shortest(e.yawF, e.yawT) * k;
    return e;
  }

  function drawFrame(ts, dt) {
    const now = performance.now();
    const seat = mySeat();

    /* players */
    const seenP = new Set();
    for (const [i, e] of plEnts) {
      seenP.add(i);
      eased(e, now);
      let mesh = gl.playerMeshes.get(i);
      if (!mesh) {
        const s = view.seats[i];
        mesh = makePersonMesh(new THREE.Color(R.COLOR_HEX[s?.color] || '#888').getHex(), s?.name || '?');
        gl.scene.add(mesh);
        gl.playerMeshes.set(i, mesh);
      }
      mesh.visible = e.alive && e.carId === -1;
      mesh.position.set(e.x, 0, e.y);
      mesh.rotation.y = -e.yaw;
      animateLegs(mesh, e, dt);
    }
    for (const [i, mesh] of gl.playerMeshes) {
      if (i !== 'me' && !seenP.has(i)) { gl.scene.remove(mesh); gl.playerMeshes.delete(i); }
    }

    /* self */
    let selfMesh = gl.playerMeshes.get('me');
    if (!selfMesh && seat >= 0 && view.seats[seat]) {
      const s = view.seats[seat];
      selfMesh = makePersonMesh(new THREE.Color(R.COLOR_HEX[s.color] || '#fff').getHex(), s.name);
      gl.scene.add(selfMesh);
      gl.playerMeshes.set('me', selfMesh);
    }
    if (selfMesh && me) {
      selfMesh.visible = myRow?.[6] === 1 && myCarId < 0;
      selfMesh.position.set(me.x, 0, me.y);
      selfMesh.rotation.y = -me.yaw;
      animateLegs(selfMesh, { x: me.x, y: me.y }, dt, me.ix || me.iy);
    }

    /* cars */
    const seenC = new Set();
    for (const [id, e] of carEnts) {
      seenC.add(id);
      let mesh = gl.carMeshes.get(id);
      if (!mesh || mesh.userData.kind !== e.kind) {
        if (mesh) gl.scene.remove(mesh);
        mesh = makeCarMesh(e.kind, e.model);
        mesh.userData.kind = e.kind;
        gl.scene.add(mesh);
        gl.carMeshes.set(id, mesh);
      }
      const mine = id === myCarId && predCar;
      const px = mine ? predCar.x : eased(e, now).x;
      const py = mine ? predCar.y : e.y;
      const pyaw = mine ? predCar.yaw : e.yaw;
      mesh.position.set(px, 0, py);
      mesh.rotation.y = -pyaw;
      if (e.dead) huskify(mesh);
      else {
        const spd = mine ? predCar.speed : e.speed;
        mesh.userData.roll += spd * dt * 0.012;
        for (const w of mesh.userData.wheels) w.rotation.z = -mesh.userData.roll;
        if (mesh.userData.bar) {
          const on = Math.floor(ts / 260) % 2 === 0;
          mesh.userData.bar.userData.blue.visible = on;
          mesh.userData.bar.userData.red.visible = !on;
        }
      }
    }
    for (const [id, mesh] of gl.carMeshes) {
      if (!seenC.has(id)) { gl.scene.remove(mesh); gl.carMeshes.delete(id); }
    }

    /* peds */
    for (let i = 0; i < pedEnts.length; i++) {
      const e = pedEnts[i];
      let mesh = gl.pedMeshes[i];
      if (!mesh) {
        mesh = makePersonMesh(PED_COLORS[i % PED_COLORS.length], null);
        gl.scene.add(mesh);
        gl.pedMeshes[i] = mesh;
      }
      if (!e) { mesh.visible = false; continue; }
      mesh.visible = true;
      eased(e, now);
      mesh.position.set(e.x, e.dead ? 4 : 0, e.y);
      mesh.rotation.y = -e.yaw;
      mesh.rotation.z = e.dead ? Math.PI / 2 : 0;
      if (!e.dead) animateLegs(mesh, e, dt);
    }

    /* mission furniture */
    const bob = 8 + Math.sin(ts / 400) * 3;
    for (const ring of gl.markers) {
      ring.position.y = bob;
      ring.rotation.z = ts / 900;
      ring.visible = !myMission;
    }
    if (myMission) {
      gl.beacon.visible = true;
      gl.beacon.position.x = myMission[4];
      gl.beacon.position.z = myMission[5];
      gl.beacon.material.opacity = 0.24 + Math.sin(ts / 300) * 0.1;
    } else gl.beacon.visible = false;

    stepFx(now);

    /* camera: glued behind whatever you are */
    const focus = predCar ? { x: predCar.x, y: predCar.y, yaw: predCar.yaw }
      : me ? { x: me.x, y: me.y, yaw: me.yaw } : { x: 1540, y: 900, yaw: Math.PI / 2 };
    camYaw += shortest(camYaw, focus.yaw) * (1 - Math.exp(-dt * (predCar ? 0.004 : 0.003)));
    const back = predCar ? 210 : 140, up = predCar ? 105 : 80;
    const dx = Math.cos(camYaw), dy = Math.sin(camYaw);
    const target = new THREE.Vector3(focus.x - dx * back, up, focus.y - dy * back);
    gl.camPos.lerp(target, 1 - Math.exp(-dt * 0.008));
    gl.camera.position.copy(gl.camPos);
    gl.camera.lookAt(focus.x + dx * 50, 16, focus.y + dy * 50);

    gl.renderer.render(gl.scene, gl.camera);
    drawMinimap();
  }

  function animateLegs(mesh, e, dt, forcedMoving) {
    const moving = forcedMoving ?? (Math.abs(e.tx - e.fx) + Math.abs(e.ty - e.fy) > 0.5);
    const u = mesh.userData;
    if (moving) u.phase += dt * 0.02;
    const swing = moving ? Math.sin(u.phase) * 0.7 : 0;
    u.legs[0].rotation.z = swing;
    u.legs[1].rotation.z = -swing;
  }

  /* ============================== minimap ============================== */

  function buildMinimapBase() {
    const k = 200 / CITY.WORLD_W;
    const c = document.createElement('canvas');
    c.width = 200; c.height = Math.round(CITY.WORLD_H * k);
    const x = c.getContext('2d');
    x.fillStyle = '#272b31';
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#40464d';
    for (const r of CITY.ROADS) x.fillRect(r.x * k, r.y * k, r.w * k, r.h * k);
    x.fillStyle = '#2e5f86';
    for (const w of CITY.WATER) x.fillRect(w.x * k, w.y * k, w.w * k, w.h * k);
    x.fillStyle = '#40464d';
    for (const b of CITY.BRIDGES) x.fillRect(b.x * k, CITY.RIVER.y * k, b.w * k, CITY.RIVER.h * k);
    for (const b of CITY.BLOCKS) {
      x.fillStyle = b.kind === 'park' || b.kind === 'trinity' ? '#2f5b40' : '#31363f';
      x.fillRect(b.x * k, b.y * k, b.w * k, b.h * k);
    }
    mapBase = c;
  }

  function drawMinimap() {
    const canvas = el('minimap');
    if (!canvas || !mapBase) return;
    const x = canvas.getContext('2d');
    const k = 200 / CITY.WORLD_W;
    x.clearRect(0, 0, canvas.width, canvas.height);
    x.drawImage(mapBase, 0, 0);

    const dot = (wx, wy, color, r = 3) => {
      x.fillStyle = color;
      x.beginPath();
      x.arc(wx * k, wy * k, r, 0, Math.PI * 2);
      x.fill();
    };

    if (myMission) dot(myMission[4], myMission[5], '#ffc53d', 4);
    else for (const d of CITY.MISSION_DEFS) dot(d.marker.x, d.marker.y, '#ffc53d', 2.5);

    for (const [, e] of carEnts) {
      if (e.kind === 1 && !e.dead) dot(e.x, e.y, Math.floor(performance.now() / 260) % 2 ? '#3d7dff' : '#e5484d', 3);
      if (e.kind === 2 && !e.dead) dot(e.x, e.y, '#ff7b3b', 3);
    }
    for (const [i, e] of plEnts) {
      if (e.alive) dot(e.x, e.y, R.COLOR_HEX[view.seats[i]?.color] || '#888', 3);
    }

    const sx = (predCar ? predCar.x : me?.x ?? 0) * k;
    const sy = (predCar ? predCar.y : me?.y ?? 0) * k;
    const yaw = predCar ? predCar.yaw : me?.yaw ?? 0;
    x.save();
    x.translate(sx, sy);
    x.rotate(yaw + Math.PI / 2);
    x.fillStyle = '#fff';
    x.beginPath();
    x.moveTo(0, -6); x.lineTo(4, 4); x.lineTo(-4, 4);
    x.closePath();
    x.fill();
    x.restore();
  }

  /* ============================== HUD ============================== */

  function drawHUD() {
    if (view?.phase !== 'playing' || !root.querySelector('.hud')) return;

    if (myRow) {
      el('money').textContent = '$' + (myRow[8] ?? 0).toLocaleString();
      const stars = el('stars').children;
      for (let i = 0; i < 5; i++) stars[i].classList.toggle('lit', i < myRow[5]);
      el('hpfill').style.width = Math.max(0, myRow[4]) + '%';
      el('wasted').hidden = myRow[6] === 1;
    }

    const mb = el('missionbox');
    if (myMission) {
      const def = CITY.MISSION_DEFS[myMission[1]];
      mb.hidden = false;
      el('mname').textContent = def.name;
      el('mline').textContent =
        def.kind === 'delivery' ? 'Deliver to Trinity front gate.' :
        def.kind === 'fetch' ? `Parcels left: ${myMission[3]}` :
        'Wreck the joyrider’s car.';
      el('mtime').textContent = myMission[2] + 's';
    } else mb.hidden = true;

    renderPrompts();

    const board = el('scores');
    if (showScores && myRow) {
      board.hidden = false;
      board.innerHTML = '<div class="shead">Leaderboard</div>' + scoreRows();
    } else board.hidden = true;
  }

  function scoreRows() {
    return [...lastSnapshotPl]
      .sort((a, b) => b[8] - a[8])
      .map((row) => {
        const s = view.seats[row[0]];
        return `<div class="srow"><span class="chip" style="background:${R.COLOR_HEX[s?.color] || '#888'}"></span>` +
          `<span class="nm">${esc(s?.name || '?')}${row[0] === mySeat() ? ' (you)' : ''}</span>` +
          `<span class="cash">$${row[8].toLocaleString()}</span>` +
          `<span class="kd">${row[9]}/${row[10]}</span></div>`;
      }).join('');
  }

  function renderPrompts() {
    const box = el('prompts');
    if (!box) return;
    const out = [];
    const pos = predCar ?? me;

    if (myRow?.[6] === 1 && pos) {
      if (myCarId >= 0) {
        out.push(['E', 'Get out', 'go']);
      } else {
        if (!myMission) {
          for (const def of CITY.MISSION_DEFS) {
            if (dist2(pos, def.marker) < R.MARKER_RANGE ** 2) { out.push(['E', `Job: ${def.name}`, 'go']); break; }
          }
        }
        if (!out.length) {
          let best = null, bd = R.ENTER_RANGE ** 2;
          for (const [, e] of carEnts) {
            if (e.dead || e.kind === 2 || e.driverSeat >= 0) continue;
            const d = dist2(pos, e);
            if (d < bd) { best = e; bd = d; }
          }
          if (best) out.push(['E', best.driverSeat === -2 ? 'Carjack' : 'Steal car', 'danger']);
        }
      }
    }
    box.innerHTML = out.map(([k, label, cls]) =>
      `<div class="prompt ${cls}"><kbd>${esc(k)}</kbd>${esc(label)}</div>`).join('');
  }

  const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

  /* ============================== panels ============================== */

  function render() {
    if (!view) return;
    if (view.phase === 'lobby') { renderWait(); return; }
    const feed = el('feed');
    if (feed) {
      feed.innerHTML = (view.log || []).slice(-6).map((l) => `<div>${esc(l)}</div>`).join('');
    }
  }

  function renderWait() {
    if (!root.querySelector('.codeval')) root.innerHTML = WAIT_HTML;
    el('codeval').textContent = view.code;

    el('seats').innerHTML = view.seats.map((s) => `
      <li class="${s.connected ? '' : 'gone'}">
        <div class="chip" style="background:${R.COLOR_HEX[s.color]}"></div>
        <div class="nm">${esc(s.name)}</div>
        <div class="badge">${s.id === view.hostId ? 'host' : ''}${s.id === selfId ? ' · you' : ''}</div>
      </li>`).join('');

    const isHost = selfId === view.hostId;
    const startBtn = el('start');
    startBtn.hidden = !isHost;
    startBtn.onclick = () => intent({ t: 'start' });
    el('starthint').textContent = isHost
      ? (view.seats.length === 1 ? 'Solo run — or wait for the crew.' : `${view.seats.length} ready to cause trouble.`)
      : 'Waiting for the host to start…';

    const copy = el('copy');
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(view.code);
        copy.textContent = 'Copied!';
      } catch {
        copy.textContent = 'Press Ctrl+C';
      }
      setTimeout(() => { copy.textContent = 'Copy code'; }, 1400);
    };
  }

  /* ========================= tab lifecycle ========================= */

  function onShow() {
    active = true;
    if (view?.phase === 'playing' && gl) startRender();
  }

  function onHide() {
    active = false;
    releaseAll();
    stopRender();
  }

  gta.onShow = onShow;
  gta.onHide = onHide;

  const shortest = (from, to) => {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };

  showLobby();
}

const gta = { id: GAME, title: 'GTA 7: Dublin', init };

export default gta;
