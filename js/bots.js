// Computer players for the turn-based games — the parts every game shares.
//
// A computer player is just a seat with `bot` set to its difficulty. It never
// has a connection: the host (or, in a solo game, your own browser) notices
// it is the bot's turn and feeds its choice through the same `onHostMessage`
// path a person's click takes. So a bot is held to exactly the rules everyone
// else is, and there is no second copy of "is this move allowed".
//
// What each bot actually thinks lives next to its game, in `ai.js`, as pure
// functions the tests can drive without a DOM.

export const LEVELS = ['easy', 'medium', 'hard'];
export const LEVEL_NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

const NAMES = ['Robo', 'Chip', 'Bolt', 'Pixel', 'Sprocket', 'Widget', 'Gizmo', 'Byte', 'Cog'];

/** A new computer seat, named so it doesn't clash with anyone already seated. */
export function botSeat(seats, level, extra = {}) {
  const taken = new Set(seats.map((s) => s.name));
  const name = NAMES.find((n) => !taken.has(n)) || `CPU ${seats.length + 1}`;
  return {
    id: 'bot-' + Math.random().toString(36).slice(2, 10),
    name,
    bot: LEVELS.includes(level) ? level : 'medium',
    connected: true,
    ...extra,
  };
}

/** The little grey label after a name in a seat list. */
export function seatBadge(seat, hostId, selfId) {
  if (seat.bot) return `computer · ${LEVEL_NAMES[seat.bot].toLowerCase()}`;
  return [seat.id === hostId ? 'host' : '', seat.id === selfId ? 'you' : ''].filter(Boolean).join(' · ');
}

/** A pause before a bot acts, so its move reads as a move and not a flicker. */
export const thinkDelay = (min = 600, spread = 500) => min + Math.random() * spread;

const levelOptions = () => LEVELS.map((l) =>
  `<option value="${l}"${l === 'medium' ? ' selected' : ''}>${LEVEL_NAMES[l]}</option>`).join('');

/**
 * The lobby's "play the computer" block. `counts` is the most computer
 * opponents the game allows; omitted for the two-player games, where it is
 * always one.
 */
export function soloHTML({ counts = 0 } = {}) {
  const countSelect = counts > 1
    ? `<select class="solocount" aria-label="Computer opponents">${Array.from({ length: counts }, (_, k) =>
        `<option value="${k + 1}">${k + 1} ${k ? 'opponents' : 'opponent'}</option>`).join('')}</select>`
    : '';
  return `
      <div class="or">or</div>

      <div class="field">
        <label>Play the computer</label>
        <div class="row">
          <select class="sololevel" aria-label="Difficulty">${levelOptions()}</select>
          ${countSelect}
          <button class="primary solo">Play</button>
        </div>
      </div>`;
}

/** The host's "add a computer player" row in the waiting room. */
export const ADD_BOT_HTML = `
      <div class="row botadd">
        <select class="botlevel" aria-label="Difficulty">${levelOptions()}</select>
        <button class="addbot">Add computer player</button>
      </div>`;

/** Wire up the waiting room's bot controls after the seat list is drawn. */
export function bindBotControls(root, { isHost, full, intent }) {
  const row = root.querySelector('.botadd');
  if (row) {
    row.hidden = !isHost || full;
    row.querySelector('.addbot').onclick = () => intent({ t: 'addbot', level: row.querySelector('.botlevel').value });
  }
  for (const b of root.querySelectorAll('.seats .kick')) b.onclick = () => intent({ t: 'kick', id: b.dataset.id });
}

/** The remove button a host sees next to a computer seat. */
export const kickButton = (seat, isHost) =>
  isHost && seat.bot ? `<button class="kick" data-id="${seat.id}">Remove</button>` : '';
