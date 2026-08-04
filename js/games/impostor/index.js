// Impostor — lobby, network, run loop and the canvas the ship is drawn on.
//
// ---- Authority ----
//
// Same star topology as Ludo and Uno: the host holds the one true state,
// everyone else sends intents. What is different is that this game does not
// wait for turns, so the host is not reacting to clicks — it is running a
// simulation at 20Hz and broadcasting the result. See rules.js for why 20.
//
// ---- Hidden information, which here is most of the game ----
//
// Uno hides your hand. This hides *the map*. The host does not broadcast state;
// each player is sent a snapshot culled to what they can actually see:
//
//     state (host only)            snapshot (per player, 20/sec)
//     ├─ players[].x,y        →    ├─ p: only those inside your light,
//     │                            │     with a wall-free line to them
//     ├─ players[].impostor   →    ├─ (dropped — unless you are one)
//     ├─ players[].tasks      →    ├─ me.tasks: yours alone
//     ├─ players[].alive      →    ├─ (dropped until a meeting or the end)
//     └─ bodies               →    └─ b: only bodies you could see
//
// Culling rather than drawing-dark is the whole point. A fog-of-war that ships
// every position and paints over it is a game you win by opening devtools.
//
// ---- Prediction ----
//
// A player who has to wait for a round trip before their own legs move will
// describe the game as broken, and they will be right. So the client simulates
// its own body immediately using the same `stepBody` the host runs, and eases
// onto the host's answer as it arrives. Everyone else is interpolated between
// snapshots, one snapshot behind, which is what makes 20 packets a second look
// like continuous motion.
//
// The host renders through exactly the same path, its own snapshot included.
// It could read positions straight out of `state` and see the whole ship, and
// that is the reason not to: hosting should not be worth anything.

import { createRoom, joinRoom, normaliseCode } from '../../net.js';
import { openTask } from './tasks.js';
import {
  WORLD_W, WORLD_H, ROOMS, HALLS, STATIONS, STATION_BY_ID, BUTTON,
  PLAYER_R, within, hasLOS,
} from './map.js';
import {
  TICK_MS, MIN_PLAYERS, MAX_PLAYERS, COLORS, COLOR_HEX,
  KILL_RANGE, USE_RANGE, REPORT_RANGE, TICK_HZ,
  createState, stepBody, setInput, step, canSee, visionOf,
  applyKill, applyTask, applyReport, applyButton, applyVote, applyLeave,
  buttonBlocked, impostorCount, restart,
} from './rules.js';

const GAME = 'impostor';

/* ---- view ---- */
const VIEW_W = 960;
const VIEW_H = 600;
const ZOOM = 1.15;          // world units to canvas pixels

/* ---- client-side smoothing ---- */
/** How far behind the newest snapshot other players are drawn, in ms.
 *  Slightly under two ticks: enough to always have a next position to move
 *  toward, little enough that a killer isn't drawn a stride behind where the
 *  host thinks they are. */
const INTERP_MS = 80;
/** Position error past which prediction gives up and snaps. Meetings teleport
 *  everyone to the table, and easing across half the ship looks like a bug. */
const SNAP_DIST = 70;

/** Most simulation ticks the host will run in one interval. A backgrounded
 *  tab throttles timers to about 1Hz; paying that back in full would fling
 *  every player twenty strides across the map the moment it came back. */
const MAX_CATCHUP = 3;

const LOBBY_HTML = `
  <div class="lobby">
    <div class="lobby-card">
      <h2>Impostor</h2>
      <div class="lead">Create a room and share the code, or enter a friend's code to join.
        ${MIN_PLAYERS}–${MAX_PLAYERS} players. Finish the work, or finish the crew.</div>

      <div class="field">
        <label for="imp-name">Your name</label>
        <input id="imp-name" class="name" maxlength="12" placeholder="Nickname" autocomplete="off">
      </div>

      <button class="primary create">Create a room</button>

      <div class="or">or</div>

      <div class="field">
        <label for="imp-code">Room code</label>
        <div class="row">
          <input id="imp-code" class="code-input codein" maxlength="5" placeholder="ABC12"
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
      <h2>Waiting to launch</h2>
      <div class="lead">Share this code with your crew.</div>
      <div class="code-display">
        <div class="cap">Room code</div>
        <div class="code codeval"></div>
        <button class="copy">Copy code</button>
      </div>
      <ul class="seats"></ul>
      <button class="primary start">Start game</button>
      <div class="hint starthint"></div>
      <div class="err waiterr"></div>
    </div>
  </div>
`;

const GAME_HTML = `
  <div class="table imp">
    <div class="stage">
      <div class="screen">
        <canvas class="board" width="${VIEW_W}" height="${VIEW_H}" aria-label="The ship"></canvas>
        <div class="prompts"></div>
        <div class="banner" hidden></div>
        <div class="modal" hidden></div>
      </div>
    </div>
    <aside>
      <div class="rolecard"></div>

      <div class="loghead">Tasks <span class="taskpct"></span></div>
      <div class="taskbar"><div class="taskfill"></div></div>
      <ul class="tasklist"></ul>

      <div class="loghead">Controls</div>
      <ul class="keys">
        <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>or the arrow keys, to walk</span></li>
        <li><kbd>E</kbd><span>use the console you're standing at</span></li>
        <li><kbd>R</kbd><span>report a body</span></li>
        <li><kbd>Q</kbd><span>kill — impostors only</span></li>
      </ul>

      <div class="loghead">Log</div>
      <div class="logwrap"><ul class="log"></ul></div>
    </aside>
  </div>
`;

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function init(root, header) {
  let room = null;        // net.js Room
  let state = null;       // host only: seats + the rules state. Never sent whole.
  let view = null;        // what we render the panels from — a redacted state
  let selfId = null;
  let myName = 'Player';

  /* ---- the local model of the world, rebuilt from snapshots ---- */
  // seat index -> { x, y, dead, fx, fy, t0 } — f* is where the ease started.
  let ents = new Map();
  let bodies = [];         // [{ seat, x, y }] — bodies don't move, so no easing
  let me = null;           // { x, y, ix, iy, alive } — predicted locally
  let hud = { cd: 0, buttonCd: 0, meetingSecs: -1 };

  let raf = null;          // render loop
  let simTimer = null;     // host simulation clock
  let simLast = 0;
  let acc = 0;             // unspent ms owed to the simulation
  let predictAcc = 0;      // unspent ms owed to local prediction
  let active = false;      // is this tab on screen?

  let keys = new Set();
  let lastSent = { x: 0, y: 0 };
  let taskUI = null;       // { stationId, teardown } while a minigame is open
  let banner = null;       // { text, until } — the transient "you were killed" line

  const el = (sel) => root.querySelector('.' + sel);
  let canvas = null, ctx = null;

  header.innerHTML = '<div class="tag imptag">Work the ship. Find the impostor.</div>' +
                     '<button class="leave" hidden>Leave room</button>';
  const leaveBtn = header.querySelector('.leave');
  leaveBtn.onclick = () => {
    if (!confirm('Leave the room? This ends the game for you.')) return;
    teardown();
    showLobby();
  };

  function teardown() {
    closeTask();
    stopSim();
    stopRender();
    room?.close();
    room = null; state = null; view = null; selfId = null;
    ents = new Map(); bodies = []; me = null; banner = null;
    keys.clear();
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
          phase: 'lobby',
          code: room.code,
          hostId: selfId,
          seats: [{ id: selfId, name: myName, color: COLORS[0], connected: true }],
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
          '<h2>Boarding…</h2><div class="lead">Connected. Waiting for the host.</div>' +
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

  // Every action funnels through here, the host's own key presses included, so
  // there is one validation path rather than a trusted one and a checked one.
  function intent(msg) {
    if (room?.isHost) onHostMessage(msg, selfId);
    else room?.send(null, msg);
  }

  function onJoin(peerId) {
    if (state.phase !== 'lobby') {
      room.send(peerId, { t: 'denied', msg: 'That game has already started.' });
    } else if (state.seats.length >= MAX_PLAYERS) {
      room.send(peerId, { t: 'denied', msg: `That room is full (${MAX_PLAYERS} players).` });
    }
  }

  function onLeave(peerId) {
    if (!state) return;
    const seat = state.seats.find((s) => s.id === peerId);
    if (!seat) return;

    if (state.phase === 'lobby') {
      state.seats = state.seats.filter((s) => s.id !== peerId);
      state.seats.forEach((s, i) => { s.color = COLORS[i % COLORS.length]; });
    } else {
      seat.connected = false;
      applyLeave(state.game, peerId);
    }
    pushRoom();
  }

  function onHostMessage(msg, fromId) {
    if (!state) return;
    const seat = state.seats.find((s) => s.id === fromId);

    if (msg.t === 'hello') {
      if (state.phase !== 'lobby') { room.send(fromId, { t: 'denied', msg: 'That game has already started.' }); return; }
      if (seat) return;
      if (state.seats.length >= MAX_PLAYERS) { room.send(fromId, { t: 'denied', msg: `That room is full (${MAX_PLAYERS} players).` }); return; }
      state.seats.push({
        id: fromId,
        name: String(msg.name || 'Player').trim().slice(0, 12) || 'Player',
        color: COLORS[state.seats.length % COLORS.length],
        connected: true,
      });
      pushRoom();
      return;
    }

    if (!seat) return;  // not in this room

    if (msg.t === 'start' || msg.t === 'again') {
      const ok = msg.t === 'start'
        ? state.phase === 'lobby'
        : state.game?.phase === 'over';
      if (fromId !== state.hostId || !ok || state.seats.length < MIN_PLAYERS) return;
      state.phase = 'playing';
      state.game = msg.t === 'start'
        ? createState(state.seats)
        : restart(state.game, state.seats);
      startSim();
      pushRoom();
      return;
    }

    const g = state.game;
    if (!g) return;

    // Movement is the one message that arrives constantly, so it is handled
    // first and never triggers a full room push — the snapshot carries it.
    if (msg.t === 'in') { setInput(g, fromId, +msg.x || 0, +msg.y || 0); return; }

    if (msg.t === 'vote') {
      if (applyVote(g, fromId, msg.target ?? null)) pushRoom();
      return;
    }
    if (msg.t === 'task') {
      if (applyTask(g, fromId, msg.id)) pushRoom();
      return;
    }
    if (msg.t === 'kill') {
      if (applyKill(g, fromId, msg.target ?? null)) pushRoom();
      return;
    }
    if (msg.t === 'report') {
      if (applyReport(g, fromId, msg.body ?? null)) pushRoom();
      return;
    }
    if (msg.t === 'button') {
      if (applyButton(g, fromId)) pushRoom();
    }
  }

  /* ==================== host: redaction and push ==================== */

  /** The structural half of what `id` may know. Changes rarely; pushed on change. */
  function viewFor(id) {
    const v = {
      phase: state.phase,
      code: state.code,
      hostId: state.hostId,
      seats: state.seats.map((s) => ({ id: s.id, name: s.name, color: s.color, connected: s.connected })),
    };
    const g = state.game;
    if (!g) return v;

    const p = g.players[id];
    const over = g.phase === 'over';
    // Impostors know each other from the first second; everyone knows at the
    // end. In between it is the only fact the game is actually about.
    const seeRoles = over || !!p?.impostor;

    v.game = {
      phase: g.phase,
      taskDone: g.taskDone,
      taskGoal: g.taskGoal,
      winner: g.winner,
      reason: g.reason,
      log: g.log.slice(-14),
      impostorTotal: impostorCount(g.seats.length),
      me: p ? {
        seat: p.seat, alive: p.alive, impostor: p.impostor,
        tasks: p.tasks.map((t) => ({ id: t.id, done: t.done })),
        emergencies: p.emergencies,
      } : null,
      impostors: seeRoles ? g.seats.filter((s) => g.players[s.id]?.impostor).map((s) => s.id) : null,
      // Who is still breathing is public at the table and at the end, and
      // secret at every other moment — working it out is the crew's job.
      alive: (g.phase === 'meeting' || over)
        ? Object.fromEntries(g.seats.map((s) => [s.id, !!g.players[s.id]?.alive]))
        : null,
      gone: Object.fromEntries(g.seats.map((s) => [s.id, !!g.players[s.id]?.left])),
      meeting: g.meeting ? meetingView(g.meeting, id) : null,
    };
    return v;
  }

  /** During the vote you learn *that* someone voted, never who for. */
  function meetingView(m, id) {
    return {
      reason: m.reason,
      byId: m.byId,
      aboutId: m.aboutId,
      stage: m.stage,
      voted: Object.keys(m.votes),
      myVote: m.votes[id] ?? null,
      result: m.stage === 'result' ? m.result : null,
    };
  }

  /**
   * The volatile half: positions, clocks, the task bar. Sent every tick.
   *
   * Culled per player — see the note at the top of the file. Bodies are culled
   * the same way, which is what makes finding one an event rather than a thing
   * you already knew about from across the ship.
   */
  function snapshotFor(id) {
    const g = state.game;
    const p = g.players[id];
    if (!p) return null;

    const ps = [];
    for (const s of g.seats) {
      const q = g.players[s.id];
      if (!q || q.left) continue;
      if (!canSee(g, id, s.id)) continue;
      ps.push([q.seat, Math.round(q.x), Math.round(q.y), q.alive ? 0 : 1]);
    }

    const bs = [];
    for (const b of g.bodies) {
      const seat = g.players[b.id]?.seat ?? 0;
      // The dead see every body; the living see the ones in their light. A
      // body is not a player, so canSee() doesn't cover it — same two tests.
      const lit = within(p.x, p.y, b.x, b.y, visionOf(p)) && hasLOS(p.x, p.y, b.x, b.y);
      if (p.alive && !lit) continue;
      bs.push([seat, Math.round(b.x), Math.round(b.y)]);
    }

    return {
      t: 's',
      p: ps,
      b: bs,
      cd: p.killCd,
      bc: g.buttonCd,
      td: g.taskDone,
      tg: g.taskGoal,
      mt: g.meeting ? Math.max(0, Math.ceil((g.meeting.endsAt - g.tick) / TICK_HZ)) : -1,
    };
  }

  function pushRoom() {
    if (!room?.isHost) return;
    for (const peerId of room.peerIds()) room.send(peerId, { t: 'room', room: viewFor(peerId) });
    applyRoom(viewFor(selfId));
  }

  function pushSnapshots() {
    if (!room?.isHost || !state.game) return;
    for (const peerId of room.peerIds()) {
      const snap = snapshotFor(peerId);
      if (snap) room.send(peerId, snap);
    }
    const mine = snapshotFor(selfId);
    if (mine) applySnapshot(mine);
  }

  /* ======================= host: simulation clock ======================= */

  // A timer, not requestAnimationFrame. rAF stops dead in a background tab and
  // the host stopping means everyone stops — at least a throttled timer keeps
  // limping. MAX_CATCHUP above is what stops the limp becoming a lurch.
  function startSim() {
    if (!room?.isHost || simTimer !== null) return;
    simLast = performance.now();
    acc = 0;
    simTimer = setInterval(() => {
      const now = performance.now();
      acc += now - simLast;
      simLast = now;

      let n = 0;
      let sync = false;
      while (acc >= TICK_MS && n < MAX_CATCHUP) {
        acc -= TICK_MS;
        n += 1;
        if (step(state.game).sync) sync = true;
      }
      if (acc >= TICK_MS * MAX_CATCHUP) acc = 0;
      if (!n) return;

      pushSnapshots();
      if (sync) pushRoom();
      if (state.game.phase === 'over') stopSim();
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
    showLobby('The host left, so the room closed. WebRTC games live in the host\'s browser tab.');
  }

  function onNetError(err) {
    const target = root.querySelector('.lobbyerr') || root.querySelector('.waiterr');
    if (target) target.textContent = err.message;
    else console.error('[impostor] net error', err);
  }

  function applyRoom(next) {
    const wasPlaying = !!view?.game;
    const before = view?.game?.me?.alive;
    view = next;

    if (view.game && !wasPlaying) {
      // First frame of a round: build the local body and start rendering.
      me = null;
      ents = new Map();
      bodies = [];
      startRender();
    }
    if (view.game?.me && before === true && view.game.me.alive === false) {
      say(view.game.phase === 'meeting' ? 'You were ejected.' : 'You were killed.');
    }
    if (me) me.alive = view.game?.me?.alive ?? true;

    // Any structural change can invalidate an open task — a meeting starting,
    // most obviously, or dying at the console.
    if (taskUI && (view.game?.phase !== 'playing' || !view.game?.me?.alive)) closeTask();

    render();
  }

  function applySnapshot(s) {
    const now = performance.now();
    hud = { cd: s.cd, buttonCd: s.bc, meetingSecs: s.mt };
    if (view?.game) { view.game.taskDone = s.td; view.game.taskGoal = s.tg; }

    const mySeat = view?.game?.me?.seat;
    const seen = new Set();

    for (const [seat, x, y, dead] of s.p) {
      seen.add(seat);
      if (seat === mySeat) { reconcile(x, y); continue; }
      const e = ents.get(seat);
      if (!e) {
        // Walking into view: appear where you are, not eased in from the last
        // place you were seen, which could be the far side of the ship.
        ents.set(seat, { x, y, fx: x, fy: y, tx: x, ty: y, t0: now, dead: !!dead });
        continue;
      }
      e.fx = e.x; e.fy = e.y;      // ease from where we're drawn, not from the last target
      e.tx = x; e.ty = y;
      e.t0 = now;
      e.dead = !!dead;
    }
    for (const seat of [...ents.keys()]) if (!seen.has(seat)) ents.delete(seat);

    bodies = s.b.map(([seat, x, y]) => ({ seat, x, y }));
  }

  /**
   * Fold the host's answer into our predicted position.
   *
   * A small disagreement is eased away over the next few frames — snapping on
   * every packet is a permanent stutter, and the error is usually a stride at
   * most. A large one is a teleport the host meant (a meeting, a kill) and is
   * taken as given.
   */
  function reconcile(x, y) {
    if (!me) { me = { x, y, ix: 0, iy: 0, alive: view?.game?.me?.alive ?? true }; return; }
    if (Math.hypot(x - me.x, y - me.y) > SNAP_DIST) { me.x = x; me.y = y; return; }
    me.x += (x - me.x) * 0.25;
    me.y += (y - me.y) * 0.25;
  }

  /* ============================== input ============================== */

  const HELD = {
    w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0],
    arrowup: [0, -1], arrowleft: [-1, 0], arrowdown: [0, 1], arrowright: [1, 0],
  };

  /** Can this tab's keys move anything right now? */
  const controllable = () =>
    active && view?.game?.phase === 'playing' && !taskUI && !!me;

  function inputVector() {
    if (!controllable()) return { x: 0, y: 0 };
    let x = 0, y = 0;
    for (const k of keys) {
      const d = HELD[k];
      if (d) { x += d[0]; y += d[1]; }
    }
    const len = Math.hypot(x, y);
    return len ? { x: x / len, y: y / len } : { x: 0, y: 0 };
  }

  // Sent on change, not on a clock. Holding W for ten seconds is one packet.
  function pumpInput() {
    const v = inputVector();
    if (me) { me.ix = v.x; me.iy = v.y; }
    if (v.x === lastSent.x && v.y === lastSent.y) return;
    lastSent = v;
    intent({ t: 'in', x: +v.x.toFixed(3), y: +v.y.toFixed(3) });
  }

  function onKeyDown(ev) {
    if (!active || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key.toLowerCase();

    if (HELD[k]) {
      // Arrow keys scroll the page, which mid-chase is ruinous. Only swallowed
      // once the key is known to be ours.
      if (k.startsWith('arrow')) ev.preventDefault();
      // A modal has the keyboard: the minigames use arrows themselves.
      if (taskUI) return;
      keys.add(k);
      return;
    }
    if (taskUI || view?.game?.phase !== 'playing') return;

    if (k === 'e') { ev.preventDefault(); doUse(); }
    else if (k === 'r') { ev.preventDefault(); doReport(); }
    else if (k === 'q') { ev.preventDefault(); doKill(); }
  }

  function onKeyUp(ev) { keys.delete(ev.key.toLowerCase()); }

  // Keys held while the tab is switched away would otherwise stay held, and
  // you would come back to find yourself walking into a wall.
  const releaseAll = () => { keys.clear(); pumpInput(); };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);

  /* ============================== actions ============================== */

  // The prompts below are worked out client-side from what we can see, so they
  // are a guess at what the host will allow. The host re-checks every one of
  // them; a prompt that shouldn't have been there just does nothing.

  /** The station we're standing at and still owe, or null. */
  function stationHere() {
    if (!me || !view?.game?.me) return null;
    for (const t of view.game.me.tasks) {
      if (t.done) continue;
      const st = STATION_BY_ID.get(t.id);
      if (st && within(me.x, me.y, st.x, st.y, USE_RANGE)) return st;
    }
    return null;
  }

  const atButton = () => !!me && within(me.x, me.y, BUTTON.x, BUTTON.y, USE_RANGE);

  function bodyHere() {
    if (!me || !view?.game?.me?.alive) return null;
    for (const b of bodies) if (within(me.x, me.y, b.x, b.y, REPORT_RANGE)) return b;
    return null;
  }

  function killHere() {
    const g = view?.game;
    if (!me || !g?.me?.impostor || !g.me.alive || hud.cd > 0) return null;
    const mates = new Set(g.impostors || []);
    for (const [seat, e] of ents) {
      if (e.dead) continue;
      const s = view.seats[seat];
      if (s && mates.has(s.id)) continue;
      if (within(me.x, me.y, e.x, e.y, KILL_RANGE)) return { seat, id: s?.id ?? null };
    }
    return null;
  }

  function doUse() {
    const st = stationHere();
    if (st) return openStation(st);
    if (atButton()) {
      const g = view.game;
      const why = g.me.emergencies <= 0 ? 'You have used your emergency meeting.'
        : hud.buttonCd > 0 ? `Button cooling down — ${Math.ceil(hud.buttonCd / TICK_HZ)}s.`
        : null;
      if (why) return say(why);
      intent({ t: 'button' });
    }
  }

  function doReport() {
    const b = bodyHere();
    if (!b) return;
    intent({ t: 'report', body: view.seats[b.seat]?.id ?? null });
  }

  function doKill() {
    const target = killHere();
    if (!target) return;
    intent({ t: 'kill', target: target.id });
  }

  /* ---- task modal ---- */

  function openStation(st) {
    if (taskUI) return;
    releaseAll();                     // don't walk off mid-task
    const modal = el('modal');
    modal.hidden = false;
    modal.innerHTML = `
      <div class="card2 mg">
        <div class="mghead">
          <h2>${esc(st.name)}</h2>
          <button class="ghost mgclose" aria-label="Close">✕</button>
        </div>
        <div class="mgbody"></div>
        ${view.game.me.impostor ? '<div class="fake">This task is fake. Finishing it moves nothing.</div>' : ''}
      </div>`;
    modal.querySelector('.mgclose').onclick = closeTask;

    const done = () => {
      // Impostors still report it: their list has to tick along or the pretence
      // is worthless. rules.js accepts it and keeps it off the bar.
      intent({ t: 'task', id: st.id });
      closeTask();
    };
    taskUI = { stationId: st.id, teardown: openTask(modal.querySelector('.mgbody'), st, done) };
  }

  function closeTask() {
    if (!taskUI) return;
    taskUI.teardown();
    taskUI = null;
    const modal = root.querySelector('.modal');
    if (modal) { modal.hidden = true; modal.innerHTML = ''; }
  }

  function say(text) {
    banner = { text, until: performance.now() + 2600 };
  }

  /* ============================== the loop ============================== */

  function startRender() {
    if (raf !== null) return;
    predictAcc = 0;
    let last = performance.now();
    const frame = (ts) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(200, ts - last);
      last = ts;

      pumpInput();
      predict(dt);
      draw();
      renderPrompts();
    };
    raf = requestAnimationFrame(frame);
  }

  function stopRender() {
    if (raf === null) return;
    cancelAnimationFrame(raf);
    raf = null;
  }

  /** Run our own body forward on the same clock the host uses. */
  function predict(dt) {
    if (!me || view?.game?.phase !== 'playing') return;
    predictAcc = Math.min(predictAcc + dt, TICK_MS * MAX_CATCHUP);
    while (predictAcc >= TICK_MS) {
      predictAcc -= TICK_MS;
      stepBody(me);
    }
  }

  /* ============================== drawing ============================== */

  const HULL = '#080b14';
  const FLOOR = '#1b2438';
  const FLOOR_EDGE = '#2e3c5c';
  const HALL_FLOOR = '#161e2f';

  function draw() {
    if (!ctx) return;
    const g = view?.game;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = HULL;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    if (!me || !g) return;

    // Camera on the player, held inside the ship so you never scroll off into
    // an empty black margin.
    const halfW = VIEW_W / (2 * ZOOM), halfH = VIEW_H / (2 * ZOOM);
    const cx = Math.max(halfW, Math.min(WORLD_W - halfW, me.x));
    const cy = Math.max(halfH, Math.min(WORLD_H - halfH, me.y));

    ctx.save();
    ctx.translate(VIEW_W / 2, VIEW_H / 2);
    ctx.scale(ZOOM, ZOOM);
    ctx.translate(-cx, -cy);

    drawShip();
    drawStations(g);
    drawButton();
    for (const b of bodies) drawBody(b);
    for (const [seat, e] of ents) drawPlayer(seat, lerpX(e), lerpY(e), e.dead);
    drawPlayer(g.me.seat, me.x, me.y, !g.me.alive, true);

    ctx.restore();

    drawFog(cx, cy, g);
  }

  const lerpAt = (e) => Math.min(1, (performance.now() - e.t0) / INTERP_MS);
  const lerpX = (e) => { const k = lerpAt(e); e.x = e.fx + (e.tx - e.fx) * k; return e.x; };
  const lerpY = (e) => { const k = lerpAt(e); e.y = e.fy + (e.ty - e.fy) * k; return e.y; };

  function drawShip() {
    ctx.fillStyle = HALL_FLOOR;
    for (const h of HALLS) ctx.fillRect(h.x, h.y, h.w, h.h);

    for (const r of ROOMS) {
      ctx.fillStyle = FLOOR;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = FLOOR_EDGE;
      ctx.lineWidth = 3;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    // Room names last, so a hall drawn over a room edge can't cut through one.
    ctx.fillStyle = 'rgba(160,180,214,0.5)';
    ctx.font = '600 15px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const r of ROOMS) ctx.fillText(r.name.toUpperCase(), r.x + r.w / 2, r.y + 22);

    // The halls are drawn after the rooms' strokes so the doorways read as
    // openings rather than as rectangles bolted onto a sealed box.
    ctx.fillStyle = HALL_FLOOR;
    for (const h of HALLS) ctx.fillRect(h.x + 3, h.y + 3, h.w - 6, h.h - 6);
  }

  function drawStations(g) {
    const mine = new Map((g.me?.tasks || []).map((t) => [t.id, t.done]));
    for (const st of STATIONS) {
      const owed = mine.has(st.id) && !mine.get(st.id);
      const done = mine.get(st.id) === true;

      ctx.fillStyle = owed ? '#ffc53d' : done ? '#30a46c' : '#38455f';
      ctx.strokeStyle = owed ? 'rgba(255,197,61,0.35)' : 'transparent';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(st.x - 13, st.y - 13, 26, 26, 5);
      ctx.fill();
      if (owed) {
        // A slow ring rather than a blink: it has to be findable at the edge
        // of your light without being the loudest thing on the screen.
        const pulse = 18 + Math.sin(performance.now() / 320) * 5;
        ctx.beginPath();
        ctx.arc(st.x, st.y, pulse, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  function drawButton() {
    ctx.fillStyle = '#2a3550';
    ctx.beginPath();
    ctx.arc(BUTTON.x, BUTTON.y, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e5484d';
    ctx.beginPath();
    ctx.arc(BUTTON.x, BUTTON.y, 19, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBody(b) {
    const color = COLOR_HEX[view.seats[b.seat]?.color] || '#888';
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(Math.PI / 2);      // laid out flat, which is the whole tell
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(-PLAYER_R, -PLAYER_R + 2, PLAYER_R * 2, PLAYER_R * 1.6, 7);
    ctx.fill();
    ctx.restore();

    // The bone. Cartoonish on purpose — a realistic corpse in a game about
    // arguing with your friends is the wrong register entirely.
    ctx.fillStyle = '#f4f7ff';
    ctx.fillRect(b.x - 3, b.y - 14, 6, 12);
    ctx.beginPath();
    ctx.arc(b.x, b.y - 16, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPlayer(seat, x, y, dead, isMe) {
    const s = view.seats[seat];
    const color = COLOR_HEX[s?.color] || '#888';

    ctx.save();
    ctx.globalAlpha = dead ? 0.45 : 1;

    // Body: a bean. Circle-topped capsule, one squat leg-shadow beneath.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(x, y + PLAYER_R + 2, PLAYER_R * 0.9, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - PLAYER_R, y - PLAYER_R - 4, PLAYER_R * 2, PLAYER_R * 2 + 6, [PLAYER_R, PLAYER_R, 7, 7]);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Visor, offset toward the way they're heading so a crowd has some life.
    const face = isMe && me ? Math.sign(me.ix) : 0;
    ctx.fillStyle = '#a9d3f0';
    ctx.beginPath();
    ctx.ellipse(x + face * 3, y - 8, 10, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.restore();

    if (!s) return;
    ctx.fillStyle = isMe ? '#ffffff' : 'rgba(231,236,245,0.86)';
    ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(s.name, x, y - PLAYER_R - 10);
  }

  /**
   * The dark.
   *
   * Only cosmetic — the host already refused to send anyone you can't see, so
   * this is about the feeling of a small circle of light and not about secrecy.
   * The dead get none of it: they have nothing left to be surprised by.
   */
  function drawFog(cx, cy, g) {
    if (!g.me?.alive) return;
    const r = visionOf({ impostor: g.me.impostor }) * ZOOM;
    const sx = VIEW_W / 2 + (me.x - cx) * ZOOM;
    const sy = VIEW_H / 2 + (me.y - cy) * ZOOM;

    const grad = ctx.createRadialGradient(sx, sy, r * 0.62, sx, sy, r);
    grad.addColorStop(0, 'rgba(6,9,16,0)');
    grad.addColorStop(1, 'rgba(6,9,16,0.985)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // The gradient stops at r; everything past it needs filling flat or the
    // corners of the canvas stay lit.
    ctx.fillStyle = 'rgba(6,9,16,0.985)';
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, VIEW_H);
    ctx.arc(sx, sy, r, 0, Math.PI * 2, true);
    ctx.fill();
  }

  /* ============================== panels ============================== */

  function render() {
    if (!view) return;
    if (!view.game) { renderWait(); return; }
    if (!root.querySelector('.board')) {
      root.innerHTML = GAME_HTML;
      canvas = el('board');
      ctx = canvas.getContext('2d');
      canvas.addEventListener('pointerdown', () => doUse());
    }
    renderRole();
    renderTasks();
    renderLog();
    renderModal();
  }

  function renderWait() {
    if (!root.querySelector('.codeval')) { root.innerHTML = WAIT_HTML; canvas = null; ctx = null; }
    el('codeval').textContent = view.code;

    el('seats').innerHTML = view.seats.map((s) => `
      <li class="${s.connected ? '' : 'gone'}">
        <div class="chip" style="background:${COLOR_HEX[s.color]}"></div>
        <div class="nm">${esc(s.name)}</div>
        <div class="badge">${s.id === view.hostId ? 'host' : ''}${s.id === selfId ? ' · you' : ''}</div>
      </li>`).join('');

    const isHost = selfId === view.hostId;
    const startBtn = el('start');
    startBtn.hidden = !isHost;
    startBtn.disabled = view.seats.length < MIN_PLAYERS;
    startBtn.onclick = () => intent({ t: 'start' });

    const n = view.seats.length;
    el('starthint').textContent = isHost
      ? (n < MIN_PLAYERS
        ? `Waiting for ${MIN_PLAYERS - n} more…`
        : `${n} aboard · ${impostorCount(n)} impostor${impostorCount(n) === 1 ? '' : 's'}`)
      : 'Waiting for the host to start…';

    const copy = el('copy');
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(view.code);
        copy.textContent = 'Copied!';
      } catch {
        copy.textContent = 'Press Ctrl+C';   // clipboard needs https or localhost
      }
      setTimeout(() => { copy.textContent = 'Copy code'; }, 1400);
    };
  }

  function renderRole() {
    const g = view.game;
    const imp = g.me?.impostor;
    const mates = (g.impostors || []).filter((id) => id !== selfId)
      .map((id) => view.seats.find((s) => s.id === id)?.name)
      .filter(Boolean);

    el('rolecard').className = 'rolecard ' + (imp ? 'imposter' : 'crew') + (g.me?.alive ? '' : ' ghost');
    el('rolecard').innerHTML = `
      <div class="role">${imp ? 'IMPOSTOR' : 'CREWMATE'}</div>
      <div class="rolesub">${
        !g.me?.alive ? 'You are a ghost. Finish your list; nobody can hear you.'
        : imp ? (mates.length ? `With ${esc(mates.join(', '))}. Blend in, then don't.` : 'Alone. Blend in, then don\'t.')
        : `Finish the work. ${g.impostorTotal} impostor${g.impostorTotal === 1 ? '' : 's'} aboard.`
      }</div>`;
  }

  function renderTasks() {
    const g = view.game;
    const pct = g.taskGoal ? Math.round((g.taskDone / g.taskGoal) * 100) : 0;
    el('taskpct').textContent = `${g.taskDone}/${g.taskGoal}`;
    el('taskfill').style.width = pct + '%';
    el('taskfill').className = 'taskfill' + (g.me?.impostor ? ' fake' : '');

    el('tasklist').innerHTML = (g.me?.tasks || []).map((t) => {
      const st = STATION_BY_ID.get(t.id);
      const room = ROOMS.find((r) => r.id === st?.room);
      return `<li class="${t.done ? 'done' : ''}">
        <span class="tk">${esc(st?.name || t.id)}</span>
        <span class="rm">${esc(room?.name || '')}</span>
      </li>`;
    }).join('');
  }

  function renderLog() {
    el('log').innerHTML = (view.game.log || []).map((line) => `<li>${esc(line)}</li>`).join('');
    const wrap = el('logwrap');
    wrap.scrollTop = wrap.scrollHeight;
  }

  /** The contextual key hints along the bottom of the canvas. Redrawn every
   *  frame because every one of them depends on where you're standing. */
  function renderPrompts() {
    const box = root.querySelector('.prompts');
    if (!box || !view?.game) return;
    const g = view.game;
    const out = [];

    if (g.phase === 'playing' && !taskUI) {
      const body = bodyHere();
      if (body) out.push(['R', 'Report body', 'danger']);
      const st = stationHere();
      if (st) out.push(['E', st.name, 'go']);
      else if (atButton() && g.me?.alive) out.push(['E', 'Emergency meeting', 'go']);
      if (killHere()) out.push(['Q', 'Kill', 'danger']);
      if (g.me?.impostor && g.me.alive && hud.cd > 0) {
        out.push([Math.ceil(hud.cd / TICK_HZ) + 's', 'Kill cooldown', 'wait']);
      }
    }

    const bn = el('banner');
    if (banner && performance.now() < banner.until) {
      bn.hidden = false;
      bn.textContent = banner.text;
    } else {
      bn.hidden = true;
      banner = null;
    }

    box.innerHTML = out.map(([k, label, cls]) =>
      `<div class="prompt ${cls}"><kbd>${esc(k)}</kbd>${esc(label)}</div>`).join('');
  }

  /* ---- meeting + game over ---- */

  function renderModal() {
    const modal = el('modal');
    if (!modal || taskUI) return;
    const g = view.game;

    if (g.phase === 'over') { modal.hidden = false; modal.innerHTML = overHTML(g); wireOver(); return; }
    if (g.phase === 'meeting' && g.meeting) { modal.hidden = false; renderMeeting(modal, g); return; }
    modal.hidden = true;
    modal.innerHTML = '';
  }

  function renderMeeting(modal, g) {
    const m = g.meeting;
    const voted = new Set(m.voted);
    const iCanVote = g.me?.alive && !m.myVote && m.stage === 'vote';

    const head = m.reason === 'button'
      ? `${esc(nameOf(m.byId))} called an emergency meeting`
      : `${esc(nameOf(m.byId))} found ${esc(nameOf(m.aboutId))}'s body`;

    const rows = view.seats.map((s) => {
      const alive = g.alive?.[s.id] !== false && !g.gone?.[s.id];
      const tally = m.result?.counts?.[s.id] || 0;
      const cls = ['vrow', alive ? '' : 'dead', m.myVote === s.id ? 'picked' : ''].join(' ');
      return `
        <div class="${cls}">
          <div class="chip" style="background:${COLOR_HEX[s.color]}"></div>
          <div class="nm">${esc(s.name)}${s.id === selfId ? ' (you)' : ''}</div>
          <div class="mark">${g.gone?.[s.id] ? 'left' : alive ? (voted.has(s.id) ? '✓ voted' : '') : 'dead'}</div>
          ${m.stage === 'result' ? `<div class="tally">${tally || ''}</div>` : ''}
          ${iCanVote && alive ? `<button class="votebtn" data-id="${esc(s.id)}">Vote</button>` : ''}
        </div>`;
    }).join('');

    modal.innerHTML = `
      <div class="card2 meeting">
        <div class="mhead">
          <h2>${m.stage === 'result' ? 'The vote' : 'Who was it?'}</h2>
          <div class="mtimer">${hud.meetingSecs >= 0 ? hud.meetingSecs + 's' : ''}</div>
        </div>
        <div class="msub">${head}</div>
        <div class="vlist">${rows}</div>
        ${m.stage === 'result' ? `<div class="verdict2">${esc(resultLine(m.result))}</div>` : `
          <div class="mfoot">
            ${iCanVote ? '<button class="skipbtn">Skip vote</button>'
              : g.me?.alive ? '<div class="hint">Vote cast. Waiting on the rest.</div>'
              : '<div class="hint">The dead do not vote.</div>'}
          </div>`}
      </div>`;

    if (!iCanVote) return;
    modal.querySelectorAll('.votebtn').forEach((b) => {
      b.onclick = () => intent({ t: 'vote', target: b.dataset.id });
    });
    modal.querySelector('.skipbtn').onclick = () => intent({ t: 'vote', target: null });
  }

  function resultLine(r) {
    if (r.noVotes) return 'Nobody voted. No one was ejected.';
    if (r.tied) return 'The vote was tied. No one was ejected.';
    if (r.skipped || !r.ejectedId) return 'The crew skipped. No one was ejected.';
    return `${nameOf(r.ejectedId)} was ejected. They were ${r.wasImpostor ? '' : 'not '}the impostor.`;
  }

  function overHTML(g) {
    const crewWon = g.winner === 'crew';
    const why = {
      tasks: 'The crew finished every task.',
      ejected: 'Every impostor was ejected.',
      outnumbered: 'The impostors outnumber the crew.',
    }[g.reason] || '';
    const roles = (g.impostors || []).map((id) => esc(nameOf(id))).join(' and ');

    return `
      <div class="card2 over ${crewWon ? 'crew' : 'imposter'}">
        <h2>${crewWon ? 'CREW WINS' : 'IMPOSTORS WIN'}</h2>
        <div class="cause">${esc(why)}</div>
        <div class="sub">The impostor${(g.impostors || []).length === 1 ? ' was' : 's were'} <b>${roles || '—'}</b>.</div>
        ${selfId === view.hostId
          ? '<button class="primary again">Play again</button>'
          : '<div class="hint">Waiting for the host to start another round…</div>'}
      </div>`;
  }

  function wireOver() {
    const btn = root.querySelector('.again');
    if (btn) btn.onclick = () => intent({ t: 'again' });
  }

  const nameOf = (id) => view.seats.find((s) => s.id === id)?.name || 'Someone';

  /* ========================= tab lifecycle ========================= */

  // The shell keeps every panel alive when you switch tabs, so this one has to
  // stand down on the way out: the render loop is pure waste off screen, and a
  // key held as you left would otherwise keep walking. The *host's* simulation
  // deliberately keeps running — everyone else's game is inside it.
  function onShow() {
    active = true;
    if (view?.game) startRender();
  }

  function onHide() {
    active = false;
    releaseAll();
    stopRender();
  }

  impostor.onShow = onShow;
  impostor.onHide = onHide;

  showLobby();
}

const impostor = { id: GAME, title: 'Impostor', init };

export default impostor;
