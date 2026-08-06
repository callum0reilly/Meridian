// The Sims 5 — the catalogue. Pure data, imports nothing.
//
// Everything a household can be, want, buy or become is a table in this file:
// needs and their decay, traits and their multipliers, every object with its
// price and interactions, the three careers, the social moves, and the townies
// who ring the doorbell. rules.js reads these tables; index.js reads them too
// (for menus and the buy catalogue) but neither ever hard-codes a number that
// belongs here.
//
// The shape that matters most is an interaction:
//   { id, label, minutes, perMin: {need: +/-per-sim-minute}, onDone: {...} }
// The context menu is generated straight from these entries — adding an object
// to OBJECTS is the whole job of adding an object to the game.

/* ============================== needs ============================== */

// Seven stored needs, 0..100. "Room" is the eighth bar on screen but is derived
// from decor in the sim's current room, so it lives in rules.js, not here.
// decay is per sim-HOUR while awake; mood weights skew the average toward the
// needs that kill you.
export const NEEDS = [
  { id: 'hunger',  label: 'Hunger',  decay: 4.5, weight: 1.5 },
  { id: 'energy',  label: 'Energy',  decay: 5.0, weight: 1.25 },
  { id: 'bladder', label: 'Bladder', decay: 8.0, weight: 1 },
  { id: 'hygiene', label: 'Hygiene', decay: 3.5, weight: 1 },
  { id: 'fun',     label: 'Fun',     decay: 4.0, weight: 1 },
  { id: 'social',  label: 'Social',  decay: 3.0, weight: 1 },
  { id: 'comfort', label: 'Comfort', decay: 2.5, weight: 1 },
];
export const ROOM_WEIGHT = 0.5;

/* ============================== traits ============================== */

// Two per sim, chosen at creation, never changed. Each trait is a bag of
// multipliers with defaults of 1 — rules.js asks traitMult(sim, key) and
// multiplies whatever it was about to do. Keys:
//   decay.<need>  — need decay speed
//   skill.<skill> — skill gain speed
//   rel           — relationship gains (both directions)
//   townieRel     — relationship gains with townies specifically
//   romance       — romance gains
//   rejection     — sting of a failed social
export const TRAITS = [
  { id: 'neat',      label: 'Neat',             blurb: 'Hygiene fades slower.',
    mult: { 'decay.hygiene': 0.6 } },
  { id: 'slob',      label: 'Slob',             blurb: 'Hygiene fades fast; blind to mess.',
    mult: { 'decay.hygiene': 1.5 }, ignoreRoom: true },
  { id: 'active',    label: 'Active',           blurb: 'Trains fitness fast, hates sitting still.',
    mult: { 'skill.fitness': 1.4, 'decay.comfort': 1.2 } },
  { id: 'couch',     label: 'Couch Potato',     blurb: 'Fun fades slower; allergic to exercise.',
    mult: { 'decay.fun': 0.7, 'skill.fitness': 0.6 } },
  { id: 'butterfly', label: 'Social Butterfly', blurb: 'Needs people; friendships bloom.',
    mult: { 'decay.social': 1.5, rel: 1.4 } },
  { id: 'loner',     label: 'Loner',            blurb: 'Happy alone; cool with strangers.',
    mult: { 'decay.social': 0.5, townieRel: 0.7 } },
  { id: 'foodie',    label: 'Foodie',           blurb: 'Meals delight; learns cooking fast.',
    mult: { 'skill.cooking': 1.3 }, mealFun: 15 },
  { id: 'romantic',  label: 'Romantic',         blurb: 'Falls hard, and falls hard.',
    mult: { romance: 1.5, rejection: 2 } },
];

/* ============================== objects ============================== */

// Footprints are w×d tiles in local space with rot 0 = unrotated; rot 1..3 turn
// clockwise. slots are the tiles a sim stands on to use the thing, in local
// coords relative to the anchor tile — they may fall outside the footprint.
// h is render height in iso-pixels; color feeds isoBox. decor is the room-score
// contribution of sharing a room with it (puddles and urns argue for negative
// and zero respectively).
//
// perMin deltas are per sim-minute; onDone fires once at completion.
// Special interaction fields:
//   until: 'energy'      — completes early once that need is full (sleep)
//   set: {need: value}   — onDone hard-set (toilets don't top up by degrees)
//   skillPerMin          — skill gain per minute of doing it
//   fireRisk: true       — completion rolls the kitchen-fire chance
//   requires: {object}   — greyed out unless that object exists on the lot
export const OBJECTS = {
  fridge:    { label: 'Fridge',         cat: 'Kitchen',  price: 600, w: 1, d: 1, h: 44, color: '#9fb4c8', decor: 0,
               slots: [[0, 1], [1, 0], [0, -1], [-1, 0]],
               interactions: [
                 { id: 'snack',   label: 'Have a Snack', minutes: 10, perMin: { hunger: 1.5 } },
                 { id: 'quick',   label: 'Quick Meal',   minutes: 20, perMin: { hunger: 2.0 } },
               ] },
  stove:     { label: 'Stove',          cat: 'Kitchen',  price: 450, w: 1, d: 1, h: 22, color: '#8a93a6', decor: 0,
               slots: [[0, 1], [1, 0], [0, -1], [-1, 0]],
               interactions: [
                 { id: 'cook',    label: 'Cook Dinner',  minutes: 30, perMin: { hunger: 65 / 30 },
                   skillPerMin: { cooking: 0.005 }, fireRisk: true, requires: { object: 'fridge' } },
               ] },
  counter:   { label: 'Counter',        cat: 'Kitchen',  price: 180, w: 1, d: 1, h: 20, color: '#b7a98c', decor: 1,
               slots: [], interactions: [] },
  toilet:    { label: 'Toilet',         cat: 'Bathroom', price: 280, w: 1, d: 1, h: 18, color: '#e8ecef', decor: 0,
               slots: [[0, 1], [1, 0], [0, -1], [-1, 0]],
               interactions: [
                 { id: 'use',     label: 'Use',          minutes: 5,  perMin: {}, set: { bladder: 100 } },
               ] },
  shower:    { label: 'Shower',         cat: 'Bathroom', price: 350, w: 1, d: 2, h: 52, color: '#a9cfd8', decor: 0,
               slots: [[1, 0], [-1, 0], [1, 1], [-1, 1]],
               interactions: [
                 { id: 'shower',  label: 'Take a Shower', minutes: 15, perMin: { hygiene: 70 / 15 } },
               ] },
  sink:      { label: 'Sink',           cat: 'Bathroom', price: 120, w: 1, d: 1, h: 22, color: '#cfd8dd', decor: 0,
               slots: [[0, 1], [1, 0], [0, -1], [-1, 0]],
               interactions: [
                 { id: 'wash',    label: 'Wash Hands',   minutes: 3,  perMin: { hygiene: 10 / 3 } },
               ] },
  bed:       { label: 'Single Bed',     cat: 'Comfort',  price: 300, w: 1, d: 2, h: 16, color: '#7f9fd1', decor: 1,
               slots: [[1, 0], [-1, 0], [1, 1], [-1, 1]],
               interactions: [
                 { id: 'sleep',   label: 'Sleep',        minutes: 600, until: 'energy',
                   perMin: { energy: 12.5 / 60, comfort: 5 / 60 } },
               ] },
  bigbed:    { label: 'Double Bed',     cat: 'Comfort',  price: 900, w: 2, d: 2, h: 16, color: '#b48fc9', decor: 2,
               slots: [[2, 0], [-1, 0], [2, 1], [-1, 1]],
               interactions: [
                 { id: 'sleep',   label: 'Sleep',        minutes: 600, until: 'energy',
                   perMin: { energy: 14 / 60, comfort: 6 / 60 } },
               ] },
  armchair:  { label: 'Armchair',       cat: 'Comfort',  price: 180, w: 1, d: 1, h: 22, color: '#c98f6e', decor: 1,
               slots: [[0, 0]], seat: true,
               interactions: [
                 { id: 'sit',     label: 'Sit',          minutes: 60, perMin: { comfort: 15 / 60, fun: 3 / 60 } },
               ] },
  sofa:      { label: 'Sofa',           cat: 'Comfort',  price: 400, w: 2, d: 1, h: 22, color: '#8fae7a', decor: 2,
               slots: [[0, 0], [1, 0]], seat: true,
               interactions: [
                 { id: 'sit',     label: 'Sit',          minutes: 60, perMin: { comfort: 18 / 60, fun: 3 / 60 } },
                 { id: 'nap',     label: 'Nap',          minutes: 90, perMin: { energy: 8 / 60, comfort: 6 / 60 } },
               ] },
  tv:        { label: 'Television',     cat: 'Fun',      price: 500, w: 1, d: 1, h: 30, color: '#4c5566', decor: 1,
               slots: [[0, 2], [0, 3], [1, 2], [-1, 2]],
               interactions: [
                 { id: 'watch',   label: 'Watch TV',     minutes: 60, perMin: { fun: 30 / 60 } },
               ] },
  bookshelf: { label: 'Bookshelf',      cat: 'Skill',    price: 250, w: 1, d: 1, h: 46, color: '#a2704f', decor: 2,
               slots: [[0, 1], [1, 0], [0, -1], [-1, 0]],
               interactions: [
                 { id: 'read',    label: 'Read',          minutes: 60, perMin: { fun: 18 / 60 } },
                 { id: 'study',   label: 'Study Cooking', minutes: 90, perMin: {}, skillPerMin: { cooking: 0.011 } },
               ] },
  mirror:    { label: 'Floor Mirror',   cat: 'Skill',    price: 150, w: 1, d: 1, h: 40, color: '#bcc7d4', decor: 1,
               slots: [[0, 1], [1, 0], [0, -1], [-1, 0]],
               interactions: [
                 { id: 'speech',  label: 'Practice Speech', minutes: 90, perMin: {}, skillPerMin: { charisma: 0.011 } },
               ] },
  bench:     { label: 'Exercise Bench', cat: 'Skill',    price: 700, w: 1, d: 2, h: 20, color: '#7d8a95', decor: 0,
               slots: [[1, 0], [-1, 0], [1, 1], [-1, 1]],
               interactions: [
                 { id: 'workout', label: 'Work Out',     minutes: 90, perMin: { hygiene: -10 / 60, fun: 5 / 60 },
                   skillPerMin: { fitness: 0.011 } },
               ] },
  table:     { label: 'Dining Table',   cat: 'Comfort',  price: 250, w: 2, d: 1, h: 18, color: '#b09468', decor: 2,
               slots: [], interactions: [] },
  chair:     { label: 'Chair',          cat: 'Comfort',  price: 80,  w: 1, d: 1, h: 18, color: '#c2a382', decor: 0,
               slots: [[0, 0]], seat: true,
               interactions: [
                 { id: 'sit',     label: 'Sit',          minutes: 60, perMin: { comfort: 8 / 60 } },
               ] },
  stereo:    { label: 'Stereo',         cat: 'Fun',      price: 320, w: 1, d: 1, h: 26, color: '#5d5470', decor: 1,
               slots: [[0, 1], [1, 0], [0, -1], [-1, 0]],
               interactions: [
                 { id: 'dance',   label: 'Dance',        minutes: 30, perMin: { fun: 35 / 60, hygiene: -5 / 60 } },
               ] },
  plant:     { label: 'Potted Plant',   cat: 'Decor',    price: 90,  w: 1, d: 1, h: 28, color: '#4f8a4f', decor: 2,
               slots: [], interactions: [] },
  painting:  { label: 'Painting',       cat: 'Decor',    price: 240, w: 1, d: 1, h: 38, color: '#c9a53d', decor: 4,
               slots: [], interactions: [] },

  // Not for sale. Placed by the game, movable in build mode, never sellable.
  urn:       { label: 'Urn',            cat: 'Decor',    price: 0,   w: 1, d: 1, h: 14, color: '#98a0a8', decor: 0,
               fixed: true, slots: [], interactions: [] },
  puddle:    { label: 'Puddle',         cat: 'Decor',    price: 0,   w: 1, d: 1, h: 2,  color: '#7fa8c9', decor: -3,
               fixed: true, passable: true, slots: [[0, 0]],
               interactions: [
                 { id: 'mop',     label: 'Mop Up',       minutes: 10, perMin: {}, consumes: true },
               ] },
};

// Buy-catalogue order: everything without `fixed`, grouped by cat in this order.
export const CATS = ['Kitchen', 'Bathroom', 'Comfort', 'Fun', 'Skill', 'Decor'];
export const BUYABLE = Object.keys(OBJECTS).filter((k) => !OBJECTS[k].fixed);

/* ---- footprint helpers ---- */

// Width/depth of a def after rotation (odd rotations swap the axes).
export function rotSize(def, rot) {
  const o = OBJECTS[def];
  return (rot % 2 === 0) ? { w: o.w, d: o.d } : { w: o.d, d: o.w };
}

// Rotate a local offset [dx,dy] by rot quarter-turns within/around a footprint.
// The anchor stays the min-corner tile, so rotation re-maps local coords into
// the rotated box rather than spinning about a point.
function rotOffset(dx, dy, rot, w, d) {
  switch (rot & 3) {
    case 0: return [dx, dy];
    case 1: return [d - 1 - dy, dx];
    case 2: return [w - 1 - dx, d - 1 - dy];
    default: return [dy, w - 1 - dx];
  }
}

// Every tile a placed object covers, in world coords.
export function objectTiles(obj) {
  const { w, d } = rotSize(obj.def, obj.rot);
  const tiles = [];
  for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < d; dy++) tiles.push([obj.x + dx, obj.y + dy]);
  return tiles;
}

// The world tiles a sim may stand on to use a placed object, in priority order.
export function slotTiles(obj) {
  const o = OBJECTS[obj.def];
  return o.slots.map(([dx, dy]) => {
    const [rx, ry] = rotOffset(dx, dy, obj.rot, o.w, o.d);
    return [obj.x + rx, obj.y + ry];
  });
}

/* ============================== build prices ============================== */

export const WALL_COST = 14;         // per edge segment; 50% back when bulldozed
export const DOOR_COST = 60;
export const WINDOW_COST = 40;
export const FLOOR_COST = 6;         // per tile repaint
export const RESALE = 0.75;          // furniture buyback
export const WALL_REFUND = 0.5;

export const FLOORS = [
  { id: 0, label: 'Grass',    color: '#5d8a4a' },   // the outdoors; not paintable
  { id: 1, label: 'Boards',   color: '#a8845c' },
  { id: 2, label: 'Tile',     color: '#b8c0c8' },
  { id: 3, label: 'Carpet',   color: '#9d7f9e' },
  { id: 4, label: 'Slate',    color: '#6e7a82' },
];

/* ============================== careers ============================== */

// req is the skill floor to HOLD each level; promotion to level N+1 needs
// levels[N].req met and mood >= 60 when the sim left for work that day.
// Shifts are daily, every day — sims are salaried, not scheduled.
export const CAREERS = {
  culinary: { label: 'Culinary', start: 14, end: 20, levels: [
    { title: 'Dishwasher',      pay: 120, req: {} },
    { title: 'Line Cook',       pay: 180, req: { cooking: 2 } },
    { title: 'Sous Chef',       pay: 260, req: { cooking: 4 } },
    { title: 'Chef',            pay: 380, req: { cooking: 6, charisma: 2 } },
    { title: 'Celebrity Chef',  pay: 560, req: { cooking: 8, charisma: 4 } },
  ] },
  business: { label: 'Business', start: 9, end: 15, levels: [
    { title: 'Mailroom Clerk',  pay: 100, req: {} },
    { title: 'Filing Clerk',    pay: 160, req: { charisma: 2 } },
    { title: 'Manager',         pay: 250, req: { charisma: 4 } },
    { title: 'Executive',       pay: 400, req: { charisma: 6, fitness: 2 } },
    { title: 'CEO',             pay: 620, req: { charisma: 8, fitness: 3 } },
  ] },
  athlete: { label: 'Athlete', start: 8, end: 14, levels: [
    { title: 'Waterperson',     pay: 110, req: {} },
    { title: 'Rookie',          pay: 170, req: { fitness: 2 } },
    { title: 'Starter',         pay: 270, req: { fitness: 4 } },
    { title: 'Star',            pay: 420, req: { fitness: 6, charisma: 2 } },
    { title: 'MVP',             pay: 640, req: { fitness: 8, charisma: 4 } },
  ] },
};
export const SKILLS = ['cooking', 'charisma', 'fitness'];
export const SKILL_LABELS = { cooking: 'Cooking', charisma: 'Charisma', fitness: 'Fitness' };

/* ============================== socials ============================== */

// friend/romance are relationship deltas applied to BOTH sims' view of each
// other; social/fun are need deltas applied to both bodies. minutes is how long
// the pair stands locked together. Gates read the initiator's row toward the
// target. fail is the chance the move lands badly (friend penalty instead).
export const SOCIALS = [
  { id: 'chat',       label: 'Chat',       minutes: 5, social: 15, fun: 0,  friend: 4,  romance: 0 },
  { id: 'joke',       label: 'Tell a Joke', minutes: 4, social: 12, fun: 8,  friend: 6,  romance: 0, fail: 0.10, failFriend: -3 },
  { id: 'compliment', label: 'Compliment', minutes: 3, social: 10, fun: 0,  friend: 8,  romance: 0 },
  { id: 'flirt',      label: 'Flirt',      minutes: 4, social: 10, fun: 0,  friend: 3,  romance: 6,  needFriend: 25 },
  { id: 'kiss',       label: 'Kiss',       minutes: 2, social: 8,  fun: 10, friend: 0,  romance: 12, needRomance: 40 },
  { id: 'propose',    label: 'Propose',    minutes: 3, social: 10, fun: 30, friend: 0,  romance: 10, needRomance: 75, needFriend: 50, partner: true },
];

/* ============================== townies ============================== */

// The whole town, generated once per world from these. Six is enough that you
// meet somebody new for a week, few enough that they become regulars.
export const TOWNIE_NAMES = [
  'Bob Newbie', 'Betty Simovitch', 'Mortimer Goth', 'Bella Goth', 'Claire Charming', 'Marco Flex',
];
export const SHIRTS = [
  '#e5484d', '#3d7dff', '#30a46c', '#f07eb8', '#f7861c', '#ffc53d', '#8b5cf6', '#22c4d6', '#8a6d4a', '#5b6470',
];

/* ============================== tuning ============================== */

export const START_FUNDS = 20000;
export const MAX_SIMS = 4;
export const QUEUE_CAP = 8;
export const WALK_SPEED = 1.6;       // tiles per sim-minute

export const BILL_EVERY_DAYS = 3;
export const BILL_BASE = 60;
export const BILL_RATE = 0.01;       // of placed-object value
export const BILL_GRACE_DAYS = 2;

export const STARVE_GRACE_MIN = 360; // six sim-hours between "empty" and the Reaper
export const REAPER_MIN = 30;        // how long death takes once he's here
export const PASSOUT_MIN = 180;
export const PASSOUT_ENERGY = 60;

export const FIRE_BASE = 0.15;       // cook-fire chance at cooking 0
export const FIRE_PER_SKILL = 0.05;  // subtracted per cooking level
export const FIRE_SPREAD_MIN = 30;
export const FIRE_BURN_MIN = 20;     // object survives this long in flames
export const FIRE_KILL_MIN = 90;     // a sim standing in the smoke this long dies
export const EXTINGUISH_MIN = 15;

export const GHOST_HOUR = 23;        // haunting window is 23:00–05:00
export const GHOST_DAWN = 5;
export const GHOST_CHANCE = 0.4;     // per urn per night
export const GHOST_RANGE = 2.5;
export const SPOOK_FUN = -25;
export const SPOOK_COMFORT = -20;

export const VISIT_CHANCE = 0.6;     // per day
export const VISIT_STAY_MIN = 240;
export const VISIT_CURFEW = 21;      // townies go home at nine
export const LOT_DOOR = [12, 23];    // where the outside world connects

export const SKILL_MAX = 10;
export const MOOD_SKILL_BONUS = 1.25; // learning is faster when life is good (mood >= 70)
export const PROMOTION_MOOD = 60;
