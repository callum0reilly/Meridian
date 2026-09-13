// Checkers — lobby, board, and the glue between rules.js and net.js.
//
// This is the chess screen with different pieces, on purpose: same lobby and
// room flow, same side panel, and the same "play on this device" mode that runs
// every intent through `onHostMessage`, so a local game obeys exactly the rules
// an online one does. chess/index.js explains all of that; the notes here only
// cover what checkers does differently.
//
// ---- Moving pieces ----
// A capture can be several jumps long, and two routes can end on the same
// square, so a move is a *path*, not a from/to pair. Pick up a piece, then
// click (or drag to) where it should end up. If only one route ends on that
// square, that route is played in one go. If the square is the next hop of a
// route, the piece is walked there and you carry on from it. So a multi-jump
// with a choice in it is played hop by hop, and one without is a single click.
//
// Only pieces that can legally move are marked movable. Captures are
// compulsory, so while one is on, those are exactly the pieces that can take.

import { createRoom, joinRoom, normaliseCode } from '../../net.js';
import {
  PLAYERS,
  createState, currentSeat, colourOfSeat, colourOf, isKing, isDark, squareNumber,
  legalMoves, movesFrom, mustCapture,
  applyMove, resign, offerDraw, acceptDraw, declineDraw, agreeDraw, rematch,
} from './rules.js';

const GAME = 'checkers';

const LOBBY_HTML = `
  <div class="lobby">
    <div class="lobby-card">
      <h2>Checkers</h2>
      <div class="lead">Play both sides on this device, or create a room and share the code with a friend. 2 players, standard 8×8 rules — captures are compulsory.</div>

      <div class="field">
        <label for="checkers-name">Your name</label>
        <input id="checkers-name" class="name" maxlength="12" placeholder="Nickname" autocomplete="off">
      </div>

      <button class="primary local">Play on this device</button>
      <button class="create">Create a room</button>

      <div class="or">or</div>

      <div class="field">
        <label for="checkers-code">Room code</label>
        <div class="row">
          <input id="checkers-code" class="code-input codein" maxlength="5" placeholder="ABC12"
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
  <div class="table">
    <div class="boardwrap">
      <div class="banner" hidden></div>
      <div class="board" role="group" aria-label="Checkers board"></div>
      <div class="status" role="status"></div>
    </div>
    <aside>
      <div class="turnbar">
        <div class="chip turnchip"></div>
        <div class="who turnwho"></div>
      </div>
      <div class="offer" hidden></div>
      <div class="actions"></div>
      <div class="scorehead">Games won</div>
      <ul class="scores"></ul>
      <div class="movehead">Moves</div>
      <ol class="moves"></ol>
    </aside>
  </div>
`;

const COLOUR_NAMES = { b: 'Black', w: 'White' };

const CROWN = '<svg class="crown" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M3 18.5h18L22.5 7l-5.5 4.5L12 4l-5 7.5L1.5 7z"/></svg>';

const pieceHTML = (p) => `<span class="man ${colourOf(p)}${isKing(p) ? ' king' : ''}">${isKing(p) ? CROWN : ''}</span>`;
const pieceName = (p) => `${COLOUR_NAMES[colourOf(p)].toLowerCase()} ${isKing(p) ? 'king' : 'man'}`;

function init(root, header) {
  let room = null;      // net.js Room, once connected
  let state = null;     // the shared room object (lobby or game)
  let selfId = null;
  let myName = 'Player';
  let local = false;    // both sides on this device, no room
  let selected = null;  // square index of the piece picked up
  let hops = [];        // squares it has been walked to so far, mid multi-jump
  let drag = null;      // { from, pointerId, x0, y0, size, moved, wasSelected, ghost }
  let hideOverFor = 0;  // game number whose result card was dismissed to see the board

  const el = (sel) => root.querySelector('.' + sel);

  header.innerHTML = '<div class="tag checkerstag">2 players · captures are compulsory</div>' +
                     '<button class="leave" hidden>Leave room</button>';
  const leaveBtn = header.querySelector('.leave');
  leaveBtn.onclick = () => {
    if (local) {
      if (state?.game?.phase === 'playing' && !confirm('End this game and go back to the lobby?')) return;
    } else if (!confirm('Leave the room? This ends the game for you.')) {
      return;
    }
    teardown();
    showLobby();
  };

  function teardown() {
    endDrag();
    room?.close();
    room = null; state = null; selfId = null;
    local = false; selected = null; hops = []; hideOverFor = 0;
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

    el('local').onclick = () => {
      takeName();
      // The seats are the colours here: whoever sits on Black's side of the
      // laptop stays Black, so a rematch doesn't swap and the board never flips.
      const seats = [
        { id: 'black', name: 'Black', connected: true },
        { id: 'white', name: 'White', connected: true },
      ];
      local = true;
      state = {
        phase: 'playing',
        code: null,
        hostId: null,
        seats,
        game: createState(seats, { black: 0, swapOnRematch: false }),
      };
      leaveBtn.textContent = 'End game';
      leaveBtn.hidden = false;
      render();
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
          seats: [{ id: selfId, name: myName, connected: true }],
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
        leaveBtn.textContent = 'Leave room';
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

  // Every action funnels through here — the host's own, and on one laptop
  // everyone's, applied as whoever is to move.
  function intent(msg) {
    if (local) onHostMessage(msg, currentSeat(state.game).id);
    else if (room?.isHost) onHostMessage(msg, selfId);
    else room?.send(null, msg);
  }

  function onJoin(peerId) {
    if (state.phase !== 'lobby') {
      room.send(peerId, { t: 'denied', msg: 'That game has already started.' });
      return;
    }
    if (state.seats.length >= PLAYERS) {
      room.send(peerId, { t: 'denied', msg: 'That room is full — checkers is two players.' });
    }
  }

  function onLeave(peerId) {
    const seat = state?.seats.find((s) => s.id === peerId);
    if (!seat) return;
    if (state.phase === 'lobby') {
      state.seats = state.seats.filter((s) => s.id !== peerId);
    } else {
      // Nobody can take over the other side, so the board freezes where it
      // stands and the banner says why.
      seat.connected = false;
    }
    pushAndRender();
  }

  function onHostMessage(msg, fromId) {
    if (!state) return;
    const seat = state.seats.find((s) => s.id === fromId);

    if (msg.t === 'hello') {
      if (state.phase !== 'lobby') { room.send(fromId, { t: 'denied', msg: 'That game has already started.' }); return; }
      if (seat) return;
      if (state.seats.length >= PLAYERS) { room.send(fromId, { t: 'denied', msg: 'That room is full — checkers is two players.' }); return; }
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
      state.game = createState(state.seats);
      pushAndRender();
      return;
    }

    if (state.phase !== 'playing' || !state.game) return;
    const g = state.game;
    // A player who has dropped can't be played around in a two-hander.
    if (!state.seats.every((s) => s.connected)) return;

    try {
      switch (msg.t) {
        case 'move': applyMove(g, fromId, { from: msg.from, path: msg.path }); break;
        case 'resign': resign(g, fromId); break;
        case 'draw-offer': if (!local) offerDraw(g, fromId); break;
        case 'draw-accept': if (!local) acceptDraw(g, fromId); break;
        case 'draw-decline': if (!local) declineDraw(g, fromId); break;
        case 'draw-agree': if (local) agreeDraw(g); break;
        case 'rematch': if (local || fromId === state.hostId) rematch(g); break;
        default: return;
      }
    } catch (err) {
      // A rejected intent means a stale client, not a crash — resync them.
      console.warn('[checkers] rejected intent', msg.t, err.message);
    }
    pushAndRender();
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
    else console.error('[checkers] net error', err);
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

    el('seats').innerHTML = state.seats.map((s) => `
      <li>
        <div class="nm">${esc(s.name)}</div>
        <div class="badge">${s.id === state.hostId ? 'host' : ''}${s.id === selfId ? ' · you' : ''}</div>
      </li>`).join('');

    const isHost = selfId === state.hostId;
    const startBtn = el('start');
    startBtn.hidden = !isHost;
    startBtn.disabled = state.seats.length !== PLAYERS;
    startBtn.onclick = () => intent({ t: 'start' });

    el('starthint').textContent = isHost
      ? (state.seats.length < PLAYERS ? 'Waiting for your opponent…' : 'Both players ready. Colours are drawn at random.')
      : 'Waiting for the host to start… Colours are drawn at random.';

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

  const nameIn = (g, id) => g.seats.find((s) => s.id === id)?.name || 'Someone';
  const goneSeat = () => state.seats.find((s) => !s.connected);

  /** May this screen move a piece right now? */
  function canAct() {
    const g = state?.game;
    if (!g || state.phase !== 'playing' || g.phase !== 'playing' || goneSeat()) return false;
    return local || currentSeat(g).id === selfId;
  }

  function renderTable() {
    if (!root.querySelector('.board')) {
      root.innerHTML = TABLE_HTML;
      buildBoard();
    }
    const g = state.game;
    const gone = goneSeat();
    const acting = canAct();

    // A selection only survives a render if that piece still has the route
    // it was halfway along.
    if (selected !== null && (!acting || !candidates().length)) { selected = null; hops = []; }
    if (!acting) endDrag();

    renderBanner(gone);
    renderBoard(g, acting);
    renderStatus(g, acting, gone);
    renderSide(g, gone);
    renderOver(g, gone);
  }

  /** The 64 squares are built once and then patched, never re-created — a
   *  rebuild mid-drag would pull the square out from under the pointer. Only
   *  the dark ones are ever played on, so only they are buttons. */
  function buildBoard() {
    const board = el('board');
    for (let i = 0; i < 64; i++) {
      const dark = isDark(i);
      const sq = document.createElement(dark ? 'button' : 'div');
      sq.className = 'sq ' + (dark ? 'dark' : 'light');
      sq.dataset.i = String(i);
      if (dark) {
        sq.dataset.n = String(squareNumber(i));
        sq.innerHTML = `<span class="pc"></span><span class="num">${squareNumber(i)}</span>`;
      }
      board.appendChild(sq);
    }
    board.addEventListener('pointerdown', onPointerDown);
    board.addEventListener('click', (e) => {
      if (e.detail !== 0) return;   // a real pointer click; pointerdown already handled it
      const sq = e.target.closest('.sq');
      if (sq) pick(Number(sq.dataset.i));
    });
  }

  /** Routes still open for the piece in hand, given the hops taken so far. */
  function candidates() {
    if (selected === null) return [];
    return movesFrom(state.game, selected).filter((m) => hops.every((sq, k) => m.path[k] === sq));
  }

  /** Squares worth clicking: the next hop of any route, and the end of any
   *  route no other one also ends on. */
  function targetsOf(cands) {
    const out = new Set();
    const ends = new Map();
    for (const m of cands) {
      if (m.path.length > hops.length) out.add(m.path[hops.length]);
      ends.set(m.to, (ends.get(m.to) || 0) + 1);
    }
    for (const [sq, n] of ends) if (n === 1) out.add(sq);
    return out;
  }

  function renderBoard(g, acting) {
    const board = el('board');
    const pos = g.pos;
    // Online, your own colour sits at the bottom. On one laptop White does —
    // the book diagram, Black at the top — and it stays put.
    const flip = !local && colourOfSeat(g, selfId) === 'b';
    const cands = candidates();
    const targets = targetsOf(cands);
    const taking = new Set(cands[0]?.captured.slice(0, hops.length) ?? []);
    const movable = new Set(acting ? legalMoves(pos).map((m) => m.from) : []);
    const last = g.lastMove;
    const lastSquares = new Set(last ? [last.from, ...last.path] : []);
    const took = new Set(last?.captured ?? []);

    [...board.children].forEach((sq, i) => {
      const r = i >> 3;
      const f = i & 7;
      sq.style.gridRow = String((flip ? 7 - r : r) + 1);
      sq.style.gridColumn = String((flip ? 7 - f : f) + 1);
      if (!isDark(i)) return;

      const p = pos.board[i];
      const face = p || '';
      if (sq.dataset.face !== face) {
        sq.dataset.face = face;
        sq.querySelector('.pc').innerHTML = p ? pieceHTML(p) : '';
      }

      const target = targets.has(i);
      sq.classList.toggle('movable', movable.has(i));
      sq.classList.toggle('selected', i === selected);
      sq.classList.toggle('hop', hops.includes(i));
      sq.classList.toggle('target', target);
      sq.classList.toggle('taking', taking.has(i));
      sq.classList.toggle('last', lastSquares.has(i));
      sq.classList.toggle('took', took.has(i) && !p);
      // Not `disabled`: a disabled button swallows the pointerdown that should
      // drop the current selection. Out of the tab order instead.
      sq.tabIndex = movable.has(i) || target ? 0 : -1;
      sq.setAttribute('aria-label', `${squareNumber(i)}, ${p ? pieceName(p) : 'empty'}` +
        (i === selected ? ', selected' : target ? ', move here' : ''));
    });
  }

  /* ======================== moving pieces ======================== */

  /** A tap or keypress on square `i`: take it as the next step for the piece
   *  in hand if it is one, otherwise pick up the piece on it or put down the
   *  one in hand. */
  function pick(i) {
    if (!canAct()) return;
    if (selected !== null && choose(i)) return;
    const mine = movesFrom(state.game, i).length > 0;
    selected = mine && selected !== i ? i : null;
    hops = [];
    renderTable();
  }

  /** Try square `i` as where the piece in hand goes next. True if it was. */
  function choose(i) {
    const cands = candidates();
    if (cands.some((m) => m.path[hops.length] === i)) {
      hops.push(i);
      // Routes that share every hop so far have jumped the same pieces, so if
      // one of them stops here they all do — and there can only be one.
      const done = candidates().find((m) => m.path.length === hops.length);
      if (done) play(done);
      else renderTable();
      return true;
    }
    const ending = cands.filter((m) => m.to === i);
    if (ending.length === 1) { play(ending[0]); return true; }
    return false;
  }

  function play(m) {
    selected = null;
    hops = [];
    intent({ t: 'move', from: m.from, path: m.path });
    renderTable();
  }

  function onPointerDown(e) {
    if (e.button !== 0 || !canAct()) return;
    const sq = e.target.closest('.sq');
    if (!sq) return;
    const i = Number(sq.dataset.i);
    if (!movesFrom(state.game, i).length || targetsOf(candidates()).has(i)) { pick(i); return; }

    e.preventDefault();   // no text selection, no page scroll on touch
    const wasSelected = selected === i && !hops.length;
    selected = i;
    hops = [];
    renderTable();
    drag = {
      from: i, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY,
      size: sq.getBoundingClientRect().width, moved: false, wasSelected, ghost: null,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', endDrag);
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      // A few pixels of wobble is still a tap.
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
      drag.moved = true;
      const ghost = document.createElement('div');
      ghost.className = 'dragpiece';
      ghost.style.width = ghost.style.height = drag.size + 'px';
      ghost.innerHTML = `<span class="pc">${pieceHTML(state.game.pos.board[drag.from])}</span>`;
      root.appendChild(ghost);
      drag.ghost = ghost;
      el('board').children[drag.from].classList.add('lifted');
    }
    drag.ghost.style.transform = `translate(${e.clientX - drag.size / 2}px, ${e.clientY - drag.size / 2}px)`;
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { from, moved, wasSelected } = drag;
    endDrag();
    if (!state?.game) return;
    if (moved) {
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.sq');
      const to = under && el('board').contains(under) ? Number(under.dataset.i) : -1;
      // Dropped somewhere useless: snap back, keep it selected.
      if (!(to >= 0 && to !== from && selected === from && choose(to))) renderTable();
    } else if (wasSelected) {
      selected = null;      // tapping the piece already in hand puts it down
      renderTable();
    }
  }

  function endDrag() {
    if (!drag) return;
    drag.ghost?.remove();
    root.querySelector('.sq.lifted')?.classList.remove('lifted');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', endDrag);
    drag = null;
  }

  /* ========================= the rest of it ========================= */

  function renderBanner(gone) {
    const b = el('banner');
    b.hidden = !gone;
    if (gone) b.textContent = `${gone.name} disconnected — this game can't continue.`;
  }

  function resultText(g) {
    const r = g.result;
    return {
      title: r.winner ? `${nameIn(g, r.winner)} wins` : 'Draw',
      sub: {
        captured: `${nameIn(g, r.loser)} has no pieces left.`,
        blocked: `${nameIn(g, r.loser)} is blocked in — no legal moves.`,
        resign: `${nameIn(g, r.loser)} resigned.`,
        repetition: 'The same position came up three times.',
        forty: 'Forty moves each without a capture or a man moving.',
        agreement: 'Agreed by both players.',
      }[r.reason],
    };
  }

  function renderStatus(g, acting, gone) {
    const s = el('status');
    if (gone) { s.textContent = 'Game over'; return; }
    if (g.phase === 'over') { s.textContent = resultText(g).title; return; }
    const capture = mustCapture(g.pos) ? ' — you must capture' : '';
    if (local) s.textContent = `${COLOUR_NAMES[g.pos.turn]} to move${capture}`;
    else s.textContent = acting ? `Your move${capture}` : `${nameIn(g, currentSeat(g).id)} is thinking…`;
  }

  function renderSide(g, gone) {
    const turn = g.pos.turn;
    const myColour = local ? null : colourOfSeat(g, selfId);
    const sub = `<div class="sub">Game ${g.game}${myColour ? ' · you are ' + COLOUR_NAMES[myColour] : ''}</div>`;

    if (g.phase === 'playing') {
      el('turnchip').className = 'chip turnchip ' + turn;
      el('turnwho').innerHTML = (local ? `${COLOUR_NAMES[turn]} to move`
        : currentSeat(g).id === selfId ? 'Your turn' : `${esc(nameIn(g, currentSeat(g).id))}’s turn`) + sub;
    } else {
      el('turnchip').className = 'chip turnchip ' + (g.result.winner ? colourOfSeat(g, g.result.winner) : 'draw');
      el('turnwho').innerHTML = esc(resultText(g).title) + sub;
    }

    renderOffer(g);
    renderActions(g, gone);

    el('scores').innerHTML = g.seats.map((s) => `
      <li${s.connected ? '' : ' class="gone"'}>
        <div class="chip ${colourOfSeat(g, s.id)}"></div>
        <div class="nm">${esc(s.name)}${s.id === selfId ? ' <span class="you">you</span>' : ''}</div>
        <div class="pts">${g.scores[s.id]}</div>
      </li>`).join('') +
      `<li class="drawrow"><div class="chip draw"></div><div class="nm">Drawn</div><div class="pts">${g.draws}</div></li>`;

    renderMoves(g);
  }

  function renderOffer(g) {
    const box = el('offer');
    const incoming = !local && g.phase === 'playing' && g.drawOffer && g.drawOffer !== selfId;
    const key = incoming ? g.drawOffer : '';
    box.hidden = !incoming;
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = incoming
      ? `<div><b>${esc(nameIn(g, g.drawOffer))}</b> offers a draw</div>
         <div class="row"><button class="primary acceptdraw">Accept</button><button class="declinedraw">Decline</button></div>`
      : '';
    box.querySelector('.acceptdraw')?.addEventListener('click', () => intent({ t: 'draw-accept' }));
    box.querySelector('.declinedraw')?.addEventListener('click', () => intent({ t: 'draw-decline' }));
  }

  function renderActions(g, gone) {
    const box = el('actions');
    const isHost = local || selfId === state.hostId;
    const key = gone ? '' : g.phase === 'playing' ? (local ? 'local' : 'online') : isHost ? 'rematch' : 'wait';
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.innerHTML = {
        local: '<button class="drawbtn">Agree a draw</button><button class="resignbtn">Resign</button>',
        online: '<button class="drawbtn">Offer draw</button><button class="resignbtn">Resign</button>',
        rematch: '<button class="primary rematchbtn">Rematch</button>',
        wait: '<div class="hint">Waiting for the host to start a rematch…</div>',
        '': '',
      }[key];
      box.querySelector('.drawbtn')?.addEventListener('click', () => {
        if (!local) intent({ t: 'draw-offer' });
        else if (confirm('Agree a draw and end this game?')) intent({ t: 'draw-agree' });
      });
      box.querySelector('.resignbtn')?.addEventListener('click', () => {
        // On one laptop the button resigns for whoever is to move.
        const q = local ? `Resign for ${currentSeat(state.game).name}?` : 'Resign this game?';
        if (confirm(q)) intent({ t: 'resign' });
      });
      box.querySelector('.rematchbtn')?.addEventListener('click', () => intent({ t: 'rematch' }));
    }
    const drawBtn = box.querySelector('.drawbtn');
    if (drawBtn && !local) {
      drawBtn.disabled = !!g.drawOffer;
      drawBtn.textContent = g.drawOffer === selfId ? 'Draw offered' : 'Offer draw';
    }
  }

  function renderMoves(g) {
    const list = el('moves');
    const key = `${g.game}:${g.history.length}:${g.result?.reason || ''}`;
    if (list.dataset.key === key) return;
    list.dataset.key = key;
    let html = '';
    for (let k = 0; k < g.history.length; k += 2) {
      html += `<li><span class="no">${k / 2 + 1}.</span><span>${esc(g.history[k])}</span><span>${esc(g.history[k + 1] ?? '')}</span></li>`;
    }
    if (g.result) html += `<li class="res">${esc(resultText(g).title)}</li>`;
    list.innerHTML = html || '<li class="none">No moves yet</li>';
    list.scrollTop = list.scrollHeight;
  }

  function renderOver(g, gone) {
    const existing = root.querySelector('.over');
    // A dropped opponent already has the banner; a card on top of it would
    // just be a second way to say the same thing.
    if (g.phase !== 'over' || gone || hideOverFor === g.game) { existing?.remove(); return; }
    if (existing) return;

    const isHost = local || selfId === state.hostId;
    const { title, sub } = resultText(g);
    const swapNote = !local ? ' Colours swap for the rematch.' : '';

    const box = document.createElement('div');
    box.className = 'over';
    box.innerHTML = `
      <div class="card2">
        <h2>${esc(title)}</h2>
        <div class="sub">${esc(sub + swapNote)}</div>
        ${isHost
          ? '<button class="primary go">Rematch</button>'
          : '<div class="hint">Waiting for the host…</div>'}
        <button class="ghost peek">See the board</button>
      </div>`;
    root.querySelector('.table').appendChild(box);
    box.querySelector('.go')?.addEventListener('click', () => intent({ t: 'rematch' }));
    box.querySelector('.peek').addEventListener('click', () => { hideOverFor = g.game; box.remove(); });
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  showLobby();
}

export default { id: 'checkers', title: 'Checkers', init };
