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
// Modules are grouped, not flat. Study is not a game: it has no room code, no
// opponent, and you arrive at it in a different frame of mind. Grouping keeps
// that distinction visible in the one place the user actually chooses from,
// rather than leaving "Flashcards" sitting in a row next to "Snake" as if they
// were the same kind of thing. Order here is the order on screen.
//
// ---- The switcher ----
// This used to be a flat strip of every module's name across the header. That
// strip shared its row with whatever controls the active module puts in the
// header slot ("Official rules · stacking on · to 500", plus its buttons), and
// with eight modules the two halves were fighting over the same pixels — the
// strip wrapped to a second line on a laptop and to a third on a phone.
//
// So: one button naming where you are, and a popover holding everywhere you
// could go. The header cost is now fixed no matter how many games get added,
// and the grouping that the strip could only afford to whisper (a caption in
// 10px grey, dropped entirely on narrow screens) gets stated properly.

import meridian from './games/meridian.js';
import ludo from './games/ludo/index.js';
import uno from './games/uno/index.js';
import xo from './games/xo/index.js';
import snake from './games/snake/index.js';
import flappy from './games/flappy/index.js';
import impostor from './games/impostor/index.js';
import bros from './games/bros/index.js';
import gta from './games/gta/index.js';
import flashcards from './study/flashcards/index.js';

const SECTIONS = [
  { id: 'games', label: 'Games', modules: [meridian, ludo, uno, xo, snake, flappy, impostor, bros, gta] },
  { id: 'study', label: 'Study', modules: [flashcards] },
];

const MODULES = SECTIONS.flatMap((s) => s.modules);

const navEl = document.getElementById('nav');
const panelsEl = document.getElementById('panels');
const headerSlot = document.getElementById('headerslot');

const views = new Map(); // id -> { game, panel, header, item, started }

const menuBtn = document.createElement('button');
menuBtn.className = 'navmenu-btn';
menuBtn.id = 'navmenu-btn';
menuBtn.setAttribute('aria-haspopup', 'menu');
menuBtn.setAttribute('aria-expanded', 'false');
menuBtn.innerHTML =
  '<span class="navmenu-now"></span>' +
  '<svg class="navmenu-chev" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">' +
  '<path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';
navEl.appendChild(menuBtn);

const nowEl = menuBtn.querySelector('.navmenu-now');

const pop = document.createElement('div');
pop.className = 'navmenu-pop';
pop.setAttribute('role', 'menu');
pop.setAttribute('aria-labelledby', menuBtn.id);
pop.hidden = true;
navEl.appendChild(pop);

const items = []; // flat, in visual order — this is the arrow-key ring

for (const section of SECTIONS) {
  const group = document.createElement('div');
  group.className = 'navmenu-group';
  // The caption is decoration for sighted users; the group's accessible name
  // carries the same information for anyone arrowing through the menu.
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', section.label);
  group.innerHTML = `<span class="navmenu-cap">${section.label}</span>`;
  const grid = document.createElement('div');
  grid.className = 'navmenu-grid';
  // Layout box only — without this the wrapper sits between the group and its
  // menuitems and breaks the ownership chain assistive tech walks.
  grid.setAttribute('role', 'none');
  group.appendChild(grid);
  pop.appendChild(group);

  for (const game of section.modules) {
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.id = 'panel-' + game.id;
    // Not `tabpanel` any more: that role only means anything next to a
    // tablist, and the thing steering these panels is now a menu.
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', game.title);
    panel.hidden = true;
    panelsEl.appendChild(panel);

    const header = document.createElement('div');
    header.className = 'slot';
    header.hidden = true;
    headerSlot.appendChild(header);

    const item = document.createElement('button');
    item.className = 'navmenu-item';
    item.textContent = game.title;
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-controls', panel.id);
    // Roving tabindex: the menu is one tab stop, arrows move within it.
    item.tabIndex = -1;
    item.onclick = () => { location.hash = game.id; closeMenu({ refocus: true }); };
    grid.appendChild(item);
    items.push(item);

    views.set(game.id, { game, panel, header, item, started: false });
  }
}

// ---- opening, closing, and getting back out ----

function openMenu() {
  if (!pop.hidden) return;
  pop.hidden = false;
  menuBtn.setAttribute('aria-expanded', 'true');
  // Land on where you already are, so the first arrow press moves relative to
  // the current module rather than from the top of the list.
  (current?.item ?? items[0]).focus();
}

function closeMenu({ refocus = false } = {}) {
  if (pop.hidden) return;
  pop.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
  // Whatever had focus is inside a menu that just vanished, so unless focus is
  // already on its way elsewhere (a click outside, a Tab), hand it back to the
  // button — otherwise it falls to <body> and the next Tab restarts from the
  // top of the page. Programmatic focus does not draw a ring for a mouse user.
  if (refocus) menuBtn.focus();
}

menuBtn.onclick = () => { pop.hidden ? openMenu() : closeMenu({ refocus: true }); };

menuBtn.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(); }
});

pop.addEventListener('keydown', (e) => {
  const i = items.indexOf(document.activeElement);
  if (i < 0) return;
  // Arrows walk the flat order in both axes. The grid reflows between two and
  // three columns with the viewport, so column-aware stepping would be a lie
  // half the time; walking the reading order is at least always true.
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (step) {
    e.preventDefault();
    items[(i + step + items.length) % items.length].focus();
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    items[e.key === 'Home' ? 0 : items.length - 1].focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeMenu({ refocus: true });
  } else if (e.key === 'Tab') {
    // Tabbing out of an open menu should close it, not leave it hanging over
    // the page while focus is somewhere else entirely.
    closeMenu();
  }
});

// Anywhere outside the nav dismisses. `mousedown` rather than `click` so the
// menu is gone by the time a click lands on whatever is underneath it.
document.addEventListener('mousedown', (e) => {
  if (!pop.hidden && !navEl.contains(e.target)) closeMenu();
});

let current = null;

function show(id) {
  const view = views.get(id);
  if (!view || view === current) return;

  if (current) {
    current.panel.hidden = true;
    current.header.hidden = true;
    current.item.removeAttribute('aria-current');
    current.game.onHide?.();
  }

  view.panel.hidden = false;
  view.header.hidden = false;
  view.item.setAttribute('aria-current', 'true');
  nowEl.textContent = view.game.title;

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
