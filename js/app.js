// App shell: owns the tab strip and decides which game is on screen.
//
// A game module is a plain object:
//   { id, title, init(root, header) }
// `init` runs once, lazily, the first time its tab is opened. Panels then stay
// in the DOM (just hidden), so switching tabs never destroys a game in progress
// — you can check the map mid-Ludo-game and come back to your turn.
//
// Optional hooks: onShow() / onHide() for games that need to pause work while
// they are off screen.

import meridian from './games/meridian.js';
import ludo from './games/ludo/index.js';
import uno from './games/uno/index.js';

const GAMES = [meridian, ludo, uno];

const tabsEl = document.getElementById('tabs');
const panelsEl = document.getElementById('panels');
const headerSlot = document.getElementById('headerslot');

const views = new Map(); // id -> { game, panel, header, started }

for (const game of GAMES) {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.id = 'panel-' + game.id;
  panel.setAttribute('role', 'tabpanel');
  panel.hidden = true;
  panelsEl.appendChild(panel);

  const header = document.createElement('div');
  header.className = 'slot';
  header.hidden = true;
  headerSlot.appendChild(header);

  const tab = document.createElement('button');
  tab.textContent = game.title;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false');
  tab.setAttribute('aria-controls', panel.id);
  tab.onclick = () => { location.hash = game.id; };
  tabsEl.appendChild(tab);

  views.set(game.id, { game, panel, header, tab, started: false });
}

let current = null;

function show(id) {
  const view = views.get(id);
  if (!view || view === current) return;

  if (current) {
    current.panel.hidden = true;
    current.header.hidden = true;
    current.tab.setAttribute('aria-selected', 'false');
    current.game.onHide?.();
  }

  view.panel.hidden = false;
  view.header.hidden = false;
  view.tab.setAttribute('aria-selected', 'true');

  // Lazily boot the game the first time you land on its tab. Meridian builds a
  // few hundred SVG paths on init, so there is no point paying for it if you
  // only came here to play Ludo.
  if (!view.started) {
    view.started = true;
    try {
      view.game.init(view.panel, view.header);
    } catch (err) {
      console.error('[' + id + '] failed to start', err);
      view.panel.innerHTML =
        '<div class="bootfail">' + view.game.title + ' failed to start. ' +
        'Check the browser console.</div>';
    }
  }

  current = view;
  view.game.onShow?.();
}

function route() {
  const id = location.hash.replace(/^#/, '');
  show(views.has(id) ? id : GAMES[0].id);
}

window.addEventListener('hashchange', route);
route();
