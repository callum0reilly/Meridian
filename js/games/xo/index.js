// X and O's — lobby, board, and the glue between rules.js and net.js.
//
// ---- Authority ----
// The host owns the one true game state. Nobody else ever mutates it. Players
// send *intents* ("I want square 4"); the host decides whether that's allowed,
// applies it, and broadcasts the whole room back out. See ludo/index.js for the
// long version — this game follows it exactly.
//
// ---- Why this broadcasts state whole, like Ludo and unlike Uno ----
// A noughts and crosses board has no secrets: every square is face up, and the
// only thing a client could learn early is whose turn it is, which it is being
// told anyway. So there is nothing to redact and no per-player view to build —
// `state` goes out as-is. The room object is nine squares and two names, so
// sending it whole on every change costs nothing worth optimising.

import { createRoom, joinRoom, normaliseCode } from '../../net.js';
import {
  CELLS, PLAYERS, DEFAULT_TARGET,
  createState, currentSeat, legalMoves, markOf,
  applyMove, nextRound, resetMatch,
} from './rules.js';

const GAME = 'xo';

const LOBBY_HTML = `
  <div class="lobby">
    <div class="lobby-card">
      <h2>X and O's</h2>
      <div class="lead">Create a room and share the code, or enter a friend's code to join. 2 players, first to ${DEFAULT_TARGET} rounds.</div>

      <div class="field">
        <label for="xo-name">Your name</label>
        <input id="xo-name" class="name" maxlength="12" placeholder="Nickname" autocomplete="off">
      </div>

      <button class="primary create">Create a room</button>

      <div class="or">or</div>

      <div class="field">
        <label for="xo-code">Room code</label>
        <div class="row">
          <input id="xo-code" class="code-input codein" maxlength="5" placeholder="ABC12"
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
      <h2>Waiting to start</h2>
      <div class="lead">Share this code with your opponent so they can join.</div>
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

const TABLE_HTML = `
  <div class="table relative">
    <div class="boardwrap">
      <div class="banner" hidden></div>
      <div class="grid" role="grid" aria-label="Noughts and crosses board"></div>
      <div class="status"></div>
    </div>
    <aside>
      <div class="turnbar">
        <div class="mk turnmk"></div>
        <div class="who turnwho"></div>
      </div>
      <div class="scorehead">Match <span class="tgt"></span></div>
      <ul class="scores"></ul>
      <div class="loghead">Game log</div>
      <div class="logwrap"></div>
    </aside>
  </div>
`;

// Squares are named rather than numbered in the accessible label: "top left"
// is checkable against the screen, "square 0" is not.
const CELL_NAMES = [
  'top left', 'top centre', 'top right',
  'middle left', 'centre', 'middle right',
  'bottom left', 'bottom centre', 'bottom right',
];

/**
 * Marks are drawn rather than typed. The obvious "×" and "○" glyphs are at the
 * mercy of the font — they sit off-centre, differ in weight between platforms,
 * and can't be animated. Two SVG shapes are the same everywhere.
 */
function markSVG(mark, ghost = false) {
  const cls = 'mark ' + mark.toLowerCase() + (ghost ? ' ghost' : '');
  return mark === 'X'
    ? `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true">
         <line x1="26" y1="26" x2="74" y2="74"/><line x1="74" y1="26" x2="26" y2="74"/>
       </svg>`
    : `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true">
         <circle cx="50" cy="50" r="25"/>
       </svg>`;
}

function init(root, header) {
  let room = null;      // net.js Room, once connected
  let state = null;     // the shared room object (lobby or game)
  let selfId = null;
  let myName = 'Player';

  const el = (sel) => root.querySelector('.' + sel);

  header.innerHTML = `<div class="tag xotag">2 players · first to ${DEFAULT_TARGET}</div>` +
                     '<button class="leave" hidden>Leave room</button>';
  const leaveBtn = header.querySelector('.leave');
  leaveBtn.onclick = () => {
    if (!confirm('Leave the room? This ends the game for you.')) return;
    teardown();
    showLobby();
  };

  function teardown() {
    room?.close();
    room = null; state = null; selfId = null;
    leaveBtn.hidden = true;
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
          target: DEFAULT_TARGET,
          seats: [{ id: selfId, name: myName, connected: true }],
          game: null,
        };
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
  function intent(msg) {
    if (room?.isHost) onHostMessage(msg, selfId);
    else room?.send(null, msg);
  }

  function onJoin(peerId) {
    if (state.phase !== 'lobby') {
      room.send(peerId, { t: 'denied', msg: 'That game has already started.' });
      return;
    }
    if (state.seats.length >= PLAYERS) {
      room.send(peerId, { t: 'denied', msg: 'That room is full — X and O\'s is two players.' });
    }
  }

  function onLeave(peerId) {
    const seat = state?.seats.find((s) => s.id === peerId);
    if (!seat) return;
    if (state.phase === 'lobby') {
      state.seats = state.seats.filter((s) => s.id !== peerId);
    } else {
      // With only two seats there is no game left to continue — the board just
      // freezes where it stands and the banner says why.
      seat.connected = false;
      log(`${esc(seat.name)} disconnected`);
    }
    pushAndRender();
  }

  function onHostMessage(msg, fromId) {
    if (!state) return;
    const seat = state.seats.find((s) => s.id === fromId);

    if (msg.t === 'hello') {
      if (state.phase !== 'lobby') { room.send(fromId, { t: 'denied', msg: 'That game has already started.' }); return; }
      if (seat) return;
      if (state.seats.length >= PLAYERS) { room.send(fromId, { t: 'denied', msg: 'That room is full — X and O\'s is two players.' }); return; }
      state.seats.push({
        id: fromId,
        name: String(msg.name || 'Player').trim().slice(0, 12) || 'Player',
        connected: true,
      });
      pushAndRender();
      return;
    }

    if (!seat) return; // not a player in this room

    if (msg.t === 'start') {
      if (fromId !== state.hostId || state.phase !== 'lobby' || state.seats.length !== PLAYERS) return;
      state.phase = 'playing';
      state.game = createState(state.seats, { target: state.target });
      log(`Match on — ${state.seats.map((s) => esc(s.name)).join(' vs ')}, first to ${state.target}`);
      announceRound();
      pushAndRender();
      return;
    }

    if (state.phase !== 'playing' || !state.game) return;
    const g = state.game;

    // A player who has dropped can't be played around in a two-hander, so once
    // anyone is gone the room stops accepting anything but a fresh match.
    const everyoneHere = state.seats.every((s) => s.connected);

    if (msg.t === 'next') {
      if (fromId !== state.hostId || g.phase !== 'roundover' || !everyoneHere) return;
      nextRound(g);
      log(`Round ${g.round}`);
      announceRound();
      pushAndRender();
      return;
    }

    if (msg.t === 'rematch') {
      if (fromId !== state.hostId || g.phase !== 'over' || !everyoneHere) return;
      resetMatch(g);
      log('New match');
      announceRound();
      pushAndRender();
      return;
    }

    if (msg.t !== 'move') return;
    if (g.phase !== 'playing' || !everyoneHere) return;
    if (currentSeat(g).id !== fromId) return;   // not your turn

    try {
      hostMove(fromId, msg.i);
    } catch (err) {
      // A rejected intent means a stale client, not a crash — resync them.
      console.warn('[xo] rejected intent', msg.t, err.message);
    }
    pushAndRender();
  }

  const nameOf = (id) => esc(state.seats.find((s) => s.id === id)?.name || 'Someone');

  function announceRound() {
    const g = state.game;
    const opener = currentSeat(g);
    log(`<b>${nameOf(opener.id)}</b> plays X and goes first`);
  }

  function hostMove(id, i) {
    const g = state.game;
    const res = applyMove(g, id, i);
    log(`<b>${nameOf(id)}</b> took ${CELL_NAMES[res.index]} with ${res.mark}`);

    if (!res.roundOver) {
      log(`<b>${nameOf(currentSeat(g).id)}</b> to play`);
      return;
    }
    if (res.draw) {
      log(`Round ${g.round} is a draw — nobody scores`);
      return;
    }
    log(`<b>${nameOf(id)}</b> takes round ${g.round} (${res.total}–${otherScore(g, id)})`);
    if (res.matchOver) log(`<b>${nameOf(id)}</b> wins the match!`);
  }

  const otherScore = (g, id) => {
    const other = g.seats.find((s) => s.id !== id);
    return other ? g.scores[other.id] : 0;
  };

  function log(html) {
    const g = state.game;
    if (!g) return;
    g.log.push(html);
    if (g.log.length > 60) g.log.shift();
  }

  function pushAndRender() {
    if (room?.isHost) room.broadcast({ t: 'room', room: state });
    render();
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
    else console.error('[xo] net error', err);
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

    // Seat order is mark order for round 1, so showing X and O here tells you
    // who opens before the game starts.
    el('seats').innerHTML = state.seats.map((s, i) => `
      <li>
        <div class="mk ${i === 0 ? 'x' : 'o'}">${i === 0 ? '✕' : '◯'}</div>
        <div class="nm">${esc(s.name)}</div>
        <div class="badge">${s.id === state.hostId ? 'host' : ''}${s.id === selfId ? ' · you' : ''}</div>
      </li>`).join('');

    const isHost = selfId === state.hostId;
    const startBtn = el('start');
    startBtn.hidden = !isHost;
    startBtn.disabled = state.seats.length !== PLAYERS;
    startBtn.onclick = () => intent({ t: 'start' });

    el('starthint').textContent = isHost
      ? (state.seats.length < PLAYERS ? 'Waiting for your opponent…' : 'Both players ready.')
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
    if (!root.querySelector('.grid')) {
      root.innerHTML = TABLE_HTML;
      buildGrid();
    }
    const g = state.game;
    const seat = currentSeat(g);
    const gone = state.seats.find((s) => !s.connected);
    const myTurn = seat?.id === selfId && g.phase === 'playing' && !gone;

    renderBanner(gone);
    renderBoard(g, myTurn);
    renderStatus(g, seat, myTurn, gone);
    renderSide(g, seat, myTurn);
    renderOver(g, gone);
  }

  /** The nine squares are built once and then patched, never re-created. A
   *  rebuild would restart every mark's draw-on animation on each render. */
  function buildGrid() {
    const grid = el('grid');
    for (let i = 0; i < CELLS; i++) {
      const cell = document.createElement('button');
      cell.className = 'cell';
      cell.dataset.i = String(i);
      cell.setAttribute('role', 'gridcell');
      cell.onclick = () => intent({ t: 'move', i });
      grid.appendChild(cell);
    }
  }

  function renderBoard(g, myTurn) {
    const grid = el('grid');
    const legal = new Set(myTurn ? legalMoves(g) : []);
    const win = new Set(g.line || []);
    const myMark = markOf(g, selfId);

    [...grid.children].forEach((cell, i) => {
      const mark = g.board[i];
      const playable = legal.has(i);

      // An empty square you could take shows a faint preview of *your* mark on
      // hover, so you never have to remember which one you are this round.
      const face = mark || (playable && myMark ? 'ghost' + myMark : '');
      if (cell.dataset.face !== face) {
        cell.dataset.face = face;
        cell.innerHTML = !face ? '' : mark ? markSVG(mark) : markSVG(myMark, true);
      }

      cell.classList.toggle('playable', playable);
      cell.classList.toggle('win', win.has(i));
      // Everything off the winning line fades, so the line reads at a glance.
      cell.classList.toggle('faded', !!g.line && !!mark && !win.has(i));
      cell.disabled = !playable;
      cell.setAttribute('aria-label', CELL_NAMES[i] + (mark ? `, ${mark}` : ', empty'));
    });
  }

  function renderBanner(gone) {
    const b = el('banner');
    b.hidden = !gone;
    if (gone) b.textContent = `${gone.name} disconnected — this game can't continue.`;
  }

  function renderStatus(g, seat, myTurn, gone) {
    const s = el('status');
    if (gone) { s.textContent = 'Game over'; return; }
    if (g.phase === 'over') { s.textContent = `${nameIn(g, g.winner)} wins the match`; return; }
    if (g.phase === 'roundover') {
      s.textContent = g.roundWinner === null
        ? 'Drawn round'
        : `${nameIn(g, g.roundWinner)} takes the round`;
      return;
    }
    s.textContent = myTurn ? 'Your move' : `${nameIn(g, seat.id)} is thinking…`;
  }

  function renderSide(g, seat, myTurn) {
    const mark = seat ? markOf(g, seat.id) : null;
    el('turnmk').className = 'mk turnmk ' + (mark ? mark.toLowerCase() : '');
    el('turnmk').textContent = mark === 'X' ? '✕' : mark === 'O' ? '◯' : '';

    const myMark = markOf(g, selfId);
    el('turnwho').innerHTML = g.phase === 'playing'
      ? (myTurn ? 'Your turn' : esc(nameIn(g, seat.id)) + '’s turn') +
        `<div class="sub">Round ${g.round}${myMark ? ' · you are ' + myMark : ' · spectating'}</div>`
      : `Round ${g.round} over<div class="sub">${g.roundWinner === null
          ? 'Drawn'
          : esc(nameIn(g, g.roundWinner)) + ' won it'}</div>`;

    el('tgt').textContent = '→ ' + g.target;
    el('scores').innerHTML = g.seats.map((s) => `
      <li${s.connected ? '' : ' class="gone"'}>
        <div class="mk ${markOf(g, s.id).toLowerCase()}">${markOf(g, s.id) === 'X' ? '✕' : '◯'}</div>
        <div class="nm">${esc(s.name)}${s.id === selfId ? ' <span class="you">you</span>' : ''}</div>
        <div class="pts">${g.scores[s.id]}</div>
      </li>`).join('') +
      `<li class="drawrow"><div class="mk"></div><div class="nm">Drawn rounds</div><div class="pts">${g.draws}</div></li>`;

    el('logwrap').innerHTML = g.log.slice().reverse()
      .map((l) => `<div class="logline">${l}</div>`).join('');
  }

  const nameIn = (g, id) => g.seats.find((s) => s.id === id)?.name || 'Someone';

  function renderOver(g, gone) {
    const existing = root.querySelector('.over');
    // A dropped opponent already has the banner; a modal on top of it would
    // just be a second way to say the same thing.
    if (g.phase === 'playing' || gone) { existing?.remove(); return; }
    if (existing) return;

    const isHost = selfId === state.hostId;
    const matchOver = g.phase === 'over';
    const drew = g.roundWinner === null;

    const title = matchOver
      ? `${esc(nameIn(g, g.winner))} wins the match!`
      : drew ? 'Drawn round' : `${esc(nameIn(g, g.roundWinner))} takes it`;

    const sub = matchOver
      ? g.seats.map((s) => `${esc(s.name)} ${g.scores[s.id]}`).join(' — ')
      : drew ? 'Nobody scores. Marks swap for the next one.'
             : `Round ${g.round} of the race to ${g.target}`;

    const box = document.createElement('div');
    box.className = 'over';
    box.innerHTML = `
      <div class="card2">
        <h2>${title}</h2>
        <div class="sub">${sub}</div>
        ${isHost
          ? `<button class="primary go">${matchOver ? 'New match' : 'Next round'}</button>`
          : '<div class="hint">Waiting for the host…</div>'}
      </div>`;
    root.querySelector('.table').appendChild(box);
    box.querySelector('.go')?.addEventListener('click', () => intent({ t: matchOver ? 'rematch' : 'next' }));
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  showLobby();
}

export default { id: 'xo', title: "X and O's", init };
