// Uno — lobby, table, and the glue between rules.js and net.js.
//
// ---- Authority ----
// Same model as Ludo: the host owns the one true state, everyone else sends
// intents and renders what comes back. See ludo/index.js for the long version.
//
// ---- What's different: hidden information ----
// Ludo can broadcast the whole room to everyone, because a Ludo board has no
// secrets. Uno does — your hand, and whether a +4 was a bluff. So the host does
// NOT broadcast `state`; it sends each player their own redacted `view`:
//
//     state (host only)          view (per player)
//     ├─ hands: {id: [card]}  →  ├─ hand:   [card]      ← yours, in full
//     │                          ├─ counts: {id: n}     ← everyone else, a number
//     ├─ draw:  [card]        →  ├─ draw:   n
//     └─ challenge.bluffed    →  └─ (dropped)           ← the whole point of a bluff
//
// If any of that leaked, the game would be readable from devtools. The host
// renders from `viewFor(selfId)` too, so the host's screen shows exactly what a
// client's would — no accidental privilege, and one render path to debug.

import { createRoom, joinRoom, normaliseCode } from '../../net.js';
import {
  COLORS, MAX_PLAYERS, MIN_PLAYERS, DEFAULT_TARGET,
  createState, currentSeat, legalPlays, needsOpeningColor, isWild, cardPoints,
  applyPlay, applyDraw, applyPass, applyTakeDraw, applyChallenge,
  applySayUno, applyCatch, applyOpeningColor, nextRound, advance,
} from './rules.js';

const GAME = 'uno';

const LOBBY_HTML = `
  <div class="lobby">
    <div class="lobby-card">
      <h2>Uno</h2>
      <div class="lead">Create a room and share the code, or enter a friend's code to join. 2–10 players, first to ${DEFAULT_TARGET} points.</div>

      <div class="field">
        <label for="uno-name">Your name</label>
        <input id="uno-name" class="name" maxlength="12" placeholder="Nickname" autocomplete="off">
      </div>

      <button class="primary create">Create a room</button>

      <div class="or">or</div>

      <div class="field">
        <label for="uno-code">Room code</label>
        <div class="row">
          <input id="uno-code" class="code-input codein" maxlength="5" placeholder="ABC12"
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
      <div class="lead">Share this code with your friends so they can join.</div>
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
    <div class="felt">
      <div class="opponents"></div>
      <div class="middle">
        <div class="pile drawpile" title="Draw pile">
          <div class="cardback"></div>
          <div class="pilecount"></div>
        </div>
        <div class="pile discardpile"></div>
        <div class="callout"></div>
      </div>
      <div class="myrow">
        <div class="actions"></div>
        <div class="hand"></div>
      </div>
    </div>
    <aside>
      <div class="turnbar">
        <div class="chip turnchip"></div>
        <div class="who turnwho"></div>
      </div>
      <div class="scorehead">Scores <span class="tgt"></span></div>
      <ul class="scores"></ul>
      <div class="loghead">Game log</div>
      <div class="logwrap"></div>
    </aside>
  </div>
`;

const GLYPH = { skip: '⊘', rev: '⇄', draw2: '+2', wild: '★', wild4: '+4' };
const LABEL = { skip: 'skip', rev: 'reverse', draw2: '+2', wild: 'wild', wild4: '+4' };
const cardName = (c) => (c.color ? c.color + ' ' : '') + (LABEL[c.value] ?? c.value);

function init(root, header) {
  let room = null;      // net.js Room, once connected
  let state = null;     // host only: the one true room. Clients never see this.
  let view = null;      // what we render — a redacted state
  let selfId = null;
  let myName = 'Player';
  let picking = null;   // card id waiting on a colour choice

  const el = (sel) => root.querySelector('.' + sel);

  header.innerHTML = `<div class="tag unotag">Official rules · stacking on · to ${DEFAULT_TARGET}</div>` +
                     '<button class="leave" hidden>Leave room</button>';
  const leaveBtn = header.querySelector('.leave');
  leaveBtn.onclick = () => {
    if (!confirm('Leave the room? This ends the game for you.')) return;
    teardown();
    showLobby();
  };

  function teardown() {
    room?.close();
    room = null; state = null; view = null; selfId = null; picking = null;
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
          seats: [{ id: selfId, name: myName, color: COLORS[0], connected: true }],
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

  // Every action funnels through here, the host's own clicks included.
  function intent(msg) {
    if (room?.isHost) onHostMessage(msg, selfId);
    else room?.send(null, msg);
  }

  function onJoin(peerId) {
    if (state.phase !== 'lobby') {
      room.send(peerId, { t: 'denied', msg: 'That game has already started.' });
      return;
    }
    if (state.seats.length >= MAX_PLAYERS) {
      room.send(peerId, { t: 'denied', msg: `That room is full (${MAX_PLAYERS} players).` });
    }
  }

  function onLeave(peerId) {
    const seat = state?.seats.find((s) => s.id === peerId);
    if (!seat) return;
    if (state.phase === 'lobby') {
      state.seats = state.seats.filter((s) => s.id !== peerId);
      state.seats.forEach((s, i) => { s.color = COLORS[i % COLORS.length]; });
    } else {
      seat.connected = false;
      log(`${esc(seat.name)} disconnected`);
      const g = state.game;
      // Don't strand the game on a vanished player's turn, and don't leave a
      // challenge pointed at someone who can no longer answer it.
      if (g.phase === 'playing' && currentSeat(g).id === peerId) {
        g.challenge = null;
        g.pending = null;
        g.drawnId = null;
        g.mustPass = false;
        advance(g, 1);
      }
      if (g.challenge?.byId === peerId) g.challenge = null;
      if (g.catchable?.playerId === peerId) g.catchable = null;
    }
    pushAndRender();
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
      pushAndRender();
      return;
    }

    if (!seat) return; // not a player in this room

    if (msg.t === 'start') {
      if (fromId !== state.hostId || state.phase !== 'lobby' || state.seats.length < MIN_PLAYERS) return;
      state.phase = 'playing';
      state.game = createState(state.seats, { target: state.target });
      log(`Round 1 — ${state.seats.map((s) => esc(s.name)).join(', ')}`);
      announceOpener();
      pushAndRender();
      return;
    }

    if (state.phase !== 'playing' || !state.game) return;
    const g = state.game;

    // These two are the only things you may do off-turn.
    if (msg.t === 'catch') { hostCatch(fromId); return; }
    if (msg.t === 'uno') {
      if (applySayUno(g, fromId)) { log(`<b>${esc(seat.name)}</b> called Uno!`); pushAndRender(); }
      return;
    }

    if (msg.t === 'next') {
      if (fromId !== state.hostId || g.phase !== 'roundover') return;
      nextRound(g);
      log(`Round ${g.round}`);
      announceOpener();
      pushAndRender();
      return;
    }

    if (msg.t === 'rematch') {
      if (fromId !== state.hostId || g.phase !== 'over') return;
      state.game = createState(state.seats, { target: state.target });
      log('New match');
      announceOpener();
      pushAndRender();
      return;
    }

    if (g.phase !== 'playing') return;
    if (currentSeat(g).id !== fromId) return;   // not your turn

    try {
      if (msg.t === 'color') hostOpeningColor(fromId, msg.color);
      else if (msg.t === 'play') hostPlay(fromId, msg.cardId, msg.color);
      else if (msg.t === 'draw') hostDraw(fromId);
      else if (msg.t === 'pass') hostPass(fromId);
      else if (msg.t === 'take') hostTake(fromId);
      else if (msg.t === 'challenge') hostChallenge(fromId);
      else return;
    } catch (err) {
      // A rejected intent means a stale client, not a crash — resync them.
      console.warn('[uno] rejected intent', msg.t, err.message);
      pushAndRender();
      return;
    }
    pushAndRender();
  }

  const nameOf = (id) => esc(state.seats.find((s) => s.id === id)?.name || 'Someone');

  function announceOpener() {
    const g = state.game;
    const kind = g.opener?.kind;
    const top = g.discard[g.discard.length - 1];
    if (kind === 'skip') log(`Opening ${cardName(top)} — ${nameOf(currentSeat(g).id)} is skipped`);
    else if (kind === 'rev') log(`Opening ${cardName(top)} — play runs the other way`);
    else if (kind === 'draw2') log(`Opening ${cardName(top)} — ${nameOf(currentSeat(g).id)} faces 2`);
    else if (kind === 'wild') log(`Opening wild — ${nameOf(currentSeat(g).id)} picks the colour`);
    log(`<b>${nameOf(currentSeat(g).id)}</b> to play`);
  }

  function hostOpeningColor(id, color) {
    applyOpeningColor(state.game, id, color);
    log(`<b>${nameOf(id)}</b> chose ${color}`);
  }

  function hostPlay(id, cardId, color) {
    const g = state.game;
    const res = applyPlay(g, id, cardId, color);
    const c = res.card;

    log(`<b>${nameOf(id)}</b> played ${cardName(c)}` + (res.chained ? ' onto the chain' : ''));
    if (isWild(c)) log(`Colour is now ${c.color}`);
    if (res.effect === 'skip') log(`${nameOf(currentSeat(g).id)} was skipped`);
    if (res.effect === 'rev') log('Play reverses');
    if (res.effect === 'draw2' || res.effect === 'wild4') {
      log(`${nameOf(currentSeat(g).id)} faces ${g.pending.amount}`);
    }
    if (res.challengeable) log(`${nameOf(currentSeat(g).id)} may challenge it`);
    if (res.uno) log(`<b>${nameOf(id)}</b> is on one card`);

    if (res.roundOver) {
      log(`<b>${nameOf(id)}</b> went out — +${res.gained} (${res.total})`);
      if (res.matchOver) log(`<b>${nameOf(id)}</b> wins the match!`);
      return;
    }
    log(`<b>${nameOf(currentSeat(g).id)}</b> to play`);
  }

  function hostDraw(id) {
    const res = applyDraw(state.game, id);
    log(`<b>${nameOf(id)}</b> drew a card`);
    if (!res.playable) {
      log(`Nothing to play — <b>${nameOf(id)}</b> passes`);
      applyPass(state.game, id);
      log(`<b>${nameOf(currentSeat(state.game).id)}</b> to play`);
    }
  }

  function hostPass(id) {
    applyPass(state.game, id);
    log(`<b>${nameOf(id)}</b> passed`);
    log(`<b>${nameOf(currentSeat(state.game).id)}</b> to play`);
  }

  function hostTake(id) {
    const res = applyTakeDraw(state.game, id);
    log(`<b>${nameOf(id)}</b> took ${res.amount}`);
    log(`<b>${nameOf(currentSeat(state.game).id)}</b> to play`);
  }

  function hostChallenge(id) {
    const g = state.game;
    const res = applyChallenge(g, id);
    if (res.caught) log(`<b>${nameOf(id)}</b> called the bluff — ${nameOf(res.from)} held the colour and draws ${res.drew}`);
    else log(`<b>${nameOf(id)}</b> challenged and was wrong — draws ${res.drew}`);
    log(`<b>${nameOf(currentSeat(g).id)}</b> to play`);
  }

  function hostCatch(byId) {
    const g = state.game;
    if (g.phase !== 'playing' || !g.catchable || g.catchable.playerId === byId) return;
    const res = applyCatch(g, byId);
    log(`<b>${nameOf(byId)}</b> caught ${nameOf(res.caught)} — +${res.drew} cards`);
    pushAndRender();
  }

  function log(html) {
    const g = state.game;
    if (!g) return;
    g.log.push(html);
    if (g.log.length > 80) g.log.shift();
  }

  /* ====================== redaction + push ====================== */

  /** What `id` is allowed to know. See the note at the top of the file. */
  function viewFor(id) {
    if (!state.game) return state;
    const g = state.game;
    const counts = {};
    for (const s of g.seats) counts[s.id] = g.hands[s.id]?.length ?? 0;

    const game = {
      ...g,
      hand: g.hands[id] || [],
      counts,
      draw: g.draw.length,
      discard: g.discard.slice(-1),
      // `bluffed` is the secret the challenge exists to test — never send it.
      challenge: g.challenge ? { playerId: g.challenge.playerId, byId: g.challenge.byId } : null,
      // Once the round is scored the hands are public, so show what was counted.
      reveal: g.phase === 'playing' ? null : g.hands,
      legal: legalPlays(g, id),
      // Derived here rather than on the client: the view only carries the top
      // of the discard, so a client can't work this out for itself.
      needsColor: needsOpeningColor(g),
    };
    delete game.hands;
    return { ...state, game };
  }

  function pushAndRender() {
    if (room?.isHost) {
      for (const peerId of room.peerIds()) room.send(peerId, { t: 'room', room: viewFor(peerId) });
      view = viewFor(selfId);
    }
    render();
  }

  /* ======================= client: messages ====================== */

  function onClientMessage(msg) {
    if (msg.t === 'room') {
      const first = !view;
      view = msg.room;
      render();
      if (first) leaveBtn.hidden = false;
    } else if (msg.t === 'denied') {
      teardown();
      showLobby(msg.msg);
    }
  }

  function onHostGone() {
    if (!view) return;
    teardown();
    showLobby('The host left, so the room closed. WebRTC games live in the host\'s browser tab.');
  }

  function onNetError(err) {
    const target = root.querySelector('.lobbyerr') || root.querySelector('.waiterr');
    if (target) target.textContent = err.message;
    else console.error('[uno] net error', err);
  }

  /* ============================ render =========================== */

  function render() {
    if (!view) return;
    if (view.phase === 'lobby') renderWait();
    else renderTable();
  }

  function renderWait() {
    if (!root.querySelector('.codeval')) root.innerHTML = WAIT_HTML;
    el('codeval').textContent = view.code;

    el('seats').innerHTML = view.seats.map((s) => `
      <li>
        <div class="chip ${s.color}"></div>
        <div class="nm">${esc(s.name)}</div>
        <div class="badge">${s.id === view.hostId ? 'host' : ''}${s.id === selfId ? ' · you' : ''}</div>
      </li>`).join('');

    const isHost = selfId === view.hostId;
    const startBtn = el('start');
    startBtn.hidden = !isHost;
    startBtn.disabled = view.seats.length < MIN_PLAYERS;
    startBtn.onclick = () => intent({ t: 'start' });

    el('starthint').textContent = isHost
      ? (view.seats.length < MIN_PLAYERS ? 'Waiting for at least one more player…' : `${view.seats.length} players ready.`)
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

  function renderTable() {
    if (!root.querySelector('.felt')) root.innerHTML = TABLE_HTML;
    const g = view.game;
    const seat = currentSeat(g);
    const myTurn = seat?.id === selfId && g.phase === 'playing';

    renderOpponents(g, seat);
    renderMiddle(g);
    renderHand(g, myTurn);
    renderActions(g, myTurn);
    renderSide(g, seat, myTurn);
    renderOver(g);
  }

  function renderOpponents(g, seat) {
    el('opponents').innerHTML = g.seats.filter((s) => s.id !== selfId).map((s) => {
      const n = g.counts[s.id] ?? 0;
      const cls = ['opp'];
      if (s.id === seat?.id) cls.push('active');
      if (!s.connected) cls.push('gone');
      if (n === 1) cls.push('uno');
      return `
        <div class="${cls.join(' ')}">
          <div class="chip ${s.color}"></div>
          <div class="nm">${esc(s.name)}</div>
          <div class="count">${n}</div>
          ${n === 1 ? `<div class="unotag2">${g.said[s.id] ? 'UNO' : 'one card'}</div>` : ''}
        </div>`;
    }).join('');
  }

  function renderMiddle(g) {
    el('pilecount').textContent = g.draw;
    const top = g.discard[g.discard.length - 1];
    el('discardpile').innerHTML = top ? cardHTML(top, { big: true }) : '';
    // A wild's chosen colour isn't printed on the card, so say it out loud.
    el('discardpile').className = 'pile discardpile is-' + (g.color || 'none');

    const c = el('callout');
    if (g.phase !== 'playing') { c.textContent = ''; return; }
    if (g.needsColor) c.textContent = 'Waiting on a colour';
    else if (g.pending) c.textContent = `Chain: ${g.pending.amount} to draw`;
    else c.textContent = g.color ? g.color + (g.value !== null ? ' · ' + (LABEL[g.value] ?? g.value) : '') : '';
  }

  function renderHand(g, myTurn) {
    const legal = new Set(myTurn ? (g.legal || []) : []);
    // Group by colour then value so a big hand stays readable.
    const order = { skip: 10, rev: 11, draw2: 12, wild: 13, wild4: 14 };
    const rank = (c) => [c.color ? COLORS.indexOf(c.color) : 99, order[c.value] ?? c.value];
    const hand = [...g.hand].sort((a, b) => {
      const [ac, av] = rank(a), [bc, bv] = rank(b);
      return ac - bc || av - bv;
    });

    el('hand').innerHTML = hand.map((c) => cardHTML(c, { playable: legal.has(c.id) })).join('');
    for (const node of el('hand').querySelectorAll('.card.playable')) {
      node.onclick = () => playCard(node.dataset.id);
    }
  }

  function playCard(cardId) {
    const c = view.game.hand.find((x) => x.id === cardId);
    if (!c) return;
    if (isWild(c)) { picking = cardId; renderPicker(); return; }
    intent({ t: 'play', cardId });
  }

  /** Colour chooser for a wild. Lives over the table until you pick or cancel. */
  function renderPicker() {
    root.querySelector('.picker')?.remove();
    if (!picking) return;
    const box = document.createElement('div');
    box.className = 'picker';
    box.innerHTML = `
      <div class="card2">
        <h3>Choose a colour</h3>
        <div class="swatches">
          ${COLORS.map((c) => `<button class="sw ${c}" data-c="${c}" aria-label="${c}"></button>`).join('')}
        </div>
        <button class="ghost cancel">Cancel</button>
      </div>`;
    root.querySelector('.table').appendChild(box);
    for (const b of box.querySelectorAll('.sw')) {
      b.onclick = () => {
        const cardId = picking;
        picking = null;
        box.remove();
        // The opening wild is a colour call, not a card play.
        if (cardId === 'opening') intent({ t: 'color', color: b.dataset.c });
        else intent({ t: 'play', cardId, color: b.dataset.c });
      };
    }
    box.querySelector('.cancel').onclick = () => { picking = null; box.remove(); };
  }

  function renderActions(g, myTurn) {
    const box = el('actions');
    box.innerHTML = '';
    const add = (cls, label, onclick, primary) => {
      const b = document.createElement('button');
      b.className = cls + (primary ? ' primary' : '');
      b.textContent = label;
      b.onclick = onclick;
      box.appendChild(b);
      return b;
    };

    if (g.phase !== 'playing') return;

    if (myTurn && g.needsColor) {
      add('act', 'Choose colour', () => { picking = 'opening'; renderPicker(); }, true);
    } else if (myTurn && g.challenge?.byId === selfId) {
      add('act', `Challenge the +4`, () => intent({ t: 'challenge' }), true);
      add('act', `Draw ${g.pending.amount}`, () => intent({ t: 'take' }));
    } else if (myTurn && g.pending) {
      add('act', `Draw ${g.pending.amount}`, () => intent({ t: 'take' }), true);
    } else if (myTurn && (g.drawnId || g.mustPass)) {
      add('act', 'Pass', () => intent({ t: 'pass' }), true);
    } else if (myTurn) {
      add('act', 'Draw a card', () => intent({ t: 'draw' }), true);
    }

    // Off-turn buttons: calling Uno and catching someone who didn't.
    if (g.hand.length <= 2 && !g.said[selfId] && g.hand.length > 0) {
      add('act uno', 'UNO!', () => intent({ t: 'uno' }));
    }
    if (g.catchable && g.catchable.playerId !== selfId) {
      const who = g.seats.find((s) => s.id === g.catchable.playerId);
      add('act catch', `Catch ${who ? who.name : ''}!`, () => intent({ t: 'catch' }));
    }
  }

  function renderSide(g, seat, myTurn) {
    el('turnchip').className = 'chip turnchip ' + (seat?.color || '');
    el('turnwho').innerHTML = g.phase === 'playing'
      ? (myTurn ? 'Your turn' : esc(seat?.name || '') + '’s turn') +
        `<div class="sub">Round ${g.round} · ${g.draw} left in the pile</div>`
      : `Round ${g.round} over<div class="sub">${esc(nameIn(g, g.roundWinner))} went out</div>`;

    el('tgt').textContent = '→ ' + g.target;
    el('scores').innerHTML = [...g.seats]
      .sort((a, b) => g.scores[b.id] - g.scores[a.id])
      .map((s) => `
        <li${s.connected ? '' : ' class="gone"'}>
          <div class="chip ${s.color}"></div>
          <div class="nm">${esc(s.name)}${s.id === selfId ? ' <span class="you">you</span>' : ''}</div>
          <div class="pts">${g.scores[s.id]}</div>
        </li>`).join('');

    el('logwrap').innerHTML = g.log.slice().reverse()
      .map((l) => `<div class="logline">${l}</div>`).join('');
  }

  const nameIn = (g, id) => g.seats.find((s) => s.id === id)?.name || 'Someone';

  function renderOver(g) {
    const existing = root.querySelector('.over');
    if (g.phase === 'playing') { existing?.remove(); return; }
    if (existing) return;

    const isHost = selfId === view.hostId;
    const matchOver = g.phase === 'over';
    const winner = nameIn(g, matchOver ? g.winner : g.roundWinner);

    // Show what everyone was holding, so the score is checkable.
    const rows = g.seats.map((s) => {
      const hand = (g.reveal && g.reveal[s.id]) || [];
      const pts = hand.reduce((n, c) => n + cardPoints(c), 0);
      return `<li><span class="nm">${esc(s.name)}</span>
                  <span class="mini">${hand.map((c) => cardHTML(c, { mini: true })).join('') || '—'}</span>
                  <span class="pts">${pts}</span></li>`;
    }).join('');

    const box = document.createElement('div');
    box.className = 'over';
    box.innerHTML = `
      <div class="card2">
        <h2>${esc(winner)} ${matchOver ? 'wins the match!' : 'went out'}</h2>
        <div class="sub">${matchOver ? `${g.scores[g.winner]} points` : `Round ${g.round} scored`}</div>
        <ul class="tally">${rows}</ul>
        ${isHost
          ? `<button class="primary go">${matchOver ? 'New match' : 'Next round'}</button>`
          : '<div class="hint">Waiting for the host…</div>'}
      </div>`;
    root.querySelector('.table').appendChild(box);
    box.querySelector('.go')?.addEventListener('click', () => intent({ t: matchOver ? 'rematch' : 'next' }));
  }

  /* ---------- card rendering ---------- */

  function cardHTML(c, { playable = false, big = false, mini = false } = {}) {
    const face = GLYPH[c.value] ?? String(c.value);
    const cls = ['card', c.color || 'wild'];
    if (playable) cls.push('playable');
    if (big) cls.push('big');
    if (mini) cls.push('mini');
    if (isWild(c)) cls.push('is-wild');
    return `<div class="${cls.join(' ')}" data-id="${c.id}" title="${esc(cardName(c))}">
              <span class="corner tl">${esc(face)}</span>
              <span class="face">${esc(face)}</span>
              <span class="corner br">${esc(face)}</span>
            </div>`;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  showLobby();
}

export default { id: 'uno', title: 'Uno', init };
