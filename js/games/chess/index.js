// Chess — lobby, board, and the glue between rules.js and net.js.
//
// ---- Two ways to play ----
// Online is X and O's again: the host owns the one true state, players send
// intents, the host validates them and broadcasts the whole room back out.
// Chess has no hidden information either, so there is nothing to redact.
//
// "Play on this device" never touches net.js. The same room object lives here
// with two seats named for their colours, and every intent is applied as
// whoever is to move. Both paths go through `onHostMessage`, so a local game is
// held to exactly the rules an online one is — there is no second copy of the
// "is this allowed" logic to drift out of step.
//
// ---- Moving pieces ----
// Click a piece then a square, or drag it there. Squares are buttons, so the
// keyboard gets the click path for free: Tab to a piece, Enter, Tab to a
// target, Enter. Pointer input is handled on pointerdown/up so a tap and a
// drag share one code path. The `click` a mouse fires afterwards is ignored;
// only the detail-0 click a keypress synthesises gets through.

import { createRoom, joinRoom, normaliseCode } from '../../net.js';
import {
  PLAYERS, PROMOTIONS,
  createState, currentSeat, colourOfSeat, colourOf, movesFrom, inCheck, kingSquare, squareName,
  applyMove, resign, offerDraw, acceptDraw, declineDraw, agreeDraw, rematch,
} from './rules.js';

const GAME = 'chess';

const LOBBY_HTML = `
  <div class="lobby">
    <div class="lobby-card">
      <h2>Chess</h2>
      <div class="lead">Play both sides on this device, or create a room and share the code with a friend. 2 players, regular rules.</div>

      <div class="field">
        <label for="chess-name">Your name</label>
        <input id="chess-name" class="name" maxlength="12" placeholder="Nickname" autocomplete="off">
      </div>

      <button class="primary local">Play on this device</button>
      <button class="create">Create a room</button>

      <div class="or">or</div>

      <div class="field">
        <label for="chess-code">Room code</label>
        <div class="row">
          <input id="chess-code" class="code-input codein" maxlength="5" placeholder="ABC12"
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
      <div class="board" role="group" aria-label="Chess board"></div>
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

const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const COLOUR_NAMES = { w: 'White', b: 'Black' };

/**
 * Pieces are drawn rather than typed. The Unicode chess glyphs are at the mercy
 * of the font — different shapes and weights on every platform, and on iOS the
 * black pawn comes out as an emoji. viewBox is 0 0 100 100; `.d` strokes and
 * `.eye` are interior detail, coloured to stand out from the piece's body.
 */
const BASE = '<rect x="24" y="76" width="52" height="12" rx="4"/>';
const PIECE_SHAPES = {
  p: '<path d="M36 76C36 62 42 52 50 46C58 52 64 62 64 76Z"/><rect x="38" y="42" width="24" height="7" rx="3"/>' +
     '<circle cx="50" cy="30" r="12"/><rect x="30" y="74" width="40" height="12" rx="4"/>',
  r: '<path d="M34 76L37 46H63L66 76Z"/><path d="M28 20H38V28H45V20H55V28H62V20H72V38L64 46H36L28 38Z"/>' + BASE,
  n: '<path d="M32 76C32 68 36 62 42 56C36 58 28 60 24 58C18 55 17 48 21 44L36 26L44 12L52 22' +
     'C66 26 76 40 72 58C71 66 68 70 68 76Z"/><path class="d" d="M56 30C64 38 66 50 62 62"/>' +
     '<circle class="eye" cx="38" cy="34" r="3"/>' + BASE,
  b: '<path d="M38 76C38 66 42 60 44 56H56C58 60 62 66 62 76Z"/><path d="M50 18C38 28 34 42 42 54H58C66 42 62 28 50 18Z"/>' +
     '<circle cx="50" cy="14" r="5"/><rect x="38" y="52" width="24" height="7" rx="3"/><path class="d" d="M55 30L46 42"/>' + BASE,
  q: '<path d="M32 76L22 36L34 56L36 24L44 48L50 20L56 48L64 24L66 56L78 36L68 76Z"/>' +
     '<circle cx="22" cy="34" r="5"/><circle cx="36" cy="22" r="5"/><circle cx="50" cy="18" r="5"/>' +
     '<circle cx="64" cy="22" r="5"/><circle cx="78" cy="34" r="5"/><path class="d" d="M31 66H69"/>' + BASE,
  k: '<path d="M46 8H54V16H62V24H54V36H46V24H38V16H46Z"/>' +
     '<path d="M32 76C26 60 24 46 34 40C42 36 58 36 66 40C76 46 74 60 68 76Z"/><path class="d" d="M31 64H69"/>' + BASE,
};

function pieceSVG(p) {
  return `<svg class="piece ${colourOf(p)}" viewBox="0 0 100 100" aria-hidden="true">${PIECE_SHAPES[p.toLowerCase()]}</svg>`;
}

const RESULT_SCORE = (g) => (!g.result.winner ? '½–½' : colourOfSeat(g, g.result.winner) === 'w' ? '1–0' : '0–1');

function init(root, header) {
  let room = null;      // net.js Room, once connected
  let state = null;     // the shared room object (lobby or game)
  let selfId = null;
  let myName = 'Player';
  let local = false;    // both sides on this device, no room
  let selected = null;  // square index of the piece picked up
  let drag = null;      // { from, pointerId, x0, y0, size, moved, wasSelected, ghost }
  let hideOverFor = 0;  // game number whose result card was dismissed to see the board

  const el = (sel) => root.querySelector('.' + sel);

  header.innerHTML = '<div class="tag chesstag">2 players · regular rules</div>' +
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
    local = false; selected = null; hideOverFor = 0;
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
      // The seats are the colours here: whoever sits on White's side of the
      // laptop stays White, so a rematch doesn't swap and the board never flips.
      const seats = [
        { id: 'white', name: 'White', connected: true },
        { id: 'black', name: 'Black', connected: true },
      ];
      local = true;
      state = {
        phase: 'playing',
        code: null,
        hostId: null,
        seats,
        game: createState(seats, { white: 0, swapOnRematch: false }),
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
      room.send(peerId, { t: 'denied', msg: 'That room is full — chess is two players.' });
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
      if (state.seats.length >= PLAYERS) { room.send(fromId, { t: 'denied', msg: 'That room is full — chess is two players.' }); return; }
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
        case 'move': applyMove(g, fromId, { from: msg.from, to: msg.to, promo: msg.promo ?? null }); break;
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
      console.warn('[chess] rejected intent', msg.t, err.message);
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
    else console.error('[chess] net error', err);
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

    // A selection only survives a render if that piece is still yours to move.
    if (selected !== null && (!acting || colourOf(g.pos.board[selected]) !== g.pos.turn)) selected = null;
    if (!acting) { closePromo(); endDrag(); }

    renderBanner(gone);
    renderBoard(g, acting);
    renderStatus(g, acting, gone);
    renderSide(g, acting, gone);
    renderOver(g, gone);
  }

  /** The 64 squares are built once and then patched, never re-created — a
   *  rebuild mid-drag would pull the square out from under the pointer. */
  function buildBoard() {
    const board = el('board');
    for (let i = 0; i < 64; i++) {
      const sq = document.createElement('button');
      sq.className = 'sq ' + (((i >> 3) + (i & 7)) % 2 ? 'dark' : 'light');
      sq.dataset.i = String(i);
      sq.innerHTML = '<span class="pc"></span><span class="coord rank"></span><span class="coord file"></span>';
      board.appendChild(sq);
    }
    board.addEventListener('pointerdown', onPointerDown);
    board.addEventListener('click', (e) => {
      if (e.detail !== 0) return;   // a real pointer click; pointerdown already handled it
      const sq = e.target.closest('.sq');
      if (sq) pick(Number(sq.dataset.i));
    });
  }

  function renderBoard(g, acting) {
    const board = el('board');
    const pos = g.pos;
    // Online, your own colour sits at the bottom. On one laptop White does,
    // and it stays put — a board that spins round every move is hard to follow.
    const flip = !local && colourOfSeat(g, selfId) === 'b';
    const targets = new Map(movesFrom(g, selected).map((m) => [m.to, !!m.captured]));
    // Still drawn once the game is over: the mated king should stay marked.
    const checked = inCheck(pos) ? kingSquare(pos.board, pos.turn) : -1;

    [...board.children].forEach((sq, i) => {
      const r = i >> 3;
      const f = i & 7;
      const row = flip ? 7 - r : r;
      const col = flip ? 7 - f : f;
      sq.style.gridRow = String(row + 1);
      sq.style.gridColumn = String(col + 1);

      const p = pos.board[i];
      const face = p || '';
      if (sq.dataset.face !== face) {
        sq.dataset.face = face;
        sq.querySelector('.pc').innerHTML = p ? pieceSVG(p) : '';
      }
      sq.querySelector('.rank').textContent = col === 0 ? String(8 - r) : '';
      sq.querySelector('.file').textContent = row === 7 ? 'abcdefgh'[f] : '';

      const movable = acting && !!p && colourOf(p) === pos.turn;
      const target = targets.has(i);
      sq.classList.toggle('movable', movable);
      sq.classList.toggle('selected', i === selected);
      sq.classList.toggle('target', target && !targets.get(i));
      sq.classList.toggle('capture', target && targets.get(i));
      sq.classList.toggle('last', !!g.lastMove && (g.lastMove.from === i || g.lastMove.to === i));
      sq.classList.toggle('check', i === checked);
      // Not `disabled`: a disabled button swallows the pointerdown that should
      // drop the current selection. Out of the tab order instead.
      sq.tabIndex = movable || target ? 0 : -1;
      sq.setAttribute('aria-label', squareName(i) + ', ' +
        (p ? `${COLOUR_NAMES[colourOf(p)].toLowerCase()} ${PIECE_NAMES[p.toLowerCase()]}` : 'empty') +
        (i === selected ? ', selected' : target ? ', move here' : ''));
    });
  }

  /* ======================== moving pieces ======================== */

  /** A tap or keypress on square `i`: move there if it's a target, otherwise
   *  pick up the piece on it, or put down the one in hand. */
  function pick(i) {
    if (!canAct() || root.querySelector('.promo')) return;
    const g = state.game;
    if (selected !== null && movesFrom(g, selected).some((m) => m.to === i)) {
      play(selected, i);
      return;
    }
    const p = g.pos.board[i];
    selected = p && colourOf(p) === g.pos.turn && selected !== i ? i : null;
    renderTable();
  }

  function play(from, to) {
    const options = movesFrom(state.game, from).filter((m) => m.to === to);
    if (!options.length) return;
    if (options.length > 1) { askPromotion(from, to); return; }   // only promotions branch
    selected = null;
    intent({ t: 'move', from, to, promo: null });
    renderTable();
  }

  function onPointerDown(e) {
    if (e.button !== 0 || !canAct() || root.querySelector('.promo')) return;
    const sq = e.target.closest('.sq');
    if (!sq) return;
    const i = Number(sq.dataset.i);
    const p = state.game.pos.board[i];
    if (!p || colourOf(p) !== state.game.pos.turn) { pick(i); return; }

    e.preventDefault();   // no text selection, no page scroll on touch
    const wasSelected = selected === i;
    selected = i;
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
      ghost.innerHTML = `<span class="pc">${pieceSVG(state.game.pos.board[drag.from])}</span>`;
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
      if (to !== from && movesFrom(state.game, from).some((m) => m.to === to)) play(from, to);
      else renderTable();   // dropped somewhere useless: snap back, keep it selected
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

  function askPromotion(from, to) {
    closePromo();
    const colour = state.game.pos.turn;
    const box = document.createElement('div');
    box.className = 'promo';
    box.innerHTML = `
      <div class="card2">
        <h2>Promote to</h2>
        <div class="promorow">${PROMOTIONS.map((t) =>
          `<button class="promopick" data-t="${t}" aria-label="${PIECE_NAMES[t]}">${pieceSVG(colour === 'w' ? t.toUpperCase() : t)}</button>`).join('')}
        </div>
        <button class="ghost promocancel">Cancel</button>
      </div>`;
    root.querySelector('.table').appendChild(box);
    box.querySelectorAll('.promopick').forEach((btn) => btn.addEventListener('click', () => {
      closePromo();
      selected = null;
      intent({ t: 'move', from, to, promo: btn.dataset.t });
      renderTable();
    }));
    box.querySelector('.promocancel').addEventListener('click', () => { closePromo(); renderTable(); });
    box.querySelector('.promopick').focus();
  }

  const closePromo = () => root.querySelector('.promo')?.remove();

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
        checkmate: 'Checkmate.',
        resign: `${nameIn(g, r.loser)} resigned.`,
        stalemate: 'Stalemate — no legal moves, but not in check.',
        material: 'Neither side has enough pieces left to checkmate.',
        repetition: 'The same position came up three times.',
        fifty: 'Fifty moves each without a capture or a pawn move.',
        agreement: 'Agreed by both players.',
      }[r.reason],
    };
  }

  function renderStatus(g, acting, gone) {
    const s = el('status');
    if (gone) { s.textContent = 'Game over'; return; }
    if (g.phase === 'over') { s.textContent = `${resultText(g).title} · ${RESULT_SCORE(g)}`; return; }
    const check = inCheck(g.pos) ? ' — check!' : '';
    if (local) s.textContent = `${COLOUR_NAMES[g.pos.turn]} to move${check}`;
    else s.textContent = (acting ? 'Your move' : `${nameIn(g, currentSeat(g).id)} is thinking…`) + check;
  }

  function renderSide(g, acting, gone) {
    const turn = g.pos.turn;
    const myColour = local ? null : colourOfSeat(g, selfId);
    const sub = `<div class="sub">Game ${g.game}${myColour ? ' · you are ' + COLOUR_NAMES[myColour] : ''}</div>`;

    if (g.phase === 'playing') {
      el('turnchip').className = 'chip turnchip ' + turn;
      el('turnwho').innerHTML = (local ? `${COLOUR_NAMES[turn]} to move`
        : acting ? 'Your turn' : `${esc(nameIn(g, currentSeat(g).id))}’s turn`) + sub;
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
    const key = `${g.game}:${g.sans.length}:${g.result?.reason || ''}`;
    if (list.dataset.key === key) return;
    list.dataset.key = key;
    let html = '';
    for (let k = 0; k < g.sans.length; k += 2) {
      html += `<li><span class="no">${k / 2 + 1}.</span><span>${esc(g.sans[k])}</span><span>${esc(g.sans[k + 1] ?? '')}</span></li>`;
    }
    if (g.result) html += `<li class="res">${RESULT_SCORE(g)}</li>`;
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
        <div class="score">${RESULT_SCORE(g)}</div>
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

export default { id: 'chess', title: 'Chess', init };
