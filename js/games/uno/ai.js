// Uno computer players. Pure: a player's *view* in, one intent out.
//
// A bot is handed exactly what a person in its seat would see — its own hand,
// everyone else's card counts, the top of the pile (see `viewFor` in
// index.js) — so it can't peek at hands or at whether a +4 was a bluff.
//
//   easy    plays any card that fits, often forgets to call Uno, rarely
//           challenges, and doesn't always pass a draw chain on
//   medium  saves its wilds, dumps its big cards, hits a player who is
//           nearly out with its action cards
//   hard    all of that, plus steering the colour towards its own hand and
//           never bluffing a +4 unless the next player is about to win

import { COLORS, isWild, cardPoints } from './rules.js';

export const UNO_MEMORY = { easy: 0.55, medium: 0.9, hard: 1 };   // chance of calling Uno in time
export const CATCH_CHANCE = { easy: 0.3, medium: 0.6, hard: 0.9 }; // chance of catching someone who didn't

const nextSeat = (g, selfId) => {
  const n = g.seats.length;
  const me = g.seats.findIndex((s) => s.id === selfId);
  for (let k = 1; k <= n; k++) {
    const s = g.seats[(me + g.dir * k + n * k) % n];
    if (s.connected && s.id !== selfId) return s;
  }
  return null;
};

/** The colour most of `hand` is — what to call on a wild. */
export function bestColor(hand, rng = Math.random) {
  const counts = Object.fromEntries(COLORS.map((c) => [c, 0]));
  for (const c of hand) if (c.color && counts[c.color] !== undefined) counts[c.color] += 1 + cardPoints(c) / 50;
  const top = Math.max(...Object.values(counts));
  const best = COLORS.filter((c) => counts[c] === top);
  return best[Math.floor(rng() * best.length)];
}

/**
 * What to do now, as an intent message for `onHostMessage`:
 * {t:'color'} | {t:'challenge'} | {t:'take'} | {t:'play', cardId, color} |
 * {t:'draw'} | {t:'pass'}. Only called on the bot's own turn.
 */
export function chooseAction(g, selfId, level = 'medium', rng = Math.random) {
  const hand = g.hand;
  const legal = hand.filter((c) => g.legal.includes(c.id));
  const colorFor = (card) => bestColor(hand.filter((c) => c.id !== card.id), rng);
  const play = (card) => ({ t: 'play', cardId: card.id, color: isWild(card) ? colorFor(card) : undefined });

  if (g.needsColor) return { t: 'color', color: bestColor(hand, rng) };

  // A +4 aimed at us: pass it on if we can, otherwise call the bluff or eat it.
  if (g.challenge?.byId === selfId) {
    if (legal.length && (level !== 'easy' || rng() < 0.5)) return play(legal[0]);
    const liar = g.seats.find((s) => s.id === g.challenge.playerId);
    const theirCards = g.counts[liar?.id] ?? 0;
    // Someone holding lots of cards probably had the colour and bluffed.
    const odds = { easy: 0.12, medium: 0.25, hard: theirCards >= 5 ? 0.45 : 0.2 }[level] ?? 0.25;
    return rng() < odds ? { t: 'challenge' } : { t: 'take' };
  }

  // A draw chain: stack onto it (a +2 before a +4, to keep the big one) or take it.
  if (g.pending) {
    if (legal.length && (level !== 'easy' || rng() < 0.6)) {
      return play(legal.find((c) => c.value === 'draw2') || legal[0]);
    }
    return { t: 'take' };
  }

  if (g.mustPass) return { t: 'pass' };
  if (g.drawnId) {
    const drawn = legal.find((c) => c.id === g.drawnId);
    return drawn ? play(drawn) : { t: 'pass' };
  }
  if (!legal.length) return { t: 'draw' };
  if (level === 'easy') return play(legal[Math.floor(rng() * legal.length)]);

  const next = nextSeat(g, selfId);
  const nextCount = next ? g.counts[next.id] ?? 7 : 7;
  let best = legal[0];
  let bestScore = -Infinity;
  for (const card of legal) {
    const score = scoreCard(g, hand, card, level, nextCount) + rng() * 0.5;
    if (score > bestScore) { bestScore = score; best = card; }
  }
  return play(best);
}

function scoreCard(g, hand, card, level, nextCount) {
  const rest = hand.filter((c) => c.id !== card.id);
  let score = cardPoints(card) * 0.3;                          // shed the expensive cards first
  const threat = nextCount <= 2;

  if (card.value === 'skip' || card.value === 'rev' || card.value === 'draw2') {
    score += threat ? 40 : 4;
  }
  if (card.value === 'wild') score += rest.length <= 1 ? 30 : -25;
  if (card.value === 'wild4') {
    score += threat ? 45 : rest.length <= 1 ? 30 : -35;
    // Holding the active colour makes it a bluff. Hard players only risk
    // that to stop someone winning.
    const bluff = rest.some((c) => c.color === g.color);
    if (bluff && level === 'hard' && !threat) score -= 60;
  }

  if (level === 'hard' && !isWild(card)) {
    // Leave the colour on something we have plenty more of.
    score += rest.filter((c) => c.color === card.color).length * 6;
  }
  return score;
}

/** Should this bot call Uno before playing its second-to-last card? */
export const remembersUno = (level, rng = Math.random) => rng() < (UNO_MEMORY[level] ?? 0.9);
