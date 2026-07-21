// App shell: owns the tab strip and decides which module is on screen.
//
// A module is a plain object:
//   { id, title, section, init(root, header) }
// `init` runs once, lazily, the first time its tab is opened. Panels then stay
// in the DOM (just hidden), so switching tabs never destroys work in progress
// — you can check the map mid-Ludo-game and come back to your turn, or flip
// back to a half-finished revision session.
//
// Optional hooks: onShow() / onHide() for modules that need to pause work while
// they are off screen.
//
// ---- Sections ----
// Tabs are grouped, not flat. Study is not a game: it has no room code, no
// opponent, and you arrive at it in a different frame of mind. Grouping keeps
// that distinction visible in the one place the user actually chooses from,
// rather than leaving "Flashcards" sitting in a row next to "Snake" as if they
// were the same kind of thing. Order here is the order on screen.

import meridian from './games/meridian.js';
import ludo from './games/ludo/index.js';
import uno from './games/uno/index.js';
import xo from './games/xo/index.js';
import snake from './games/snake/index.js';
import flashcards from './study/flashcards/index.js';

const SECTIONS = [
  { id: 'games', label: 'Games', modules: [meridian, ludo, uno, xo, snake] },
  { id: 'study', label: 'Study', modules: [flashcards] },
];

const MODULES = SECTIONS.flatMap((s) => s.modules);

const tabsEl = document.getElementById('tabs');
const panelsEl = document.getElementById('panels');
const headerSlot = document.getElementById('headerslot');

const views = new Map(); // id -> { game, panel, header, started }

for (const section of SECTIONS) {
  const group = document.createElement('div');
  group.className = 'tabgroup';
  // The label is decoration for sighted users; the group's accessible name
  // carries the same information for anyone arrowing through the strip.
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', section.label);
  group.innerHTML = `<span class="tabgroup-label">${section.label}</span>`;
  tabsEl.appendChild(group);

  for (const game of section.modules) {
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
    group.appendChild(tab);

    views.set(game.id, { game, panel, header, tab, started: false });
  }
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

  // Lazily boot the module the first time you land on its tab. Meridian builds
  // a few hundred SVG paths on init, so there is no point paying for it if you
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
  show(views.has(id) ? id : MODULES[0].id);
}

window.addEventListener('hashchange', route);
route();
