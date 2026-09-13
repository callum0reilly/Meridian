// Meridian Bros — sound. Every cue is synthesised on the spot with the Web
// Audio API: square and triangle oscillators with short envelopes, the way a
// 1985 sound chip would have done it. No files, nothing to load, and a
// blocked/absent AudioContext degrades to silence rather than an error.
//
// The context can only be created in response to a user gesture, so `unlock()`
// is called from the first keydown and everything before it is dropped.

const KEY = 'bros.muted';

let ctx = null;
let master = null;
let muted = false;
try { muted = localStorage.getItem(KEY) === '1'; } catch { /* private mode */ }

export function unlock() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.35;
    master.connect(ctx.destination);
  } catch { ctx = null; }
}

export const isMuted = () => muted;

export function setMuted(on) {
  muted = !!on;
  if (master) master.gain.value = muted ? 0 : 0.35;
  try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch { /* ignore */ }
}

/**
 * One voice: a note that can slide, with an attack/decay envelope.
 * @param type    'square' | 'triangle' | 'sawtooth' | 'sine'
 * @param f0,f1   start/end frequency (Hz); f1 defaults to f0
 * @param dur     seconds
 * @param vol     peak gain
 * @param at      start offset in seconds
 */
function tone(type, f0, f1, dur, vol = 0.5, at = 0) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** White-ish noise burst for thuds and crumbles. */
function noise(dur, vol = 0.3, at = 0, cutoff = 1200) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const s = ctx.createBufferSource();
  s.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = cutoff;
  const g = ctx.createGain();
  g.gain.value = vol;
  s.connect(f); f.connect(g); g.connect(master);
  s.start(t);
}

/* The cues. Pitches are in Hz; the melodies are little arpeggios in C. */

export const sfx = {
  jump()       { tone('square', 330, 660, 0.12, 0.25); },
  land()       { noise(0.05, 0.12, 0, 600); },
  coin()       { tone('square', 988, 988, 0.06, 0.3); tone('square', 1319, 1319, 0.22, 0.3, 0.06); },
  gem()        { [784, 988, 1175, 1568].forEach((f, i) => tone('triangle', f, f, 0.14, 0.35, i * 0.07)); },
  bump()       { tone('square', 220, 160, 0.08, 0.3); noise(0.04, 0.15, 0, 900); },
  stomp()      { tone('square', 200, 60, 0.12, 0.4); noise(0.06, 0.2, 0, 800); },
  spring()     { tone('square', 200, 900, 0.22, 0.3); },
  hurt()       { tone('sawtooth', 300, 120, 0.25, 0.35); },
  die()        { [523, 494, 440, 392, 349, 330, 294, 262].forEach((f, i) => tone('square', f, f, 0.1, 0.3, i * 0.09)); },
  checkpoint() { tone('triangle', 659, 659, 0.1, 0.3); tone('triangle', 988, 988, 0.18, 0.3, 0.1); },
  powerup()    { [523, 659, 784, 1047, 1319].forEach((f, i) => tone('square', f, f, 0.09, 0.28, i * 0.05)); },
  heart()      { [392, 523, 659, 784].forEach((f, i) => tone('triangle', f, f * 1.01, 0.12, 0.35, i * 0.08)); },
  buffEnd()    { tone('square', 784, 392, 0.2, 0.2); },
  oneUp()      { [659, 784, 1319, 1047, 1175, 1568].forEach((f, i) => tone('square', f, f, 0.1, 0.3, i * 0.08)); },
  splash()     { noise(0.18, 0.28, 0, 2400); tone('sine', 420, 180, 0.2, 0.15); },
  swim()       { noise(0.06, 0.1, 0, 1600); },
  crack()      { noise(0.07, 0.25, 0, 1500); tone('square', 180, 140, 0.06, 0.2); },
  smash()      { noise(0.22, 0.35, 0, 900); tone('square', 140, 60, 0.18, 0.3); },
  key()        { [1047, 1319, 1568, 2093].forEach((f, i) => tone('triangle', f, f, 0.12, 0.3, i * 0.06)); },
  unlock()     { tone('square', 196, 196, 0.15, 0.3); tone('square', 262, 262, 0.15, 0.3, 0.15); tone('square', 392, 392, 0.35, 0.3, 0.3); noise(0.3, 0.15, 0.3, 500); },
  zap()        { tone('sawtooth', 900, 200, 0.18, 0.3); noise(0.08, 0.2, 0, 3000); },
  flag() {
    // Course clear: a rising fanfare with a held chord at the end.
    const m = [523, 523, 523, 659, 784, 1047];
    m.forEach((f, i) => tone('square', f, f, i === m.length - 1 ? 0.6 : 0.13, 0.28, i * 0.13));
    tone('triangle', 262, 262, 0.7, 0.25, 0.65);
    tone('triangle', 392, 392, 0.7, 0.2, 0.65);
  },
  gameOver() {
    [392, 370, 349, 330].forEach((f, i) => tone('triangle', f, f, 0.45, 0.35, i * 0.4));
    tone('square', 165, 130, 1.0, 0.25, 1.6);
  },
};
