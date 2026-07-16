// Board geometry: where every square lives on the classic 15x15 Ludo grid.
// Pure coordinates — rules.js never imports this, and this never imports rules.
//
//        col 0                     14
//   row 0  ┌────────┬───┬────────┐
//          │  RED   │ ↓ │ GREEN  │      Yards are the 6x6 corners.
//          │  yard  │   │  yard  │      The cross arms are cols 6-8 / rows 6-8.
//      6   ├────────┼───┼────────┤      Centre (7,7) is home.
//      7   │ →      │ ⌂ │      ← │
//      8   ├────────┼───┼────────┤
//          │  BLUE  │ ↑ │ YELLOW │
//     14   └────────┴───┴────────┘
//
// Play runs clockwise. TRACK[0] is red's start square; green/yellow/blue join
// at TRACK[13]/[26]/[39], which is what rules.js START encodes.

export const GRID = 15;

/** The 52 shared squares, clockwise from red's start at (1,6). */
export const TRACK = [
  // left arm, heading right toward the top
  [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
  [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0],
  [7, 0], [8, 0],
  // top arm, heading down and right  (index 13 = green start)
  [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6],
  [14, 7], [14, 8],
  // right arm, heading left and down (index 26 = yellow start)
  [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
  [8, 9], [8, 10], [8, 11], [8, 12], [8, 13], [8, 14],
  [7, 14], [6, 14],
  // bottom arm, heading up and left  (index 39 = blue start)
  [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
  [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  [0, 7], [0, 6],
];

/** Each colour's private 5-square run into the centre, in travel order. */
export const HOME_COLUMN = {
  red:    [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  green:  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  yellow: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
  blue:   [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
};

/** The 6x6 corner each colour starts in: [col, row] of its top-left cell. */
export const YARD_ORIGIN = { red: [0, 0], green: [9, 0], yellow: [9, 9], blue: [0, 9] };

/** Resting spots for the 4 tokens still in a yard, as fractional grid coords. */
export const YARD_SLOTS = Object.fromEntries(
  Object.entries(YARD_ORIGIN).map(([color, [c, r]]) => [color, [
    [c + 1.5, r + 1.5], [c + 3.5, r + 1.5],
    [c + 1.5, r + 3.5], [c + 3.5, r + 3.5],
  ]]),
);

/** Where finished tokens sit in the centre — fanned out so all 4 stay visible. */
export const HOME_SLOTS = {
  red:    [[6.3, 7.0], [6.6, 6.7], [6.6, 7.3], [6.9, 7.0]],
  green:  [[7.0, 6.3], [6.7, 6.6], [7.3, 6.6], [7.0, 6.9]],
  yellow: [[8.7, 7.0], [8.4, 6.7], [8.4, 7.3], [8.1, 7.0]],
  blue:   [[7.0, 8.7], [6.7, 8.4], [7.3, 8.4], [7.0, 8.1]],
};

/** Centre of a grid cell in SVG units (1 unit = 1 cell). */
export const cellCentre = ([c, r]) => [c + 0.5, r + 0.5];
