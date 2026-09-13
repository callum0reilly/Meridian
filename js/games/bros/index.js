// Meridian Bros — lobby, network, run loop, and the canvas the worlds are
// drawn on.
//
// ---- Authority ----
//
// Star topology like every room game here, but the split is different — see
// the note at the top of rules.js. Each browser simulates its own hero at
// 60Hz and reports position; the host simulates the enemies, referees every
// shared claim (coins, blocks, stomps, the flag), and broadcasts:
//
//   20/sec  {t:'s'}     positions: every hero, every living enemy
//   on change {t:'room'} structure: seats, characters, world, scores,
//                        what's collected, who cleared
//
// There is nothing hidden, so everyone gets the same view and the room push
// is one object broadcast whole. A claim the host rejects (two players, same
// coin, same tick) simply doesn't appear in the next push, and the loser's
// optimistic local copy is overwritten. Nobody notices; that's the point.
//
// ---- Other players ----
//
// Rendered one snapshot behind, eased between the last two known positions —
// the same interpolation trick as Impostor. Your own hero never waits on the
// network at all.

import { createRoom, joinRoom, normaliseCode } from '../../net.js';
import {
  TILE, ROWS, WORLDS, WORLD_BY_ID, parseWorld, tileAt,
  STEP_MS, TICK_MS, TICK_HZ, MIN_PLAYERS, MAX_PLAYERS,
  CHARACTERS, CHAR_IDS, PLAYER_W, PLAYER_H, ENEMY,
  RESPAWN_STEPS, STOMP_BOUNCE, BUFF_STEPS,
  makeBody, stepPlayer, kill, hurt, respawn, eatPickup, hasBuff,
  collectCoins, collectGems, collectPickups, touchCheckpoint, touchFlag,
  stepEnemy, hitEnemy,
  createRun, applyCoin, applyBump, applyGem, applyPickup, applyStomp, applyDeath, applyFlag,
  nextWorldId,
} from './rules.js';
import { sfx, unlock as unlockAudio, isMuted, setMuted } from './sfx.js';

const GAME = 'bros';

/* ---- view ---- */
const VIEW_W = 960;
const VIEW_H = ROWS * TILE;   // 544 — the level is exactly one screen tall

/** How far behind the newest snapshot remote things are drawn, in ms. */
const INTERP_MS = 80;
/** Most 60Hz sim steps paid back in one go after a slow frame. */
const MAX_CATCHUP = 4;
/** Most 60Hz enemy steps the host runs per 20Hz network tick backlog. */
const MAX_TICK_CATCHUP = 3;

const LOBBY_HTML = `
  <div class="lobby">
    <div class="lobby-card">
      <h2>Meridian Bros</h2>
      <div class="lead">A co-op platformer. Create a room and share the code,
        or enter a friend's code to join. 1–${MAX_PLAYERS} players — run right,
        stomp trouble, grab the flag together.</div>

      <div class="field">
        <label for="bros-name">Your name</label>
        <input id="bros-name" class="name" maxlength="12" placeholder="Nickname" autocomplete="off">
      </div>

      <button class="primary create">Create a room</button>

      <div class="or">or</div>

      <div class="field">
        <label for="bros-code">Room code</label>
        <div class="row">
          <input id="bros-code" class="code-input codein" maxlength="5" placeholder="ABC12"
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
    <div class="lobby-card wide">
      <h2>Pick your hero</h2>
      <div class="lead">Share the code, choose characters, and the host picks
        the world. First come, first served on heroes.</div>
      <div class="code-display">
        <div class="cap">Room code</div>
        <div class="code codeval"></div>
        <button class="copy">Copy code</button>
      </div>

      <div class="chargrid"></div>

      <div class="subhead">World</div>
      <div class="worldrow"></div>

      <div class="subhead">Party</div>
      <ul class="seats"></ul>

      <button class="primary start">Start game</button>
      <div class="hint starthint"></div>
      <div class="err waiterr"></div>
    </div>
  </div>
`;

const GAME_HTML = `
  <div class="table bros">
    <div class="stage">
      <div class="screen">
        <canvas class="board" width="${VIEW_W}" height="${VIEW_H}" aria-label="The level"></canvas>
        <div class="banner" hidden></div>
        <div class="modal" hidden></div>
      </div>
    </div>
    <aside>
      <div class="loghead">How to play</div>
      <ul class="keys">
        <li><kbd>A</kbd><kbd>D</kbd><span>or ◀ ▶ — run</span></li>
        <li><kbd>W</kbd><span>/ <kbd>Space</kbd> — jump; hold it to jump higher</span></li>
        <li><kbd>S</kbd><span>drop through thin platforms</span></li>
      </ul>
      <div class="blurb">Land on the round ones. Never land on the spiky ones.
        Bump <b>?</b> blocks for coins and <b>@</b> blocks for a heart shard —
        one free hit. Springs launch you. Find the three gems. The flag ends
        the level for everyone; the team shares its lives, and every 20 coins
        earns one back.</div>
      <div class="loghead">World</div>
      <div class="worldinfo"></div>
      <div class="loghead">Party</div>
      <ul class="party"></ul>
    </aside>
  </div>
`;

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function init(root, header) {
  let room = null;         // net.js Room
  let state = null;        // host only: seats + world + the current run
  let view = null;         // what everyone renders from — the last room push
  let selfId = null;
  let myName = 'Player';

  /* ---- the local model of the level ---- */
  let lv = null;           // parsed level (every machine parses its own copy)
  let body = null;         // my hero — simulated here, reported to the host
  let collected = null;    // Set of coin indexes (view + optimistic)
  let gems = null;         // Set of gem indexes
  let taken = null;        // Set of pickup indexes
  let used = null;         // Set of "tx,ty" spent ?/@ blocks (view + optimistic)
  let flagSent = false;
  let livesSeen = null;    // last lives count, to spot a 1-up in a room push
  let checkpointAt = null; // x of my active checkpoint, for drawing it lit

  let ents = new Map();    // seat -> interp entity for OTHER players
  let foes = new Map();    // enemy index -> interp entity
  let fx = [];             // transient sparkles/squashes/coin pops
  let banner = null;       // { text, until }
  let shake = 0;           // frames of screen shake left

  /* ---- loops ---- */
  let raf = null;
  let lastTs = 0;
  let acc = 0;
  let simTimer = null;     // host: enemy sim + snapshot clock
  let simLast = 0;
  let simAcc = 0;
  let active = false;

  /* ---- input ---- */
  const keys = new Set();
  let jumpQueued = false;
  let lastSend = 0;
  let cam = 0;

  const el = (sel) => root.querySelector('.' + sel);
  let canvas = null, ctx = null;

  header.innerHTML = '<div class="tag brostag">Run right. Grab the flag.</div>' +
                     '<button class="mute" title="Toggle sound"></button>' +
                     '<button class="leave" hidden>Leave room</button>';
  const leaveBtn = header.querySelector('.leave');
  const muteBtn = header.querySelector('.mute');
  const paintMute = () => { muteBtn.textContent = isMuted() ? 'Sound off' : 'Sound on'; };
  paintMute();
  muteBtn.onclick = () => { unlockAudio(); setMuted(!isMuted()); paintMute(); if (!isMuted()) sfx.coin(); };
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
    lv = null; body = null; collected = null; gems = null; taken = null; used = null;
    ents = new Map(); foes = new Map(); fx = []; banner = null;
    keys.clear(); jumpQueued = false;
    leaveBtn.hidden = true;
  }

  /* ============================== lobby ============================== */

  function showLobby(err) {
    root.innerHTML = LOBBY_HTML;
    canvas = null; ctx = null;
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
          phase: 'wait',
          code: room.code,
          hostId: selfId,
          world: WORLDS[0].id,
          seats: [{ id: selfId, name: myName, char: null, connected: true }],
          run: null,
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
          '<h2>Joining…</h2><div class="lead">Connected. Waiting for the host.</div>' +
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

  // One path for every action, the host's own included.
  function intent(msg) {
    if (room?.isHost) onHostMessage(msg, selfId);
    else room?.send(null, msg);
  }

  const seatOf = (id) => state ? state.seats.findIndex((s) => s.id === id) : -1;

  function onJoin(peerId) {
    if (state.phase !== 'wait') {
      room.send(peerId, { t: 'denied', msg: 'That game has already started.' });
    } else if (state.seats.length >= MAX_PLAYERS) {
      room.send(peerId, { t: 'denied', msg: `That room is full (${MAX_PLAYERS} players).` });
    }
  }

  function onLeave(peerId) {
    if (!state) return;
    const i = seatOf(peerId);
    if (i < 0) return;
    if (state.phase === 'wait') {
      state.seats.splice(i, 1);
    } else {
      state.seats[i].connected = false;
      poses.delete(i);
    }
    pushRoom();
  }

  const poses = new Map();   // seat -> [x, y, face, moving, dead] latest report

  function onHostMessage(msg, fromId) {
    if (!state) return;
    const seat = seatOf(fromId);

    if (msg.t === 'hello') {
      if (state.phase !== 'wait') { room.send(fromId, { t: 'denied', msg: 'That game has already started.' }); return; }
      if (seat >= 0) return;
      if (state.seats.length >= MAX_PLAYERS) { room.send(fromId, { t: 'denied', msg: `That room is full (${MAX_PLAYERS} players).` }); return; }
      state.seats.push({
        id: fromId,
        name: String(msg.name || 'Player').trim().slice(0, 12) || 'Player',
        char: null,
        connected: true,
      });
      pushRoom();
      return;
    }

    if (seat < 0) return;

    if (msg.t === 'char') {
      if (state.phase !== 'wait' || !CHARACTERS[msg.c]) return;
      if (state.seats.some((s, i) => i !== seat && s.char === msg.c)) return;  // taken
      state.seats[seat].char = msg.c;
      pushRoom();
      return;
    }

    if (msg.t === 'world') {
      if (fromId !== state.hostId || state.phase !== 'wait' || !WORLD_BY_ID.has(msg.w)) return;
      state.world = msg.w;
      pushRoom();
      return;
    }

    if (msg.t === 'start') {
      if (fromId !== state.hostId || state.phase !== 'wait') return;
      if (state.seats.length < MIN_PLAYERS || !state.seats.every((s) => s.char)) return;
      beginRun(state.world);
      return;
    }

    if (msg.t === 'again') {
      if (fromId !== state.hostId || (state.phase !== 'clear' && state.phase !== 'over')) return;
      if (msg.mode === 'room') {
        state.phase = 'wait';
        state.run = null;
        poses.clear();
        stopSim();
        pushRoom();
      } else {
        beginRun(msg.mode === 'next' ? nextWorldId(state.run.worldId) : state.run.worldId);
      }
      return;
    }

    const run = state.run;
    if (!run || state.phase !== 'play') return;

    // Position reports flow constantly and never trigger a room push — the
    // snapshot carries them.
    if (msg.t === 'p') {
      poses.set(seat, [+msg.x || 0, +msg.y || 0, msg.f === -1 ? -1 : 1, msg.m ? 1 : 0, msg.d ? 1 : 0, msg.h ? 1 : 0]);
      return;
    }

    if (msg.t === 'coin') { if (applyCoin(run, seat, msg.i)) pushRoom(); return; }
    if (msg.t === 'gem') { if (applyGem(run, seat, msg.i)) pushRoom(); return; }
    if (msg.t === 'pow') { if (applyPickup(run, seat, msg.i)) pushRoom(); return; }
    if (msg.t === 'bump') { if (applyBump(run, seat, +msg.bx, +msg.by)) pushRoom(); return; }
    if (msg.t === 'stomp') { if (applyStomp(run, seat, msg.i)) pushRoom(); return; }
    if (msg.t === 'die') {
      if (applyDeath(run, seat)) {
        if (run.over) { state.phase = 'over'; stopSim(); }
        pushRoom();
      }
      return;
    }
    if (msg.t === 'flag') {
      if (applyFlag(run, seat)) {
        state.phase = 'clear';
        stopSim();
        pushRoom();
      }
    }
  }

  function beginRun(worldId) {
    state.world = worldId;
    state.run = createRun(worldId, state.seats.length);
    state.phase = 'play';
    poses.clear();
    startSim();
    pushRoom();
  }

  /* ---- pushes and snapshots ---- */

  function roomView() {
    const run = state.run;
    return {
      phase: state.phase,
      code: state.code,
      hostId: state.hostId,
      world: state.world,
      seats: state.seats.map((s) => ({ id: s.id, name: s.name, char: s.char, connected: s.connected })),
      run: run ? {
        worldId: run.worldId,
        scores: run.scores,
        collected: [...run.collected],
        gems: [...run.gems],
        taken: [...run.taken],
        used: [...run.used],
        deadEnemies: run.enemies.filter((e) => !e.alive).map((e) => e.i),
        clearBy: run.clearBy,
        lives: run.lives,
        over: run.over,
      } : null,
    };
  }

  function pushRoom() {
    if (!room?.isHost) return;
    const msg = { t: 'room', room: roomView() };
    room.broadcast(msg);
    applyRoom(msg.room);
  }

  function pushSnapshot() {
    if (!room?.isHost || !state.run) return;
    // My own hero goes in the same pool as everyone's — hosting earns nothing.
    if (body) poses.set(seatOf(selfId), [Math.round(body.x), Math.round(body.y), body.face, Math.abs(body.vx) > 0.3 ? 1 : 0, body.dead ? 1 : 0, body.hp > 1 ? 1 : 0]);
    const snap = {
      t: 's',
      p: [...poses.entries()].map(([seat, p]) => [seat, ...p]),
      e: state.run.enemies.filter((e) => e.alive)
        .map((e) => [e.i, Math.round(e.x), Math.round(e.y), e.dir]),
    };
    room.broadcast(snap);
    applySnapshot(snap);
  }

  /* ---- host clock: enemies + snapshots ----
     A timer, not rAF: the host backgrounding its tab must slow the world,
     not stop it. Enemy physics still advances in 60Hz steps — three of them
     per 20Hz tick — so it matches what rules.js was tuned on. */

  function startSim() {
    if (!room?.isHost || simTimer !== null) return;
    simLast = performance.now();
    simAcc = 0;
    simTimer = setInterval(() => {
      const now = performance.now();
      simAcc += now - simLast;
      simLast = now;
      let ticks = 0;
      while (simAcc >= TICK_MS && ticks < MAX_TICK_CATCHUP) {
        simAcc -= TICK_MS;
        ticks += 1;
        for (let i = 0; i < 3; i++) {
          for (const e of state.run.enemies) stepEnemy(e, state.run.lv);
        }
      }
      if (simAcc >= TICK_MS * MAX_TICK_CATCHUP) simAcc = 0;
      if (ticks) pushSnapshot();
    }, TICK_MS);
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
    showLobby('The host left, so the room closed. Rooms live in the host\'s browser tab.');
  }

  function onNetError(err) {
    const target = root.querySelector('.lobbyerr') || root.querySelector('.waiterr');
    if (target) target.textContent = err.message;
    else console.error('[bros] net error', err);
  }

  const mySeat = () => view ? view.seats.findIndex((s) => s.id === selfId) : -1;

  function applyRoom(next) {
    const prevPhase = view?.phase;
    view = next;

    if (view.phase === 'play' && prevPhase !== 'play') startPlay();

    if ((view.phase === 'play' || view.phase === 'over') && view.run && lv) {
      // Merge the host's word on shared progress over our optimistic copy.
      // Anything new here was someone else's doing — a coin vanishing across
      // the map is a teammate earning their keep.
      for (const i of view.run.collected) collected.add(i);
      for (const i of view.run.gems) gems.add(i);
      for (const i of view.run.taken) taken.add(i);
      for (const key of view.run.used) {
        if (!used.has(key)) {
          used.add(key);
          const [tx, ty] = key.split(',').map(Number);
          addFx(tileAt(lv, tx, ty) === '@' ? 'heartpop' : 'coinpop', tx * TILE + TILE / 2, ty * TILE);
        }
      }
      for (const i of view.run.deadEnemies) {
        const f = foes.get(i);
        if (f && !f.dying) { addFx('squash', f.x, f.y); foes.delete(i); }
      }
      if (livesSeen !== null && view.run.lives > livesSeen) { say('1-UP!'); sfx.oneUp(); }
      livesSeen = view.run.lives;
    }

    if (view.phase === 'over' && prevPhase === 'play') { sfx.gameOver(); releaseAll(); }
    if (view.phase === 'clear' && prevPhase === 'play') sfx.flag();

    if (view.phase === 'wait') stopRender();

    render();
  }

  function startPlay() {
    const seat = mySeat();
    const me = view.seats[seat];
    lv = parseWorld(WORLD_BY_ID.get(view.run.worldId));
    body = makeBody(lv, me?.char, seat);
    collected = new Set(view.run.collected);
    gems = new Set(view.run.gems);
    taken = new Set(view.run.taken);
    used = new Set(view.run.used);
    flagSent = false;
    livesSeen = view.run.lives;
    checkpointAt = null;
    ents = new Map();
    foes = new Map();
    fx = [];
    banner = null;
    cam = 0;
    keys.clear();
    jumpQueued = false;
    root.innerHTML = GAME_HTML;
    canvas = el('board');
    ctx = canvas.getContext('2d');
    startRender();
  }

  function applySnapshot(s) {
    if (!view?.run) return;
    const now = performance.now();
    const seat = mySeat();
    const seen = new Set();

    for (const [st, x, y, f, m, d, h] of s.p) {
      if (st === seat) continue;         // my hero is mine; the echo is stale
      seen.add(st);
      const e = ents.get(st);
      if (!e) {
        ents.set(st, { x, y, fx: x, fy: y, tx: x, ty: y, t0: now, f, m, d, h });
        continue;
      }
      e.fx = e.x; e.fy = e.y;
      e.tx = x; e.ty = y;
      e.t0 = now;
      e.f = f; e.m = m; e.d = d; e.h = h;
    }
    for (const st of [...ents.keys()]) if (st !== seat && !seen.has(st)) ents.delete(st);

    const alive = new Set();
    for (const [i, x, y, dir] of s.e) {
      alive.add(i);
      const f = foes.get(i);
      if (!f) {
        foes.set(i, { i, x, y, fx: x, fy: y, tx: x, ty: y, t0: now, dir, type: lv.enemies[i]?.type || 'walker' });
        continue;
      }
      f.fx = f.x; f.fy = f.y;
      f.tx = x; f.ty = y;
      f.t0 = now;
      f.dir = dir;
    }
    for (const [i, f] of [...foes.entries()]) {
      if (!alive.has(i)) { addFx('squash', f.x, f.y); foes.delete(i); }
    }
  }

  /* ============================== input ============================== */

  const LEFT = new Set(['a', 'arrowleft']);
  const RIGHT = new Set(['d', 'arrowright']);
  const JUMP = new Set(['w', 'arrowup', ' ']);
  const DOWN = new Set(['s', 'arrowdown']);

  function onKeyDown(ev) {
    if (!active || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (view?.phase !== 'play') return;
    unlockAudio();
    const k = ev.key.toLowerCase();
    if (LEFT.has(k) || RIGHT.has(k) || JUMP.has(k) || DOWN.has(k)) {
      // Space scrolls and arrows pan — ruinous mid-jump. Only swallowed once
      // the key is known to be ours.
      ev.preventDefault();
      if (JUMP.has(k) && !keys.has(k)) jumpQueued = true;
      keys.add(k);
    }
  }

  function onKeyUp(ev) { keys.delete(ev.key.toLowerCase()); }

  const releaseAll = () => { keys.clear(); };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);

  const has = (set) => { for (const k of set) if (keys.has(k)) return true; return false; };

  /* ============================== my hero ============================== */

  function stepLocal() {
    if (!body || view?.phase !== 'play') return;

    const input = {
      left: has(LEFT),
      right: has(RIGHT),
      jump: jumpQueued,
      held: has(JUMP),
      down: has(DOWN),
    };
    jumpQueued = false;

    const wasDead = body.dead;
    const hadBuff = body.buff;
    const ev = stepPlayer(body, input, lv);

    if (ev.jumped) sfx.jump();
    if (ev.landed) { sfx.land(); addFx('dust', body.x, body.y + PLAYER_H / 2); }
    if (ev.spring) { sfx.spring(); addFx('dust', body.x, body.y + PLAYER_H / 2); }
    if (hadBuff && !body.buff && !body.dead) sfx.buffEnd();

    if (ev.bump) {
      const key = ev.bump.tx + ',' + ev.bump.ty;
      const ch = tileAt(lv, ev.bump.tx, ev.bump.ty);
      if ((ch === '?' || ch === '@') && !used.has(key)) {
        used.add(key);
        addFx(ch === '@' ? 'heartpop' : 'coinpop', ev.bump.tx * TILE + TILE / 2, ev.bump.ty * TILE);
        intent({ t: 'bump', bx: ev.bump.tx, by: ev.bump.ty });
      }
      sfx.bump();
    }

    if (ev.hurt) { say('Lost your shard!'); sfx.hurt(); shake = 6; }

    if (ev.dead && !wasDead) died(ev.dead === 'pit' ? 'Long way down…' : 'Ouch!');

    if (!body.dead) {
      for (const i of collectCoins(body, lv, collected)) {
        collected.add(i);
        addFx('sparkle', lv.coins[i].x, lv.coins[i].y);
        sfx.coin();
        intent({ t: 'coin', i });
      }
      for (const i of collectGems(body, lv, gems)) {
        gems.add(i);
        addFx('gemburst', lv.gems[i].x, lv.gems[i].y);
        sfx.gem();
        say(`Gem ${gems.size} of ${lv.gems.length}!`);
        intent({ t: 'gem', i });
      }
      for (const i of collectPickups(body, lv, taken, used)) {
        taken.add(i);
        const p = lv.pickups[i];
        eatPickup(body, p.type);
        addFx('sparkle', p.x, p.y);
        if (p.type === 'heart') { sfx.heart(); say('Heart shard — one free hit!'); }
        else { sfx.powerup(); say({ speed: 'Speed surge!', ward: 'Spike ward!', magnet: 'Coin magnet!' }[p.type]); }
        intent({ t: 'pow', i });
      }

      const cp = touchCheckpoint(body, lv);
      if (cp && body.cx !== cp.x) {
        body.cx = cp.x;
        body.cy = cp.y;
        checkpointAt = cp.x;
        say('Checkpoint!');
        sfx.checkpoint();
      }

      // Enemies live where the host last said they were — a whisker behind
      // the truth, which for a co-op game is close enough to land on.
      for (const f of foes.values()) {
        const verdict = hitEnemy(body, { type: f.type, x: f.x, y: f.y, alive: true });
        if (verdict === 'stomp') {
          body.vy = STOMP_BOUNCE;
          addFx('squash', f.x, f.y);
          foes.delete(f.i);
          sfx.stomp();
          intent({ t: 'stomp', i: f.i });
        } else if (verdict === 'hurt') {
          const res = hurt(body);
          if (res === 'dead') died('Ouch!');
          else if (res === 'shard') { say('Lost your shard!'); sfx.hurt(); shake = 6; }
          break;
        }
      }

      if (!flagSent && touchFlag(body, lv)) {
        flagSent = true;
        intent({ t: 'flag' });
      }
    } else if (body.deadT > RESPAWN_STEPS) {
      respawn(body);
    }
  }

  function died(text) {
    say(text);
    sfx.die();
    shake = 10;
    intent({ t: 'die' });
  }

  function sendPos(ts) {
    if (!body || view?.phase !== 'play' || ts - lastSend < TICK_MS) return;
    lastSend = ts;
    intent({
      t: 'p',
      x: Math.round(body.x), y: Math.round(body.y),
      f: body.face,
      m: Math.abs(body.vx) > 0.3 ? 1 : 0,
      d: body.dead ? 1 : 0,
      h: body.hp > 1 ? 1 : 0,
    });
  }

  /* ============================== the loop ============================== */

  function startRender() {
    if (raf !== null) return;
    lastTs = 0;
    acc = 0;
    raf = requestAnimationFrame(frame);
  }

  function stopRender() {
    if (raf === null) return;
    cancelAnimationFrame(raf);
    raf = null;
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    const dt = lastTs ? Math.min(200, ts - lastTs) : 0;
    lastTs = ts;
    acc += dt;

    let n = 0;
    while (acc >= STEP_MS && n < MAX_CATCHUP) {
      acc -= STEP_MS;
      n += 1;
      stepLocal();
    }
    if (acc >= STEP_MS * MAX_CATCHUP) acc = 0;

    sendPos(ts);
    draw(ts);
  }

  /* ============================== drawing ============================== */

  const lerpAt = (e) => Math.min(1, (performance.now() - e.t0) / INTERP_MS);
  const lerpX = (e) => { const k = lerpAt(e); e.x = e.fx + (e.tx - e.fx) * k; return e.x; };
  const lerpY = (e) => { const k = lerpAt(e); e.y = e.fy + (e.ty - e.fy) * k; return e.y; };

  function addFx(type, x, y) {
    fx.push({ type, x, y, t0: performance.now() });
  }

  function draw(ts) {
    if (!ctx || !lv) return;
    const pal = lv.world.palette;

    // Camera chases the hero, clamped to the level, eased so a respawn pans
    // rather than teleports the world.
    const target = Math.max(0, Math.min(lv.w * TILE - VIEW_W, (body?.x || 0) - VIEW_W * 0.42));
    cam += (target - cam) * 0.12;
    if (Math.abs(target - cam) < 0.5) cam = target;

    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    sky.addColorStop(0, pal.sky[0]);
    sky.addColorStop(1, pal.sky[1]);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    drawHills(pal.hillFar, 0.25, 210, 90, ts);
    drawHills(pal.hillNear, 0.5, 150, 130, ts);
    if (lv.world.id === 'frost') drawSnow(ts);

    ctx.save();
    let sx = 0, sy = 0;
    if (shake > 0) {
      shake -= 1;
      sx = (Math.random() - 0.5) * shake * 1.2;
      sy = (Math.random() - 0.5) * shake * 1.2;
    }
    ctx.translate(-Math.round(cam) + sx, sy);

    drawTiles(ts, pal);
    drawCheckpoints(ts, pal);
    drawFlag(ts, pal);
    drawCoins(ts);
    drawGems(ts);
    drawPickups(ts);
    for (const f of foes.values()) drawEnemy(f, lerpX(f), lerpY(f), ts);
    for (const [seat, e] of ents) {
      drawHero(lerpX(e), lerpY(e), e.f, !!e.m, !!e.d, view.seats[seat], false, ts, { shard: !!e.h });
    }
    if (body) {
      drawHero(body.x, body.y, body.face, Math.abs(body.vx) > 0.3, body.dead, view.seats[mySeat()], true, ts,
        { shard: body.hp > 1, buff: body.buff?.type, vx: body.vx });
    }
    drawFx(ts);

    ctx.restore();

    drawHud(ts);
    drawBanner(ts);
  }

  /** Distant scenery: a row of round humps sliding at a fraction of the
   *  camera. Two layers of these are all "depth" ever costs. */
  function drawHills(color, factor, spacing, height, ts) {
    ctx.fillStyle = color;
    const off = cam * factor;
    const first = Math.floor(off / spacing) - 1;
    for (let i = first; i < first + Math.ceil(VIEW_W / spacing) + 2; i++) {
      const x = i * spacing - off;
      const h = height * (0.7 + 0.3 * Math.abs(Math.sin(i * 12.9898)));
      ctx.beginPath();
      ctx.ellipse(x, VIEW_H, spacing * 0.75, h, 0, Math.PI, 0);
      ctx.fill();
    }
  }

  function drawSnow(ts) {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (let i = 0; i < 40; i++) {
      const speed = 20 + (i % 5) * 9;
      const x = (i * 137.5 + ts * 0.02 * (1 + i % 3)) % (VIEW_W + 20) - 10;
      const y = (i * 89.3 + ts * 0.001 * speed * 30) % (VIEW_H + 20) - 10;
      ctx.fillRect(x, y, 2 + (i % 2), 2 + (i % 2));
    }
  }

  function drawTiles(ts, pal) {
    const tx0 = Math.max(0, Math.floor(cam / TILE) - 1);
    const tx1 = Math.min(lv.w - 1, tx0 + Math.ceil(VIEW_W / TILE) + 2);
    for (let ty = 0; ty < lv.h; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const ch = lv.grid[ty][tx];
        if (ch === '.') continue;
        const x = tx * TILE, y = ty * TILE;

        if (ch === '#') {
          ctx.fillStyle = pal.ground;
          ctx.fillRect(x, y, TILE, TILE);
          ctx.fillStyle = pal.groundDark;
          ctx.fillRect(x + 2, y + 10, 6, 5);
          ctx.fillRect(x + 18, y + 22, 8, 5);
          if (tileAt(lv, tx, ty - 1) === '.') {
            ctx.fillStyle = pal.groundTop;
            ctx.fillRect(x, y, TILE, 7);
          }
        } else if (ch === 'B') {
          ctx.fillStyle = pal.brick;
          ctx.fillRect(x, y, TILE, TILE);
          ctx.strokeStyle = pal.brickDark;
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
          ctx.beginPath();
          ctx.moveTo(x, y + TILE / 2); ctx.lineTo(x + TILE, y + TILE / 2);
          ctx.moveTo(x + TILE / 2, y); ctx.lineTo(x + TILE / 2, y + TILE / 2);
          ctx.moveTo(x + TILE / 4, y + TILE / 2); ctx.lineTo(x + TILE / 4, y + TILE);
          ctx.moveTo(x + 3 * TILE / 4, y + TILE / 2); ctx.lineTo(x + 3 * TILE / 4, y + TILE);
          ctx.stroke();
        } else if (ch === '?' || ch === '@') {
          const spent = used.has(tx + ',' + ty);
          ctx.fillStyle = spent ? pal.blockDead : ch === '@' ? '#ff6b9a' : pal.block;
          ctx.fillRect(x, y, TILE, TILE);
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
          if (!spent) {
            const lift = Math.sin(ts / 260 + tx) * 1.5;
            ctx.fillStyle = ch === '@' ? '#7a1f3a' : '#7a4a00';
            ctx.font = 'bold 20px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(ch === '@' ? '♥' : '?', x + TILE / 2, y + TILE / 2 + 1 + lift);
          } else {
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.fillRect(x + TILE / 2 - 3, y + TILE / 2 - 3, 6, 6);
          }
        } else if (ch === '!') {
          // A coil on a base plate; the coil squashes when someone is on it.
          const pressed = body && !body.dead && Math.abs(body.x - (x + TILE / 2)) < 18 && Math.abs(body.y + PLAYER_H / 2 - y) < 6;
          const top = pressed ? y + 14 : y + 4;
          ctx.fillStyle = '#3a4763';
          ctx.fillRect(x + 2, y + TILE - 6, TILE - 4, 6);
          ctx.strokeStyle = '#c9d3e6';
          ctx.lineWidth = 2;
          ctx.beginPath();
          const coils = 4;
          for (let i = 0; i <= coils; i++) {
            const yy = top + (TILE - 8 - (top - y)) * (i / coils);
            ctx.moveTo(x + 6, yy);
            ctx.lineTo(x + TILE - 6, yy + 3);
          }
          ctx.stroke();
          ctx.fillStyle = '#e5484d';
          ctx.fillRect(x + 3, top - 4, TILE - 6, 5);
        } else if (ch === '|') {
          ctx.fillStyle = pal.pillar;
          ctx.fillRect(x + 3, y, TILE - 6, TILE);
          ctx.fillStyle = pal.pillarDark;
          ctx.fillRect(x + 3, y, 5, TILE);
          if (tileAt(lv, tx, ty - 1) !== '|') {
            ctx.fillStyle = pal.pillar;
            ctx.fillRect(x, y, TILE, 8);
            ctx.strokeStyle = 'rgba(0,0,0,0.25)';
            ctx.strokeRect(x, y, TILE, 8);
          }
        } else if (ch === '=') {
          ctx.fillStyle = pal.platform;
          ctx.fillRect(x, y, TILE, 9);
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.fillRect(x, y, TILE, 3);
        } else if (ch === '^') {
          ctx.fillStyle = pal.spike;
          ctx.beginPath();
          ctx.moveTo(x, y + TILE);
          ctx.lineTo(x + TILE / 4, y + 6);
          ctx.lineTo(x + TILE / 2, y + TILE);
          ctx.lineTo(x + 3 * TILE / 4, y + 6);
          ctx.lineTo(x + TILE, y + TILE);
          ctx.closePath();
          ctx.fill();
        } else if (ch === '~') {
          const wob = Math.sin(ts / 300 + tx * 1.3) * 3;
          ctx.fillStyle = pal.lava || '#ff6b35';
          ctx.fillRect(x, y + 8 + wob, TILE, TILE - 8 - wob);
          ctx.fillStyle = pal.lavaGlow || '#ffd23e';
          ctx.fillRect(x, y + 8 + wob, TILE, 3);
        }
      }
    }
  }

  function drawCheckpoints(ts, pal) {
    for (const cp of lv.checkpoints) {
      const on = checkpointAt === cp.x;
      const x = cp.x, base = cp.y + TILE / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x - 6, base - 3, 12, 3);
      ctx.fillStyle = '#8d94a6';
      ctx.fillRect(x - 2, base - 46, 4, 44);
      ctx.fillStyle = on ? '#30a46c' : '#5b6577';
      ctx.beginPath();
      ctx.moveTo(x + 2, base - 46);
      ctx.lineTo(x + 24, base - 39);
      ctx.lineTo(x + 2, base - 32);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawFlag(ts, pal) {
    const f = lv.flag;
    const base = (f.ty + 1) * TILE;
    const top = base - TILE * 5;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(f.x - 10, base - 4, 20, 4);
    ctx.fillStyle = '#cfd6e4';
    ctx.fillRect(f.x - 2, top, 4, base - top);
    ctx.beginPath();
    ctx.arc(f.x, top, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd23e';
    ctx.fill();
    const wave = Math.sin(ts / 350) * 3;
    ctx.fillStyle = pal.flag;
    ctx.beginPath();
    ctx.moveTo(f.x + 2, top + 4);
    ctx.lineTo(f.x + 34, top + 13 + wave);
    ctx.lineTo(f.x + 2, top + 24);
    ctx.closePath();
    ctx.fill();
  }

  function drawCoins(ts) {
    for (let i = 0; i < lv.coins.length; i++) {
      if (collected.has(i)) continue;
      const c = lv.coins[i];
      const spin = Math.abs(Math.sin(ts / 250 + i * 0.9));
      ctx.fillStyle = '#c9971f';
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 8 * Math.max(0.2, spin), 9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffd23e';
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 6 * Math.max(0.15, spin), 7, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawGem(x, y, size, ts, seed = 0) {
    const t = ts / 400 + seed;
    const glow = 0.5 + 0.5 * Math.sin(t * 2);
    ctx.save();
    ctx.translate(x, y + Math.sin(t) * 2);
    ctx.fillStyle = `rgba(120,220,255,${0.15 + glow * 0.2})`;
    ctx.beginPath();
    ctx.arc(0, 0, size * 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#39c0d6';
    ctx.beginPath();
    ctx.moveTo(0, -size); ctx.lineTo(size * 0.85, -size * 0.3);
    ctx.lineTo(size * 0.55, size); ctx.lineTo(-size * 0.55, size);
    ctx.lineTo(-size * 0.85, -size * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.moveTo(-size * 0.5, -size * 0.35); ctx.lineTo(0, -size * 0.85); ctx.lineTo(size * 0.5, -size * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawGems(ts) {
    for (let i = 0; i < lv.gems.length; i++) {
      if (gems.has(i)) continue;
      drawGem(lv.gems[i].x, lv.gems[i].y, 11, ts, i);
    }
  }

  const PICKUP_LOOK = {
    heart:  { bg: '#ff6b9a', glyph: '♥' },
    speed:  { bg: '#ffb224', glyph: '»' },
    ward:   { bg: '#7fb2e6', glyph: '◈' },
    magnet: { bg: '#c563e6', glyph: 'U' },
  };

  function drawPickups(ts) {
    for (let i = 0; i < lv.pickups.length; i++) {
      if (taken.has(i)) continue;
      const p = lv.pickups[i];
      if (p.block && !used.has(p.block)) continue;
      const look = PICKUP_LOOK[p.type];
      const bob = Math.sin(ts / 300 + i) * 2.5;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 14, 9, 3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = look.bg;
      ctx.beginPath();
      ctx.roundRect(p.x - 11, p.y - 11 + bob, 22, 22, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#1b1020';
      ctx.font = 'bold 15px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(look.glyph, p.x, p.y + 1 + bob);
    }
  }

  function drawEnemy(f, x, y, ts) {
    const spec = ENEMY[f.type];
    const wob = Math.sin(ts / 120 + f.i) * 1.5;
    if (f.type === 'walker') {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(x, y + spec.h / 2 + 2, spec.w / 2, 3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#a4703f';
      ctx.beginPath();
      ctx.ellipse(x, y + wob * 0.4, spec.w / 2, spec.h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#7d5230';
      ctx.beginPath();
      ctx.ellipse(x - spec.w / 4, y + spec.h / 2 - 2, 5, 4, 0, 0, Math.PI * 2);
      ctx.ellipse(x + spec.w / 4, y + spec.h / 2 - 2, 5, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x + f.dir * 5, y - 4, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(x + f.dir * 6.5, y - 4, 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = '#d7deeb';
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(x + i * 6 - 4, y);
        ctx.lineTo(x + i * 6, y - spec.h / 2 - 7 - (i % 2 ? 0 : 3));
        ctx.lineTo(x + i * 6 + 4, y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = '#3f4a63';
      ctx.beginPath();
      ctx.ellipse(x, y + 2 + wob * 0.3, spec.w / 2, spec.h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ff8a8a';
      ctx.beginPath();
      ctx.arc(x + f.dir * 5, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawHero(x, y, face, moving, dead, seat, isMe, ts, extra = {}) {
    const ch = CHARACTERS[seat?.char] || CHARACTERS.rex;
    const hw = PLAYER_W / 2, hh = PLAYER_H / 2;
    const bob = moving && !dead ? Math.sin(ts / 60) * 1.4 : 0;
    const blink = isMe && body?.inv > 0 && Math.floor(ts / 90) % 2 === 0;

    if (!dead && extra.buff === 'speed' && Math.abs(extra.vx || 0) > 1) {
      // Afterimages trailing the runner.
      for (let i = 1; i <= 3; i++) {
        ctx.fillStyle = `rgba(255,178,36,${0.22 - i * 0.06})`;
        ctx.beginPath();
        ctx.roundRect(x - hw - face * i * 9, y - hh + 4, PLAYER_W, PLAYER_H - 4, 6);
        ctx.fill();
      }
    }
    if (!dead && extra.buff === 'ward') {
      ctx.strokeStyle = `rgba(127,178,230,${0.5 + 0.3 * Math.sin(ts / 120)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, 24, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (!dead && extra.buff === 'magnet') {
      ctx.strokeStyle = 'rgba(197,99,230,0.45)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 6]);
      ctx.lineDashOffset = -ts / 30;
      ctx.beginPath();
      ctx.arc(x, y, 40, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (!dead && extra.shard) {
      ctx.fillStyle = `rgba(255,107,154,${0.18 + 0.1 * Math.sin(ts / 150)})`;
      ctx.beginPath();
      ctx.ellipse(x, y + 2, hw + 8, hh + 8, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.globalAlpha = dead ? 0.35 : blink ? 0.45 : 1;

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(x, y + hh + 2, hw * 0.9, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // legs — two stubs scissoring while running
    const stride = moving && !dead ? Math.sin(ts / 60) * 4 : 0;
    ctx.fillStyle = '#2c3a5e';
    ctx.fillRect(x - 7 + stride, y + hh - 8, 6, 8);
    ctx.fillRect(x + 1 - stride, y + hh - 8, 6, 8);

    // dungarees
    ctx.fillStyle = '#3a5da8';
    ctx.beginPath();
    ctx.roundRect(x - hw + 1, y - 2 + bob, PLAYER_W - 2, hh + 8, 4);
    ctx.fill();

    // shirt + arms in the hero's colour
    ctx.fillStyle = ch.hex;
    ctx.beginPath();
    ctx.roundRect(x - hw, y - hh + 6 + bob, PLAYER_W, 12, 4);
    ctx.fill();

    // head
    ctx.fillStyle = '#ffd9b0';
    ctx.beginPath();
    ctx.arc(x + face * 1, y - hh + 3 + bob, 9, 0, Math.PI * 2);
    ctx.fill();

    // cap
    ctx.fillStyle = ch.hex;
    ctx.beginPath();
    ctx.arc(x + face * 1, y - hh + 1 + bob, 9.5, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = ch.dark;
    ctx.fillRect(x + face * 1 - (face > 0 ? -1 : 13), y - hh + bob, 12, 3);

    // eyes
    ctx.fillStyle = '#222';
    if (dead) {
      ctx.font = 'bold 8px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('×', x + face * 4, y - hh + 6 + bob);
    } else {
      ctx.beginPath();
      ctx.arc(x + face * 4, y - hh + 3 + bob, 1.8, 0, Math.PI * 2);
      ctx.arc(x + face * 7, y - hh + 3 + bob, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    if (!dead && extra.shard) {
      // The shard rides on the cap.
      ctx.fillStyle = '#ff6b9a';
      ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♥', x + face * 1, y - hh - 2 + bob);
    }

    ctx.globalAlpha = 1;
    ctx.restore();

    if (!seat) return;
    ctx.fillStyle = isMe ? '#ffffff' : 'rgba(231,236,245,0.85)';
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(seat.name, x, y - hh - 8);
  }

  function drawFx(ts) {
    const now = performance.now();
    fx = fx.filter((f) => now - f.t0 < 520);
    for (const f of fx) {
      const k = (now - f.t0) / 520;
      if (f.type === 'sparkle') {
        ctx.fillStyle = `rgba(255,210,62,${1 - k})`;
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + k * 2;
          ctx.fillRect(f.x + Math.cos(a) * 16 * k - 2, f.y + Math.sin(a) * 16 * k - 2, 4, 4);
        }
      } else if (f.type === 'coinpop') {
        const y = f.y - 26 * Math.sin(Math.min(1, k * 1.4) * Math.PI);
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = '#ffd23e';
        ctx.beginPath();
        ctx.ellipse(f.x, y, 7, 8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (f.type === 'squash') {
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = '#7d5230';
        ctx.beginPath();
        ctx.ellipse(f.x, f.y + 8, 14 + k * 6, 4 * (1 - k) + 1, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (f.type === 'dust') {
        ctx.fillStyle = `rgba(255,255,255,${0.45 * (1 - k)})`;
        for (let i = -1; i <= 1; i += 2) {
          ctx.beginPath();
          ctx.arc(f.x + i * (6 + k * 14), f.y - 2 - k * 6, 3 + k * 3, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (f.type === 'heartpop') {
        const y = f.y - 22 * Math.sin(Math.min(1, k * 1.4) * Math.PI);
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = '#ff6b9a';
        ctx.font = 'bold 18px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('♥', f.x, y);
        ctx.globalAlpha = 1;
      } else if (f.type === 'gemburst') {
        ctx.globalAlpha = 1 - k;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          drawGem(f.x + Math.cos(a) * 34 * k, f.y + Math.sin(a) * 34 * k, 4, ts, i);
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawHud(ts) {
    const run = view?.run;
    if (!run) return;
    const coins = run.scores.reduce((n, s) => n + (s?.c || 0), 0);
    const me = CHARACTERS[view.seats[mySeat()]?.char] || CHARACTERS.rex;

    ctx.font = '700 15px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // coins
    ctx.fillStyle = 'rgba(10,14,24,0.55)';
    ctx.beginPath();
    ctx.roundRect(10, 10, 92, 30, 8);
    ctx.fill();
    ctx.fillStyle = '#ffd23e';
    ctx.beginPath();
    ctx.ellipse(27, 25, 8, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText('× ' + coins, 42, 26);

    // lives: the hero's cap, then the count
    if (run.lives !== null && run.lives !== undefined) {
      ctx.fillStyle = 'rgba(10,14,24,0.55)';
      ctx.beginPath();
      ctx.roundRect(108, 10, 78, 30, 8);
      ctx.fill();
      ctx.fillStyle = me.hex;
      ctx.beginPath();
      ctx.arc(125, 27, 8, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = me.dark;
      ctx.fillRect(117, 26, 18, 3);
      ctx.fillStyle = run.lives <= 1 && Math.floor(ts / 400) % 2 === 0 ? '#ff8a8a' : '#fff';
      ctx.fillText('× ' + run.lives, 140, 26);
    }

    // gems: three slots
    ctx.fillStyle = 'rgba(10,14,24,0.55)';
    ctx.beginPath();
    ctx.roundRect(192, 10, 24 + lv.gems.length * 22, 30, 8);
    ctx.fill();
    for (let i = 0; i < lv.gems.length; i++) {
      const x = 212 + i * 22;
      if (gems.has(i)) drawGem(x, 25, 7, ts, i);
      else {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 18); ctx.lineTo(x + 6, 23); ctx.lineTo(x + 4, 32); ctx.lineTo(x - 4, 32); ctx.lineTo(x - 6, 23);
        ctx.closePath();
        ctx.stroke();
      }
    }

    // the active buff, with a draining bar
    if (body?.buff) {
      const look = PICKUP_LOOK[body.buff.type];
      const k = body.buff.t / BUFF_STEPS;
      ctx.fillStyle = 'rgba(10,14,24,0.55)';
      ctx.beginPath();
      ctx.roundRect(VIEW_W - 130, 10, 120, 30, 8);
      ctx.fill();
      ctx.fillStyle = look.bg;
      ctx.beginPath();
      ctx.roundRect(VIEW_W - 122, 16, 18, 18, 5);
      ctx.fill();
      ctx.fillStyle = '#1b1020';
      ctx.font = 'bold 12px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(look.glyph, VIEW_W - 113, 26);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(VIEW_W - 98, 21, 80, 8);
      ctx.fillStyle = k < 0.25 && Math.floor(ts / 150) % 2 === 0 ? '#ff8a8a' : look.bg;
      ctx.fillRect(VIEW_W - 98, 21, 80 * k, 8);
      ctx.font = '700 15px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'left';
    }

    // Teammates off screen: a nudge along the edge so co-op stays co-op.
    for (const [seat, e] of ents) {
      if (e.d) continue;
      const sx = e.x - cam;
      if (sx > -10 && sx < VIEW_W + 10) continue;
      const ch = CHARACTERS[view.seats[seat]?.char] || CHARACTERS.rex;
      const edge = sx < 0 ? 14 : VIEW_W - 14;
      const dir = sx < 0 ? -1 : 1;
      ctx.fillStyle = ch.hex;
      ctx.beginPath();
      ctx.moveTo(edge + dir * 7, e.y);
      ctx.lineTo(edge - dir * 5, e.y - 8);
      ctx.lineTo(edge - dir * 5, e.y + 8);
      ctx.closePath();
      ctx.fill();
    }
  }

  function say(text) {
    banner = { text, until: performance.now() + 2200 };
  }

  function drawBanner() {
    const bn = el('banner');
    if (!bn) return;
    if (banner && performance.now() < banner.until) {
      bn.hidden = false;
      bn.textContent = banner.text;
    } else {
      bn.hidden = true;
      banner = null;
    }
  }

  /* ============================== panels ============================== */

  function render() {
    if (!view) return;
    if (view.phase === 'wait') { renderWait(); return; }
    if (!root.querySelector('.board')) return;  // play/clear panels exist once startPlay ran
    renderSide();
    renderModal();
  }

  function renderWait() {
    if (!root.querySelector('.codeval')) {
      root.innerHTML = WAIT_HTML;
      canvas = null; ctx = null;
      stopRender();
    }
    el('codeval').textContent = view.code;

    const isHost = selfId === view.hostId;
    const mine = view.seats[mySeat()];

    el('chargrid').innerHTML = CHAR_IDS.map((c) => {
      const ch = CHARACTERS[c];
      const takenBy = view.seats.find((s) => s.char === c);
      const isMine = mine?.char === c;
      const cls = 'charcard' + (isMine ? ' mine' : takenBy ? ' taken' : '');
      return `
        <button class="${cls}" data-c="${c}" ${takenBy && !isMine ? 'disabled' : ''} style="--c:${ch.hex};--cd:${ch.dark}">
          <span class="dot"><span class="cap"></span></span>
          <span class="cname">${esc(ch.name)}</span>
          <span class="cblurb">${esc(ch.blurb)}</span>
          <span class="cby">${takenBy ? esc(takenBy.name) + (isMine ? ' (you)' : '') : '&nbsp;'}</span>
        </button>`;
    }).join('');
    el('chargrid').querySelectorAll('.charcard').forEach((b) => {
      b.onclick = () => intent({ t: 'char', c: b.dataset.c });
    });

    el('worldrow').innerHTML = WORLDS.map((w) => `
      <button class="worldbtn ${view.world === w.id ? 'picked' : ''}" data-w="${w.id}"
              ${isHost ? '' : 'disabled'}
              style="--s0:${w.palette.sky[0]};--s1:${w.palette.sky[1]};--g:${w.palette.groundTop}">
        <span class="sw"></span>
        <span class="wname">${esc(w.name)}</span>
      </button>`).join('');
    if (isHost) {
      el('worldrow').querySelectorAll('.worldbtn').forEach((b) => {
        b.onclick = () => intent({ t: 'world', w: b.dataset.w });
      });
    }

    el('seats').innerHTML = view.seats.map((s) => {
      const ch = CHARACTERS[s.char];
      return `
        <li class="${s.connected ? '' : 'gone'}">
          <div class="chip" style="background:${ch ? ch.hex : '#3a4763'}"></div>
          <div class="nm">${esc(s.name)}</div>
          <div class="badge">${ch ? esc(ch.name) : 'choosing…'}${s.id === view.hostId ? ' · host' : ''}${s.id === selfId ? ' · you' : ''}</div>
        </li>`;
    }).join('');

    const ready = view.seats.length >= MIN_PLAYERS && view.seats.every((s) => s.char);
    const startBtn = el('start');
    startBtn.hidden = !isHost;
    startBtn.disabled = !ready;
    startBtn.onclick = () => intent({ t: 'start' });
    el('starthint').textContent = isHost
      ? (ready ? `${view.seats.length} playing · ${WORLD_BY_ID.get(view.world).name}` : 'Everyone picks a hero first.')
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

  function renderSide() {
    const w = WORLD_BY_ID.get(view.run.worldId);
    el('worldinfo').innerHTML = `<div class="wtitle">${esc(w.name)}</div><div class="wsub">${esc(w.sub)}</div>`;

    el('party').innerHTML = view.seats.map((s, i) => {
      const ch = CHARACTERS[s.char];
      const sc = view.run.scores[i] || { c: 0, s: 0, d: 0, g: 0 };
      return `
        <li class="${s.connected ? '' : 'gone'}">
          <div class="chip" style="background:${ch ? ch.hex : '#3a4763'}"></div>
          <div class="nm">${esc(s.name)}${s.id === selfId ? ' (you)' : ''}</div>
          <div class="sc" title="coins · gems · stomps · deaths">🪙${sc.c} · 💎${sc.g || 0} · 👟${sc.s} · 💀${sc.d}</div>
        </li>`;
    }).join('');
  }

  function scoreRows() {
    return view.seats.map((s, i) => {
      const ch = CHARACTERS[s.char];
      const sc = view.run.scores[i] || { c: 0, s: 0, d: 0, g: 0 };
      return `
        <div class="crow">
          <div class="chip" style="background:${ch ? ch.hex : '#3a4763'}"></div>
          <div class="nm">${esc(s.name)}</div>
          <div class="n">${sc.c} 🪙</div>
          <div class="n">${sc.g || 0} 💎</div>
          <div class="n">${sc.s} 👟</div>
          <div class="n">${sc.d} 💀</div>
        </div>`;
    }).join('');
  }

  function renderModal() {
    const modal = el('modal');
    if (!modal) return;
    if (view.phase !== 'clear' && view.phase !== 'over') { modal.hidden = true; modal.innerHTML = ''; return; }

    const isHost = selfId === view.hostId;
    const world = WORLD_BY_ID.get(view.run.worldId);
    const gemsGot = view.run.gems.length;
    const gemsAll = lv?.gems.length ?? 3;

    modal.hidden = false;
    if (view.phase === 'over') {
      modal.innerHTML = `
        <div class="card2 over">
          <h2>GAME OVER</h2>
          <div class="sub">The team ran out of lives on ${esc(world.name)}.</div>
          <div class="ctable">${scoreRows()}</div>
          ${isHost ? `
            <div class="btnrow">
              <button class="primary go-replay">Try again</button>
              <button class="go-room">Back to room</button>
            </div>`
          : '<div class="hint">Waiting for the host…</div>'}
        </div>`;
    } else {
      const who = view.seats[view.run.clearBy];
      modal.innerHTML = `
        <div class="card2 clear">
          <h2>COURSE CLEAR!</h2>
          <div class="sub">${esc(who?.name || 'Someone')} reached the flag on ${esc(world.name)}.
            Gems: ${gemsGot} / ${gemsAll}${gemsGot === gemsAll ? ' — all of them!' : ''}</div>
          <div class="ctable">${scoreRows()}</div>
          ${isHost ? `
            <div class="btnrow">
              <button class="primary go-next">Next world</button>
              <button class="go-replay">Replay</button>
              <button class="go-room">Back to room</button>
            </div>`
          : '<div class="hint">Waiting for the host to pick what\'s next…</div>'}
        </div>`;
    }

    if (!isHost) return;
    const next = modal.querySelector('.go-next');
    if (next) next.onclick = () => intent({ t: 'again', mode: 'next' });
    modal.querySelector('.go-replay').onclick = () => intent({ t: 'again', mode: 'replay' });
    modal.querySelector('.go-room').onclick = () => intent({ t: 'again', mode: 'room' });
  }

  /* ========================= tab lifecycle ========================= */

  // The shell keeps panels alive across tab switches, so stand down on the
  // way out: stop painting, drop held keys. The HOST's enemy clock keeps
  // running — everyone else's game is inside it.
  function onShow() {
    active = true;
    if (view?.phase === 'play' || view?.phase === 'clear' || view?.phase === 'over') startRender();
  }

  function onHide() {
    active = false;
    releaseAll();
    stopRender();
  }

  bros.onShow = onShow;
  bros.onHide = onHide;

  showLobby();
}

const bros = { id: GAME, title: 'Bros', init };

export default bros;
