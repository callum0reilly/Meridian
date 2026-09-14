// Ludo — lobby, board, and the glue between rules.js and net.js.
//
// ---- Authority ----
// The host owns the one true game state. Nobody else ever mutates it. Players
// send *intents* ("I want to roll", "I want to move token 2"); the host decides
// whether that's allowed, applies it, and broadcasts the whole room back out.
//
//   client: click ──► {t:'move', i} ──► host: validate → apply → broadcast
//   client: render ◄────── {t:'room', room} ◄─────────────────┘
//
// The host runs its own clicks through exactly the same path (see `intent`), so
// there is only one code path to reason about and the host can't accidentally
// cheat by mutating state directly from a click handler.
//
// The room object is small (4 players x 4 tokens), so it's simply sent whole on
// every change rather than diffed.

//
// ---- Turns nobody has to click ----
// Computer players, and two house rules, take turns with no decision in them
// off your hands: with exactly one token in play the dice roll themselves, and
// a roll with only one real move plays it. `drive` runs on the host after
// every change and schedules whichever of those applies, through the same
// `hostRoll`/`hostMove` a click would reach.

import { createRoom, joinRoom, normaliseCode } from '../../net.js';
import {
  COLORS, START, SAFE, TRACK_LEN, HOME_STEP, YARD, TOKENS_PER_PLAYER, YARD_MISSES,
  createState, currentSeat, applyRoll, applyMove, passTurn, releaseToken,
  absSquare, isHome, inYard, inHomeColumn, rollDice, tokensInPlay, autoRolls, onlyMove,
} from './rules.js';
import { chooseMove } from './ai.js';
import { botSeat, seatBadge, soloHTML, ADD_BOT_HTML, bindBotControls, kickButton, thinkDelay } from '../../bots.js';
import { GRID, TRACK, HOME_COLUMN, YARD_ORIGIN, YARD_SLOTS, HOME_SLOTS, cellCentre } from './board.js';

const GAME = 'ludo';
const MAX_PLAYERS = 4;
const NS = 'http://www.w3.org/2000/svg';

const LOBBY_HTML = `
  <div class="lobby">
    <div class="lobby-card">
      <h2>Ludo</h2>
      <div class="lead">Create a room and share the code, enter a friend's code to join, or play the computer. 2–4 players.</div>

      <div class="field">
        <label for="ludo-name">Your name</label>
        <input id="ludo-name" class="name" maxlength="12" placeholder="Nickname" autocomplete="off">
      </div>

      <button class="primary create">Create a room</button>

      <div class="or">or</div>

      <div class="field">
        <label for="ludo-code">Room code</label>
        <div class="row">
          <input id="ludo-code" class="code-input codein" maxlength="5" placeholder="ABC12"
                 autocomplete="off" autocorrect="off" spellcheck="false">
          <button class="join">Join</button>
        </div>
      </div>
${soloHTML({ counts: 3 })}

      <div class="err lobbyerr"></div>
    </div>
  </div>
`;

const WAIT_HTML = `
  <div class="lobby">
    <div class="lobby-card">
      <h2>Waiting to start</h2>
      <div class="lead">Share this code with your friends so they can join.</div>
      <div class="code-display">
        <div class="cap">Room code</div>
        <div class="code codeval"></div>
        <button class="copy">Copy code</button>
      </div>
      <ul class="seats"></ul>
${ADD_BOT_HTML}
      <button class="primary start">Start game</button>
      <div class="hint starthint"></div>
      <div class="err waiterr"></div>
    </div>
  </div>
`;

const TABLE_HTML = `
  <div class="table relative">
    <div class="boardwrap"><svg class="board" viewBox="0 0 ${GRID} ${GRID}"></svg></div>
    <aside>
      <div class="turnbar">
        <div class="dot turndot"></div>
        <div class="who turnwho"></div>
      </div>
      <div class="dicerow">
        <div class="dice"></div>
        <button class="primary rollbtn">Roll</button>
      </div>
      <div class="yardnote" role="status" hidden></div>
      <div class="loghead">Game log</div>
      <div class="logwrap"></div>
    </aside>
  </div>
`;

// Pip layout per dice face, as 3x3 grid cells (0-8).
const PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function init(root, header) {
  let room = null;        // net.js Room, once connected
  let state = null;       // the shared room object (lobby or game)
  let selfId = null;
  let myName = 'Player';
  let rolling = false;    // suppresses double-clicks during the dice animation
  let shownDice = null;   // the dice as last drawn, to shake them when a new roll lands
  let driveTimer = null;  // host: the pending automatic roll or move

  const el = (sel) => root.querySelector('.' + sel);

  header.innerHTML = '<div class="tag ludotag">Classic rules · 2–4 players</div>' +
                     '<button class="leave" hidden>Leave room</button>';
  const leaveBtn = header.querySelector('.leave');
  leaveBtn.onclick = () => {
    const q = room ? 'Leave the room? This ends the game for you.' : 'End this game and go back to the lobby?';
    if (!confirm(q)) return;
    teardown();
    showLobby();
  };

  function teardown() {
    clearTimeout(driveTimer);
    driveTimer = null;
    room?.close();
    room = null; state = null; selfId = null; shownDice = null;
    leaveBtn.hidden = true;
    leaveBtn.textContent = 'Leave room';
  }

  /* ============================ lobby ============================ */

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

    // No room at all: this browser is the host, and everyone else is a bot.
    el('solo').onclick = () => {
      takeName();
      const level = el('sololevel').value;
      const count = Number(el('solocount').value) || 1;
      selfId = 'you';
      const seats = [{ id: selfId, name: myName, color: COLORS[0], connected: true }];
      for (let k = 0; k < count; k++) seats.push(botSeat(seats, level, { color: COLORS[seats.length] }));
      state = { phase: 'lobby', code: null, hostId: selfId, seats, game: null };
      leaveBtn.textContent = 'End game';
      leaveBtn.hidden = false;
      intent({ t: 'start' });
    };

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
        leaveBtn.textContent = 'Leave room';
        leaveBtn.hidden = false;
        pushAndRender();
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
        // The host replies with the room; until then, sit on a spinner.
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

  /* ======================== host: intents ======================== */

  // Every action funnels through here on the host — including the host's own.
  // With no room it is a solo game against the computer, and we are the host.
  function intent(msg) {
    if (!room || room.isHost) onHostMessage(msg, selfId);
    else room.send(null, msg);
  }

  function onJoin(peerId) {
    // Seats are handed out on arrival; the room object goes back on 'hello'.
    if (state.phase !== 'lobby') {
      room.send(peerId, { t: 'denied', msg: 'That game has already started.' });
      return;
    }
    if (state.seats.length >= MAX_PLAYERS) {
      room.send(peerId, { t: 'denied', msg: 'That room is full (4 players).' });
    }
  }

  function onLeave(peerId) {
    const seat = state?.seats.find((s) => s.id === peerId);
    if (!seat) return;
    if (state.phase === 'lobby') {
      state.seats = state.seats.filter((s) => s.id !== peerId);
      reColour();
    } else {
      seat.connected = false;
      log(`${seat.name} disconnected`);
      // Don't strand the game on a vanished player's turn.
      if (state.game.phase === 'playing' && currentSeat(state.game).id === peerId) {
        passTurn(state.game);
      }
    }
    pushAndRender();
  }

  // Colours track seat order, so they stay contiguous when someone leaves the lobby.
  function reColour() {
    state.seats.forEach((s, i) => { s.color = COLORS[i]; });
  }

  function onHostMessage(msg, fromId) {
    if (!state) return;
    const seat = state.seats.find((s) => s.id === fromId);

    if (msg.t === 'hello') {
      if (state.phase !== 'lobby') { room.send(fromId, { t: 'denied', msg: 'That game has already started.' }); return; }
      if (seat) return;
      if (state.seats.length >= MAX_PLAYERS) { room.send(fromId, { t: 'denied', msg: 'That room is full (4 players).' }); return; }
      state.seats.push({
        id: fromId,
        name: String(msg.name || 'Player').trim().slice(0, 12) || 'Player',
        color: COLORS[state.seats.length],
        connected: true,
      });
      pushAndRender();
      return;
    }

    if (!seat) return; // not a player in this room

    if (msg.t === 'addbot') {
      if (fromId !== state.hostId || state.phase !== 'lobby' || state.seats.length >= MAX_PLAYERS) return;
      state.seats.push(botSeat(state.seats, msg.level, { color: COLORS[state.seats.length] }));
      pushAndRender();
      return;
    }

    if (msg.t === 'kick') {
      if (fromId !== state.hostId || state.phase !== 'lobby') return;
      state.seats = state.seats.filter((s) => !(s.bot && s.id === msg.id));
      reColour();
      pushAndRender();
      return;
    }

    if (msg.t === 'start') {
      if (fromId !== state.hostId || state.phase !== 'lobby' || state.seats.length < 2) return;
      state.phase = 'playing';
      state.game = createState(state.seats);
      log(`Game on — ${state.seats.map((s) => s.name).join(', ')}`);
      log(`${currentSeat(state.game).name} to roll`);
      pushAndRender();
      return;
    }

    if (state.phase !== 'playing' || state.game.phase !== 'playing') return;
    const g = state.game;
    if (currentSeat(g).id !== fromId) return;   // not your turn

    if (msg.t === 'roll') {
      if (g.dice !== null) return;              // already rolled this turn
      hostRoll();
      return;
    }

    if (msg.t === 'move') {
      if (g.dice === null || !g.moves.includes(msg.i)) return;
      hostMove(msg.i);
      return;
    }

    if (msg.t === 'rematch') {
      if (fromId !== state.hostId || state.game.phase !== 'over') return;
      state.game = createState(state.seats);
      state.game.log = [];
      log('New game');
      log(`${currentSeat(state.game).name} to roll`);
      pushAndRender();
    }
  }

  function hostRoll() {
    const g = state.game;
    const seat = currentSeat(g);
    const dice = rollDice();
    const res = applyRoll(g, dice);
    log(`<b>${seat.name}</b> rolled ${dice}`);

    if (res.forfeit) {
      log(`Three 6s in a row — <b>${seat.name}</b> loses the turn`);
      passTurn(g);
      pushAndRender();
      announceTurn();
      return;
    }
    pushAndRender();

    if (res.stuck) {
      // Nothing legal. Let players see the roll before the turn moves on.
      setTimeout(() => {
        if (!state || state.game !== g || g.dice !== dice) return;
        if (res.release) {
          releaseToken(g);
          log(`${YARD_MISSES} misses in a row — a <b>${seat.name}</b> token comes out for free`);
        } else if (res.misses) {
          log(`No 6 for <b>${seat.name}</b> — miss ${res.misses} of ${YARD_MISSES}`);
        } else {
          log(`No legal move for <b>${seat.name}</b>`);
        }
        passTurn(g, { keepSeat: false });
        announceTurn();
      }, 1300);
    }
  }

  function hostMove(i) {
    const g = state.game;
    const seat = currentSeat(g);
    const res = applyMove(g, i);

    for (const c of res.captured) {
      const victim = g.seats.find((s) => s.color === c.color);
      log(`<b>${seat.name}</b> knocked ${victim?.name || c.color} back to base`);
    }
    if (isHome(res.to)) log(`<b>${seat.name}</b> got a token home`);

    if (res.won) {
      log(`<b>${seat.name}</b> wins!`);
      pushAndRender();
      return;
    }
    passTurn(g, { keepSeat: res.extraTurn });
    if (res.extraTurn) log(`<b>${seat.name}</b> goes again`);
    pushAndRender();
    announceTurn();
  }

  function announceTurn() {
    const g = state?.game;
    if (g?.phase === 'playing') {
      const seat = currentSeat(g);
      log(`${seat.name} to roll` + (autoRolls(g) && !seat.bot ? ' (one token in play — rolls itself)' : ''));
    }
    pushAndRender();
  }

  /** Host only: schedule the roll or move nobody needs to click for — a
   *  computer player's, or a person's turn with no decision in it. Called
   *  after every change, so it cancels whatever it had pending first; a stale
   *  timer then has nothing left to fire. */
  function drive() {
    clearTimeout(driveTimer);
    driveTimer = null;
    if (room && !room.isHost) return;
    const g = state?.game;
    if (!g || state.phase !== 'playing' || g.phase !== 'playing') return;
    const seat = currentSeat(g);

    if (g.dice === null) {
      if (!seat.bot && !autoRolls(g)) return;
      driveTimer = setTimeout(() => {
        if (state?.game === g && g.dice === null && currentSeat(g) === seat) hostRoll();
      }, seat.bot ? thinkDelay(700) : 900);
      return;
    }

    if (!g.moves.length) return;
    const pick = onlyMove(g) ?? (seat.bot ? chooseMove(g, seat.bot) : null);
    if (pick === null) return;
    const dice = g.dice;
    driveTimer = setTimeout(() => {
      if (state?.game === g && g.dice === dice && currentSeat(g) === seat && g.moves.includes(pick)) hostMove(pick);
    }, seat.bot ? thinkDelay(500) : 700);
  }

  function log(html) {
    const g = state.game;
    if (!g) return;
    g.log.push(html);
    if (g.log.length > 60) g.log.shift();
  }

  function pushAndRender() {
    if (room?.isHost) room.broadcast({ t: 'room', room: state });
    render();
    drive();
  }

  /* ======================= client: messages ====================== */

  function onClientMessage(msg) {
    if (msg.t === 'room') {
      const first = !state;
      state = msg.room;
      render();
      if (first) leaveBtn.hidden = false;
    } else if (msg.t === 'denied') {
      teardown();
      showLobby(msg.msg);
    }
  }

  function onHostGone() {
    if (!state) return;
    teardown();
    showLobby('The host left, so the room closed. WebRTC games live in the host\'s browser tab.');
  }

  function onNetError(err) {
    const target = root.querySelector('.lobbyerr') || root.querySelector('.waiterr');
    if (target) target.textContent = err.message;
    else console.error('[ludo] net error', err);
  }

  /* ============================ render =========================== */

  function render() {
    if (!state) return;
    if (state.phase === 'lobby') renderWait();
    else renderTable();
  }

  function renderWait() {
    if (!root.querySelector('.codeval')) root.innerHTML = WAIT_HTML;
    el('codeval').textContent = state.code;

    const isHost = selfId === state.hostId;
    el('seats').innerHTML = state.seats.map((s) => `
      <li>
        <div class="dot ${s.color}"></div>
        <div class="nm">${esc(s.name)}</div>
        <div class="badge">${seatBadge(s, state.hostId, selfId)}</div>
        ${kickButton(s, isHost)}
      </li>`).join('');
    bindBotControls(root, { isHost, full: state.seats.length >= MAX_PLAYERS, intent });

    const startBtn = el('start');
    startBtn.hidden = !isHost;
    startBtn.disabled = state.seats.length < 2;
    startBtn.onclick = () => intent({ t: 'start' });

    el('starthint').textContent = isHost
      ? (state.seats.length < 2 ? 'Waiting for at least one more player — or add a computer player.' : `${state.seats.length} players ready.`)
      : 'Waiting for the host to start…';

    const copy = el('copy');
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(state.code);
        copy.textContent = 'Copied!';
      } catch {
        copy.textContent = 'Press Ctrl+C';   // clipboard needs https or localhost
      }
      setTimeout(() => { copy.textContent = 'Copy code'; }, 1400);
    };
  }

  function renderTable() {
    if (!root.querySelector('.board')) {
      root.innerHTML = TABLE_HTML;
      drawBoard(el('board'));
    }
    const g = state.game;
    const seat = currentSeat(g);
    const mySeat = g.seats.find((s) => s.id === selfId);
    const myTurn = seat?.id === selfId && g.phase === 'playing';

    el('turndot').className = 'dot turndot ' + (g.winner || seat.color);
    el('turnwho').innerHTML = g.phase === 'over'
      ? `${esc(g.seats.find((s) => s.color === g.winner)?.name || g.winner)} wins!`
      : `${seat.id === selfId ? 'Your turn' : esc(seat.name) + '’s turn'}` +
        `<div class="sub">You are ${mySeat ? mySeat.color : 'spectating'}${g.dice ? ' · rolled ' + g.dice : ''}</div>`;

    renderDice(el('dice'), g.dice);
    // Shake on every fresh roll, whoever made it — a bot's or an automatic
    // roll deserves the same moment as a click.
    if (g.dice !== null && shownDice === null) {
      const dice = el('dice');
      dice.classList.remove('rolling');
      void dice.offsetWidth;            // restart the animation
      dice.classList.add('rolling');
      setTimeout(() => dice.classList.remove('rolling'), 400);
    }
    shownDice = g.dice;

    const autoRoll = g.phase === 'playing' && autoRolls(g);
    const autoMove = g.dice !== null && onlyMove(g) !== null;
    const rollBtn = el('rollbtn');
    rollBtn.hidden = g.phase === 'over';
    rollBtn.disabled = !myTurn || g.dice !== null || rolling || autoRoll;
    rollBtn.textContent = !myTurn ? (seat.bot ? `${seat.name} is playing…` : 'Waiting…')
      : g.dice === null ? (autoRoll ? 'Rolling for you…' : 'Roll')
      : !g.moves.length ? 'No move'
      : autoMove ? 'Moving for you…' : 'Pick a token';
    rollBtn.onclick = () => {
      rolling = true;
      setTimeout(() => { rolling = false; render(); }, 400);
      intent({ t: 'roll' });
    };

    renderYardNote(g, seat);

    el('logwrap').innerHTML = g.log.slice().reverse()
      .map((l) => `<div class="logline">${l}</div>`).join('');

    drawTokens(el('board'), g, myTurn);
    renderOver(g);
  }

  /** The house rule for a player with nothing on the board, made visible:
   *  how many misses they've had, and what happens on the last one. */
  function renderYardNote(g, seat) {
    const note = el('yardnote');
    const color = seat.color;
    const show = g.phase === 'playing' && tokensInPlay(g, color) === 0 && g.tokens[color].some(inYard);
    note.hidden = !show;
    if (!show) return;

    const misses = Math.min(g.misses?.[color] ?? 0, YARD_MISSES);
    const pips = Array.from({ length: YARD_MISSES }, (_, k) => `<i class="${k < misses ? 'on' : ''}"></i>`).join('');
    const who = seat.id === selfId ? 'You have' : `${esc(seat.name)} has`;
    const next = misses >= YARD_MISSES
      ? `<span class="yn-free">That's ${YARD_MISSES} — a token comes out for free!</span>`
      : misses === YARD_MISSES - 1
        ? 'Roll a 6 to come out. <span class="yn-free">One more miss and a token comes out free.</span>'
        : `Roll a 6 to come out. After ${YARD_MISSES} misses a token comes out free.`;
    note.innerHTML = `
      <div class="yn-head">${who} no tokens on the board</div>
      <div class="yn-row"><span class="yn-pips">${pips}</span><span>${misses} of ${YARD_MISSES} misses</span></div>
      <div class="yn-sub">${next}</div>`;
  }

  function renderOver(g) {
    const existing = root.querySelector('.over');
    if (g.phase !== 'over') { existing?.remove(); return; }
    if (existing) return;

    const winner = g.seats.find((s) => s.color === g.winner);
    const box = document.createElement('div');
    box.className = 'over';
    box.innerHTML = `
      <div class="card">
        <h2>${esc(winner?.name || g.winner)} wins!</h2>
        <div class="sub">All four tokens home.</div>
        ${selfId === state.hostId ? '<button class="primary rematch">Play again</button>' : '<div class="hint">Waiting for the host…</div>'}
      </div>`;
    root.querySelector('.table').appendChild(box);
    box.querySelector('.rematch')?.addEventListener('click', () => intent({ t: 'rematch' }));
  }

  function renderDice(node, v) {
    node.innerHTML = '';
    if (!v) return;
    const on = new Set(PIPS[v]);
    for (let i = 0; i < 9; i++) {
      const pip = document.createElement('i');
      if (!on.has(i)) pip.style.visibility = 'hidden';
      node.appendChild(pip);
    }
  }

  /* ---------- board drawing ---------- */

  function drawBoard(svg) {
    svg.innerHTML = '';
    const add = (tag, attrs, cls) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (cls) n.setAttribute('class', cls);
      svg.appendChild(n);
      return n;
    };

    add('rect', { x: 0, y: 0, width: GRID, height: GRID, fill: '#f4f1ea' });

    // yards
    for (const color of COLORS) {
      const [c, r] = YARD_ORIGIN[color];
      add('rect', { x: c, y: r, width: 6, height: 6, rx: .3 }, 'yard cell ' + color);
      add('rect', { x: c + .8, y: r + .8, width: 4.4, height: 4.4, rx: .3 }, 'yard-inner');
    }

    // shared track
    TRACK.forEach(([c, r], idx) => {
      const startColor = COLORS.find((col) => START[col] === idx);
      add('rect', { x: c, y: r, width: 1, height: 1 }, 'cell' + (startColor ? ' ' + startColor : ''));
      // Star marks a safe square (start squares are safe too, but already coloured).
      if (SAFE.has(idx) && !startColor) {
        add('path', { d: starPath(c + .5, r + .5, .34, .15), }, 'star');
      }
    });

    // home columns
    for (const color of COLORS) {
      for (const [c, r] of HOME_COLUMN[color]) {
        add('rect', { x: c, y: r, width: 1, height: 1 }, 'cell ' + color);
      }
    }

    // centre home: four triangles pointing in
    const tri = {
      red: `M6,6 L6,9 L7.5,7.5 Z`,
      green: `M6,6 L9,6 L7.5,7.5 Z`,
      yellow: `M9,6 L9,9 L7.5,7.5 Z`,
      blue: `M6,9 L9,9 L7.5,7.5 Z`,
    };
    for (const color of COLORS) add('path', { d: tri[color] }, 'cell ' + color);

    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'tokens');
    svg.appendChild(g);
  }

  function starPath(cx, cy, R, r) {
    let d = '';
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 ? r : R;
      const a = -Math.PI / 2 + i * Math.PI / 5;
      d += (i ? 'L' : 'M') + (cx + rad * Math.cos(a)).toFixed(3) + ',' + (cy + rad * Math.sin(a)).toFixed(3);
    }
    return d + 'Z';
  }

  /** Where a token sits, in grid units, before stack-spreading. */
  function tokenSpot(color, i, r) {
    if (inYard(r)) return YARD_SLOTS[color][i];
    if (isHome(r)) return HOME_SLOTS[color][i];
    if (inHomeColumn(r)) return cellCentre(HOME_COLUMN[color][r - 51]);
    return cellCentre(TRACK[absSquare(color, r)]);
  }

  function drawTokens(svg, g, myTurn) {
    const layer = svg.querySelector('.tokens');
    layer.innerHTML = '';

    // Group tokens sharing a square so a stack doesn't render as one circle.
    const spots = new Map();
    for (const seat of g.seats) {
      g.tokens[seat.color].forEach((r, i) => {
        const [x, y] = tokenSpot(seat.color, i, r);
        const key = x.toFixed(2) + ':' + y.toFixed(2);
        if (!spots.has(key)) spots.set(key, []);
        spots.get(key).push({ color: seat.color, i, x, y });
      });
    }

    const myColor = g.seats.find((s) => s.id === selfId)?.color;
    for (const group of spots.values()) {
      group.forEach((t, k) => {
        // Fan a stack out along a short diagonal so each token stays clickable.
        const off = group.length > 1 ? (k - (group.length - 1) / 2) * 0.16 : 0;
        const movable = myTurn && t.color === myColor && g.moves.includes(t.i);

        const node = document.createElementNS(NS, 'g');
        node.setAttribute('class', 'token' + (movable ? ' movable' : ''));
        node.setAttribute('transform', `translate(${(t.x + off).toFixed(3)} ${(t.y - off).toFixed(3)})`);

        const body = document.createElementNS(NS, 'circle');
        body.setAttribute('r', .33);
        body.setAttribute('fill', `var(--${t.color})`);
        node.appendChild(body);

        if (group.length > 1) {
          const n = document.createElementNS(NS, 'text');
          n.setAttribute('text-anchor', 'middle');
          n.setAttribute('y', .13);
          n.setAttribute('font-size', .34);
          n.setAttribute('fill', '#fff');
          n.textContent = group.length;
          if (k === group.length - 1) node.appendChild(n);
        }

        if (movable) {
          const ring = document.createElementNS(NS, 'circle');
          ring.setAttribute('r', .45);
          ring.setAttribute('class', 'ring');
          node.appendChild(ring);
          node.addEventListener('click', () => intent({ t: 'move', i: t.i }));
        }
        layer.appendChild(node);
      });
    }

    // Each yard with misses against it wears the count on its top edge.
    for (const seat of g.seats) {
      const misses = g.misses?.[seat.color] ?? 0;
      if (!misses || tokensInPlay(g, seat.color) > 0) continue;
      const [c, r] = YARD_ORIGIN[seat.color];
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('class', 'yardcount');
      label.setAttribute('x', c + 3);
      label.setAttribute('y', r + .58);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', .46);
      label.textContent = `Misses ${Math.min(misses, YARD_MISSES)}/${YARD_MISSES}`;
      layer.appendChild(label);
    }
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  showLobby();
}

export default { id: 'ludo', title: 'Ludo', init };
