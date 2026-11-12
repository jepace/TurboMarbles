// music.js — adaptive background music, generated live with Web Audio (no files).
//
// The game feeds it the position (update) and moments (roll, hit, home, win):
//   - Intensity (tempo, drums, layers) rises as the leader nears home and the
//     race tightens; a "final lap" lifts the key when someone is about to finish.
//   - Darkness (minor harmony, a low drone) rises when a player risks an aggro
//     (nothing home while the leader is well on the way) or a baggro (all in base).
//   - Every colour has its own motif and instrument. The leader's motif carries
//     the melody; close chasers answer in the gaps, louder as they close in; a
//     change of lead cross-fades over a couple of bars.
//   - Cues on the beat: 6 (rising run + a stuttered double beat; 6-6 bigger), 1 (bell),
//     out of base (pickup), onto the star circle (shimmer), into the hub
//     (swirl down, the mix dips) and out (sweep up), a home slot climbed (tick), the cube turned (timpani + brass) and taken, no move with a roll (deflating wah-wah), hits
//     (the hitter's voice climbs, the victim's falls; heartbreak near home), no aggros left (cadence), marbles home, a new leader (crash + its motif),
//     the final lap (snare riser), and the winner's flourish.
//
// A look-ahead scheduler (the usual Web Audio pattern) queues 16th-note steps
// slightly ahead of time, so timing stays tight even when the page is busy.

let ctx = null, master = null, bus = null, comp = null, tone = null;
let running = false, timer = null;
let enabled = false, muted = false, volume = 0.7;

// ---- Musical material ----------------------------------------------------------

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const MIXO = [0, 2, 4, 5, 7, 9, 10];
const PHRYG = [0, 1, 3, 5, 7, 8, 10];
const HARM = [0, 2, 3, 5, 7, 8, 11];

// Song bases: each game picks one at random (never the same twice in a row).
// A song sets the key, the scales (bright, and dark for aggro risk), the
// four-bar chord loops (scale degrees of the chord roots), the tempo range,
// the beat, the bass line, how the chords are played, swing, echo, and a twist
// on every colour's motif (shift = scale degrees up; the colours keep their
// own instruments and tunes, so the leader is still recognisable).
//   groove: per intensity tier [calm, mid, busy] → { k: kick steps, s: snare steps, h: hat every n 16ths, x: extra }
const G = {
  pop:    [{ k: [0], s: [], h: 0 }, { k: [0, 8], s: [4, 12], h: 2 }, { k: [0, 8, 10], s: [4, 12], h: 1 }],
  floor:  [{ k: [0], s: [], h: 0 }, { k: [0, 4, 8, 12], s: [], h: 2, x: 'clap' }, { k: [0, 4, 8, 12], s: [4, 12], h: 1, x: 'clap' }],
  half:   [{ k: [0], s: [], h: 0 }, { k: [0], s: [8], h: 2 }, { k: [0, 3, 10], s: [8], h: 1 }],
  funk:   [{ k: [0], s: [], h: 2 }, { k: [0, 3, 10], s: [4, 12], h: 1 }, { k: [0, 3, 6, 10, 11], s: [4, 12, 15], h: 1 }],
  march:  [{ k: [0], s: [], h: 0 }, { k: [0, 8], s: [4, 12, 14], h: 4 }, { k: [0, 4, 8, 12], s: [2, 4, 10, 12, 14], h: 2 }],
  swing:  [{ k: [0], s: [], h: 4 }, { k: [0, 8], s: [12], h: 2 }, { k: [0, 6, 8], s: [4, 12], h: 2 }],
  reggae: [{ k: [8], s: [], h: 0 }, { k: [8], s: [8], h: 2 }, { k: [0, 8], s: [8], h: 2, x: 'rim' }],
  tom:    [{ k: [0], s: [], h: 0, x: 'tom' }, { k: [0, 10], s: [8], h: 2, x: 'tom' }, { k: [0, 3, 10], s: [4, 12], h: 1, x: 'tom' }],
  chip:   [{ k: [0], s: [], h: 0 }, { k: [0, 8], s: [4, 12], h: 2 }, { k: [0, 6, 8, 14], s: [4, 12], h: 1 }],
  sparse: [{ k: [], s: [], h: 0 }, { k: [0], s: [], h: 4 }, { k: [0, 10], s: [8], h: 2 }],
};
const SONGS = [
  { name: 'Sunny Circuit', root: 48, bright: MAJOR, dark: MINOR, prog: [0, 4, 5, 3], darkProg: [0, 5, 2, 6], bpm: [84, 128], groove: G.pop,   bass: 'roots',  pad: 'sustain', swing: 0,    delay: [0.27, 0.28], shift: 0 },
  { name: 'Midnight Hub',  root: 45, bright: MINOR, dark: HARM,  prog: [0, 6, 5, 6], darkProg: [0, 5, 3, 4], bpm: [72, 116], groove: G.half,  bass: 'pulse',  pad: 'swell',   swing: 0,    delay: [0.42, 0.38], shift: 2 },
  { name: 'Star Track',    root: 50, bright: MAJOR, dark: DORIAN, prog: [0, 3, 0, 4], darkProg: [0, 3, 6, 3], bpm: [92, 138], groove: G.floor, bass: 'octave', pad: 'stabs',   swing: 0,    delay: [0.22, 0.25], shift: 4 },
  { name: 'Lazy Marbles',  root: 53, bright: MAJOR, dark: DORIAN, prog: [1, 4, 0, 5], darkProg: [0, 3, 1, 4], bpm: [70, 110], groove: G.swing, bass: 'walk',   pad: 'stabs',   swing: 0.55, delay: [0.33, 0.2],  shift: 0 },
  { name: 'Bump Funk',     root: 52, bright: DORIAN, dark: MINOR, prog: [0, 3, 0, 3], darkProg: [0, 6, 5, 6], bpm: [90, 124], groove: G.funk,  bass: 'funk',   pad: 'stabs',   swing: 0.18, delay: [0.18, 0.2],  shift: 2 },
  { name: 'Home Stretch',  root: 55, bright: MAJOR, dark: MINOR, prog: [0, 5, 1, 4], darkProg: [0, 3, 4, 0], bpm: [88, 132], groove: G.march, bass: 'roots',  pad: 'sustain', swing: 0,    delay: [0.3, 0.22],  shift: 4 },
  { name: 'Glass Garden',  root: 51, bright: LYDIAN, dark: MINOR, prog: [0, 1, 0, 1], darkProg: [0, 5, 0, 6], bpm: [66, 104], groove: G.sparse, bass: 'pulse', pad: 'arp',     swing: 0,    delay: [0.5, 0.45],  shift: 2 },
  { name: 'Arcade',        root: 46, bright: MIXO,  dark: MINOR, prog: [0, 6, 3, 0], darkProg: [0, 5, 6, 4], bpm: [100, 150], groove: G.chip, bass: 'octave', pad: 'arp',     swing: 0,    delay: [0.15, 0.2],  shift: 0, chip: true },
  { name: 'Desert Lap',    root: 50, bright: PHRYG, dark: HARM,  prog: [0, 1, 0, 6], darkProg: [0, 1, 5, 4], bpm: [80, 120], groove: G.tom,   bass: 'pulse',  pad: 'swell',   swing: 0.1,  delay: [0.37, 0.33], shift: 4 },
  { name: 'Reggae Roll',   root: 57, bright: MAJOR, dark: MINOR, prog: [0, 3, 0, 4], darkProg: [0, 6, 5, 6], bpm: [74, 108], groove: G.reggae, bass: 'reggae', pad: 'skank',  swing: 0.12, delay: [0.38, 0.4],  shift: 2 },
];
let song = SONGS[0];
let delayNode = null, delayFb = null;

// Each colour: an instrument and a two-bar motif. Motif notes are
// [step (0–31, 16ths over two bars), scale degree (relative to the chord), length in steps].
const VOICES = {
  blue:   { inst: 'epiano', oct: 1, motif: [[0, 0, 3], [4, 2, 2], [6, 4, 2], [8, 2, 6], [16, 1, 3], [20, 2, 2], [22, 4, 2], [24, 5, 6]] },
  pink:   { inst: 'pluck',  oct: 2, motif: [[0, 4, 1], [2, 2, 1], [4, 4, 1], [6, 5, 2], [10, 4, 1], [12, 2, 2], [16, 0, 1], [18, 2, 1], [20, 4, 1], [22, 7, 2], [26, 5, 2]] },
  orange: { inst: 'brass',  oct: 1, motif: [[0, 0, 2], [3, 0, 1], [4, 4, 4], [10, 3, 2], [12, 2, 4], [16, 0, 2], [19, 0, 1], [20, 5, 4], [26, 4, 4]] },
  yellow: { inst: 'marimba',oct: 2, motif: [[0, 2, 1], [2, 4, 1], [4, 7, 1], [6, 4, 1], [8, 2, 2], [12, 0, 2], [16, 3, 1], [18, 5, 1], [20, 7, 1], [22, 5, 1], [24, 4, 2], [28, 2, 2]] },
  green:  { inst: 'flute',  oct: 2, motif: [[0, 4, 4], [4, 5, 2], [6, 4, 2], [8, 2, 8], [16, 3, 4], [20, 4, 2], [22, 5, 2], [24, 7, 8]] },
  white:  { inst: 'glass',  oct: 2, motif: [[0, 7, 6], [8, 4, 6], [16, 5, 6], [24, 2, 8]] },
};

// ---- State fed by the game -----------------------------------------------------

const S = {
  intensity: 0.15,    // 0 calm … 1 frantic (smoothed)
  target: 0.15,
  dark: 0,            // 0 major … 1 minor + drone
  finalLap: false,
  leader: null,       // colour
  weights: {},        // colour → current motif loudness (smoothed toward targets)
  targets: {},
  duck: {},           // colour → steps left ducked (after being hit)
  colors: [],
};
const queue = [];     // cues waiting for their beat: { kind, color, extra }

// ---- Audio graph ---------------------------------------------------------------

function ensure() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.ratio.value = 4;
  master = ctx.createGain();
  master.gain.value = 0;
  bus = ctx.createGain();
  bus.gain.value = 0.9;
  // A gentle roll-off of the very top: warm, never shrill.
  tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 5500; tone.Q.value = 0.5;
  bus.connect(comp); comp.connect(tone); tone.connect(master); master.connect(ctx.destination);
  // A short feedback delay for space.
  const d = ctx.createDelay(1), fb = ctx.createGain(), wet = ctx.createGain();
  d.delayTime.value = song.delay[0]; fb.gain.value = song.delay[1]; wet.gain.value = 0.22;
  delayNode = d; delayFb = fb;
  bus.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(comp);
}

const midiHz = m => 440 * 2 ** ((m - 69) / 12);

function env(g, t, a, peak, dec, sus, rel, len) {
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * sus), t + a + dec);
  g.gain.setValueAtTime(Math.max(0.0001, peak * sus), t + Math.max(a + dec, len));
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + dec, len) + rel);
}

// One note on an instrument. vol 0–1.
function note(inst, midi, t, dur, vol) {
  if (vol < 0.01) return;
  // Nothing piercing: fold anything above C6 back down (pure high tones sound
  // like a hearing test), and the bright overtone instruments sit lower still.
  const cap = inst === 'glass' || inst === 'bell' ? 79 : 84;
  while (midi > cap) midi -= 12;
  const f = midiHz(midi);
  const g = ctx.createGain();
  const out = ctx.createGain(); out.gain.value = vol;
  g.connect(out); out.connect(bus);
  const stop = t + dur + 0.6;
  const osc = (type, freq, detune = 0) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = detune; o.start(t); o.stop(stop); return o; };
  const lp = (fq, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = fq; b.Q.value = q; return b; };
  switch (inst) {
    case 'epiano': { const a = osc('sine', f), b = osc('triangle', f * 2, 4); const m = ctx.createGain(); m.gain.value = 0.25; b.connect(m); a.connect(g); m.connect(g); env(g, t, 0.005, 0.32, 0.3, 0.35, 0.4, dur); break; }
    // pluck: a gentle sweep (a fast, resonant one sounded like a laser 'pew')
    case 'pluck': { const a = osc('sawtooth', f), fl = lp(f * 4, 0.7); fl.frequency.setValueAtTime(f * 4, t); fl.frequency.exponentialRampToValueAtTime(f * 2, t + 0.3); a.connect(fl); fl.connect(g); env(g, t, 0.003, 0.22, 0.12, 0.2, 0.15, dur * 0.6); break; }
    case 'brass': { const a = osc('sawtooth', f), b = osc('sawtooth', f, 8), fl = lp(f * 2, 1); fl.frequency.setValueAtTime(f * 1.2, t); fl.frequency.linearRampToValueAtTime(f * 4, t + 0.08); a.connect(fl); b.connect(fl); fl.connect(g); env(g, t, 0.04, 0.16, 0.15, 0.7, 0.18, dur); break; }
    case 'marimba': { const a = osc('sine', f), b = osc('sine', f * 4); const m = ctx.createGain(); m.gain.value = 0.06; b.connect(m); a.connect(g); m.connect(g); env(g, t, 0.002, 0.4, 0.25, 0.05, 0.1, 0.05); break; }
    case 'flute': { const a = osc('triangle', f), v = ctx.createOscillator(), vg = ctx.createGain(); v.frequency.value = 5; vg.gain.value = 6; v.connect(vg); vg.connect(a.detune); v.start(t); v.stop(stop); const fl = lp(f * 3); a.connect(fl); fl.connect(g); env(g, t, 0.08, 0.26, 0.2, 0.75, 0.25, dur); break; }
    case 'glass': { const a = osc('triangle', f), b = osc('sine', f * 2.01); const m = ctx.createGain(); m.gain.value = 0.12; b.connect(m); a.connect(g); m.connect(g); env(g, t, 0.15, 0.17, 0.4, 0.6, 0.8, dur); break; }
    case 'pad': { const a = osc('sawtooth', f, -7), b = osc('sawtooth', f, 7), fl = lp(900 + 1600 * S.intensity); a.connect(fl); b.connect(fl); fl.connect(g); env(g, t, 0.6, 0.07, 0.4, 0.85, 0.9, dur); break; }
    case 'bass': { const a = osc('triangle', f), b = osc('square', f / 2), m = ctx.createGain(); m.gain.value = 0.18; b.connect(m); const fl = lp(400); a.connect(fl); m.connect(fl); fl.connect(g); env(g, t, 0.01, 0.42, 0.15, 0.6, 0.1, dur); break; }
    case 'bell': { const a = osc('sine', f), b = osc('sine', f * 2.76); const m = ctx.createGain(); m.gain.value = 0.12; b.connect(m); const fl = lp(3500); a.connect(fl); m.connect(fl); fl.connect(g); env(g, t, 0.004, 0.28, 0.5, 0.12, 0.6, 0.1); break; }
    case 'drone': { const a = osc('sawtooth', f), b = osc('sine', f / 2), fl = lp(220); a.connect(fl); b.connect(fl); fl.connect(g); env(g, t, 0.8, 0.12, 0.5, 0.9, 1.2, dur); break; }
  }
}

function noise(t, dur, vol, hp = 5000) {
  const len = Math.ceil(ctx.sampleRate * dur), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource(); s.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
  const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(bus); s.start(t); s.stop(t + dur);
}
function kick(t, vol) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  o.connect(g); g.connect(bus); o.start(t); o.stop(t + 0.32);
}
const snare = (t, vol) => { noise(t, 0.16, vol, 1500); note('bell', 62, t, 0.05, vol * 0.15); };

// ---- Harmony helpers -----------------------------------------------------------

let keyShift = 0;            // semitones (final lap lifts it)
// Minor once the risk is clearly up, major again only once it's clearly down
// (so a value hovering in between doesn't flip the mood every bar).
let minor = false;
const mood = () => (minor = minor ? S.dark > 0.4 : S.dark > 0.55);
const scale = () => (minor ? song.dark : song.bright);
const prog = () => (minor ? song.darkProg : song.prog);
// MIDI note for a scale degree above a chord root (degrees wrap into octaves).
function degree(rootDeg, deg, oct = 0) {
  const sc = scale(), i = rootDeg + deg;
  return song.root + keyShift + 12 * (oct + Math.floor(i / 7)) + sc[((i % 7) + 7) % 7];
}

// ---- Scheduler ---------------------------------------------------------------

let step = 0, nextTime = 0;
const songBpm = x => x.bpm[0] + (x.bpm[1] - x.bpm[0]) * S.intensity;
// Between games the DJ blends: over 8 bars the tempo glides to the next song's
// and a filter sweeps down; the new song comes in on the middle bar line and
// the filter opens again.
let blend = null;           // { from, to, n: steps done }
const BLEND = 128;
const bpm = () => {
  if (!blend) return songBpm(song);
  const f = Math.min(1, blend.n / BLEND), e = f * f * (3 - 2 * f);
  return songBpm(blend.from) + (songBpm(blend.to) - songBpm(blend.from)) * e;
};
const stepDur = () => 60 / bpm() / 4;

function tick() {
  if (!ctx) return;
  while (nextTime < ctx.currentTime + 0.12) { playStep(step, nextTime); nextTime += stepDur(); step++; }
}

function playStep(n, t) {
  const s16 = n % 16, bar = Math.floor(n / 16), chordDeg = prog()[bar % 4];
  const I = S.intensity;
  // Smooth the mix once per 16th.
  S.intensity += (S.target - S.intensity) * 0.02;
  for (const c of S.colors) {
    const tgt = (S.targets[c] ?? 0) * (S.duck[c] > 0 ? 0.15 : 1);
    S.weights[c] = (S.weights[c] ?? 0) + (tgt - (S.weights[c] ?? 0)) * 0.03;
    if (S.duck[c] > 0) S.duck[c]--;
  }
  if (blend) {
    blend.n++;
    const f = blend.n / BLEND;
    if (tone) tone.frequency.setTargetAtTime(5500 * Math.max(0.12, Math.abs(1 - 2 * f)) ** 1.5 + 300, t, 0.1);
    if (song !== blend.to && f >= 0.5 && s16 === 0) setSong(blend.to);
    if (f >= 1) { blend = null; if (tone) tone.frequency.setTargetAtTime(5500, t, 0.3); }
  }
  // Key change for the final lap and the mood, on a bar line.
  if (s16 === 0) { keyShift = S.finalLap ? 2 : 0; mood(); }

  // Swing: the off-beat 8ths come a little late.
  if (s16 % 4 === 2) t += song.swing * stepDur() * 0.66;
  const sd = stepDur();
  // Chords, played the song's way.
  const chord = [0, 2, 4].map(d => degree(chordDeg, d, 1));
  if (song.pad === 'sustain' && s16 === 0) for (const m of chord) note('pad', m, t, sd * 16, 0.5);
  if (song.pad === 'swell' && s16 === 0 && bar % 2 === 0) for (const m of chord) note('pad', m, t, sd * 32, 0.55);
  if (song.pad === 'stabs' && [0, 6, 10].includes(s16) && I > 0.15) for (const m of chord) note(song.chip ? 'pluck' : 'epiano', m + 12, t, sd * 1.5, 0.28);
  if (song.pad === 'stabs' && s16 === 0) for (const m of chord) note('pad', m, t, sd * 16, 0.25);
  if (song.pad === 'skank' && s16 % 8 === 4) for (const m of chord) note('pluck', m + 12, t, sd, 0.35);
  if (song.pad === 'skank' && s16 === 0) for (const m of chord) note('pad', m, t, sd * 16, 0.2);
  if (song.pad === 'arp' && s16 % (I > 0.5 ? 1 : 2) === 0) note(song.chip ? 'pluck' : 'glass', chord[(s16 >> (I > 0.5 ? 0 : 1)) % 3] + 12 * ((s16 >> 2) % 2), t, sd * 1.2, 0.26);
  if (song.pad === 'arp' && s16 === 0) for (const m of chord) note('pad', m, t, sd * 16, 0.25);
  // Drone when it's dark.
  if (s16 === 0 && bar % 2 === 0 && S.dark > 0.3) note('drone', degree(0, 0, -1), t, sd * 32, 0.5 * S.dark);
  // Bass line.
  const tier = I < 0.3 ? 0 : I < 0.6 ? 1 : 2;
  const root = degree(chordDeg, 0, -1);
  const B = {
    roots:  [[0, 8], [0, 6, 8, 14], [0, 3, 6, 8, 11, 14]][tier].map(st => [st, st === 14 && tier === 2 ? 4 : 0]),
    pulse:  [[0], [0, 4, 8, 12], [0, 2, 4, 6, 8, 10, 12, 14]][tier].map(st => [st, 0]),
    octave: [[0, 8], [0, 4, 8, 12], [0, 2, 4, 6, 8, 10, 12, 14]][tier].map(st => [st, (st / 2) % 2 ? 7 : 0]),
    walk:   [[[0, 0], [8, 4]], [[0, 0], [4, 2], [8, 4], [12, 5]], [[0, 0], [4, 2], [8, 4], [12, 5], [14, 6]]][tier],
    funk:   [[[0, 0], [10, 0]], [[0, 0], [3, 0], [7, 7], [10, 0]], [[0, 0], [3, 0], [6, 7], [7, 7], [10, 0], [13, 4], [14, 5]]][tier],
    reggae: [[[0, 0]], [[0, 0], [6, 4], [10, 2]], [[0, 0], [3, 0], [6, 4], [10, 2], [14, 4]]][tier],
  }[song.bass] ?? [];
  for (const [st, deg] of B) if (st === s16) note('bass', deg === 7 ? root + 12 : degree(chordDeg, deg, -1), t, sd * (song.bass === 'walk' ? 3.5 : 2), 0.8);
  // Drums: the song's beat for this intensity.
  const gr = song.groove[tier];
  if (gr.k.includes(s16)) kick(t, 0.5);
  if (gr.s.includes(s16)) snare(t, 0.12 + 0.12 * I);
  if (gr.h && s16 % gr.h === 0) noise(t, 0.03, 0.02 + 0.04 * I * (s16 % 4 === 2 ? 1.6 : 1));
  if (gr.x === 'clap' && (s16 === 4 || s16 === 12)) noise(t, 0.09, 0.07, 1200);
  if (gr.x === 'rim' && s16 % 8 === 4) note('marimba', 79, t, sd, 0.15);
  if (gr.x === 'tom' && [6, 7, 14].includes(s16)) note('bass', degree(0, s16 === 14 ? 4 : 0, 0), t, sd, 0.35);

  // Motifs: the leader carries the tune; chasers answer, louder as they close in.
  const pos = n % 32;
  const ranked = [...S.colors].sort((a, b) => (S.weights[b] ?? 0) - (S.weights[a] ?? 0));
  ranked.forEach((c, rank) => {
    const w = S.weights[c] ?? 0, v = VOICES[c];
    if (!v || w < 0.03) return;
    // The leader plays its motif in full; others only in the second half
    // of every other two-bar phrase (call and response), lower in the mix.
    // Only the two closest chasers answer (with 5–6 players it would crowd).
    const answering = rank > 0;
    if (rank > 2 || (answering && !(bar % 4 >= 2 && pos >= 16))) return;
    for (const [st, deg, len] of v.motif) {
      if (st === pos) note(song.chip && v.inst !== 'glass' ? 'pluck' : v.inst, degree(chordDeg, deg + song.shift, v.oct), t, len * stepDur(), (answering ? 0.55 : 1) * w * 0.9);
    }
  });

  // Cues wait for the next 8th.
  if (s16 % 2 === 0) while (queue.length) playCue(queue.shift(), t, chordDeg);
}

function playCue({ kind, color, extra }, t, chordDeg) {
  const sd = stepDur();
  switch (kind) {
    case 'six': {
      const n = extra?.double ? 8 : 4;
      for (let i = 0; i < n; i++) note('pluck', degree(chordDeg, i * 2, 1), t + i * sd, sd * 1.5, 0.5);
      if (extra?.double) note('bell', degree(chordDeg, 7, 1), t + n * sd, sd * 4, 0.5);
      // The extra roll: a stuttered double beat (twice for 6-6).
      for (let i = 0; i < (extra?.double ? 4 : 2); i++) { kick(t + i * sd * 0.5, 0.4); snare(t + (i + 0.5) * sd * 0.5, 0.06); }
      break;
    }
    case 'one': note('bell', degree(chordDeg, 4, 1), t, sd * 4, 0.45); break;
    case 'out': {   // out of base: a two-note pickup in the team's voice
      const v = VOICES[color];
      note(v?.inst ?? 'pluck', degree(chordDeg, 0, v?.oct ?? 1), t, sd, 0.5);
      note(v?.inst ?? 'pluck', degree(chordDeg, 4, v?.oct ?? 1), t + sd, sd * 2, 0.6);
      break;
    }
    case 'star':    // onto the star circle: a quick shimmer up
      [0, 2, 4, 7].forEach((d, i) => note('glass', degree(chordDeg, d, 2), t + i * sd * 0.5, sd * 2, 0.3));
      break;
    case 'hubIn':   // into the hub: a swirl down, and the mix dips
      [7, 5, 4, 2, 0].forEach((d, i) => note('glass', degree(chordDeg, d, 2), t + i * sd * 0.5, sd * 1.5, 0.28));
      if (tone) { tone.frequency.setTargetAtTime(1400, t, 0.05); tone.frequency.setTargetAtTime(5500, t + sd * 6, 0.3); }
      break;
    case 'hubOut':  // out of the hub: a sweep up to a bell
      [0, 2, 4, 7].forEach((d, i) => note('pluck', degree(chordDeg, d, 1), t + i * sd * 0.5, sd, 0.35));
      note('bell', degree(chordDeg, 7, 1), t + sd * 2, sd * 4, 0.5);
      break;
    case 'tidy':    // a home slot climbed: one soft tick, a step up
      note('marimba', degree(chordDeg, 2 + (extra?.slot ?? 0), 2), t, sd, 0.35);
      break;
    case 'lead': {  // a new leader: crash, and its motif head steps forward
      noise(t, 1.0, 0.07, 3000); kick(t, 0.6);
      const v = VOICES[color];
      if (v) v.motif.slice(0, 4).forEach(([st, deg, len]) => note(v.inst, degree(chordDeg, deg + song.shift, v.oct), t + st * sd, len * sd, 0.75));
      break;
    }
    case 'lap':     // the final lap begins: a snare riser into the key lift
      for (let i = 0; i < 8; i++) snare(t + i * sd * 0.5, 0.04 + 0.025 * i);
      break;
    case 'hit': {
      // Both teams' voices: the hitter's motif head climbs (triumph), then the
      // victim's tune falls away, low and flattened. Near home it's heartbreak:
      // a minor chord and a longer fall.
      for (const d of [0, 1, 3]) note('brass', degree(chordDeg, d, 1) + (d === 1 ? 1 : 0), t, sd * 2, 0.3);
      const v = VOICES[color], w = VOICES[extra?.victim], sad = extra?.heartbreak;
      if (v) [0, 2, 4].forEach((d, i) => note(v.inst, degree(chordDeg, d, v.oct), t + (2 + i * 2) * sd, sd * 2, 0.7));
      if (w) {
        const fall = sad ? [7, 5, 4, 2, 1, 0] : [4, 2, 0];
        fall.forEach((d, i) => note(w.inst, degree(chordDeg, d, w.oct - 1) - (i === fall.length - 1 ? 1 : 0), t + (8 + i * 2) * sd, sd * (sad ? 3 : 2), sad ? 0.6 : 0.45));
      }
      if (sad) {
        for (const d of [0, 2, 4]) note('pad', degree(chordDeg + 5, d, 0) - (d === 2 ? 1 : 0), t + 8 * sd, sd * 16, 0.6);
        note('drone', degree(0, 0, -1), t + 8 * sd, sd * 16, 0.5);
      }
      break;
    }
    case 'stuck': { // no move with that roll: a deflating "wah-wah-wah-waaah" in the team's voice
      const v = VOICES[color], inst = v?.inst === 'marimba' || v?.inst === 'glass' ? 'brass' : v?.inst ?? 'brass';
      [[0, 2], [2, 1], [4, 0]].forEach(([st, d]) => note(inst, degree(chordDeg, d, (v?.oct ?? 1) - 1) , t + st * sd, sd * 1.6, 0.45));
      note(inst, degree(chordDeg, 0, (v?.oct ?? 1) - 1) - 1, t + 6 * sd, sd * 6, 0.5);
      break;
    }
    case 'double': { // the cube is turned: a timpani roll swelling into a brass chord, the doubler's tune on top
      for (let i = 0; i < 12; i++) kick(t + i * sd * 0.5, 0.15 + 0.05 * i);
      noise(t + 6 * sd, 1.6, 0.1, 2500);
      for (const d of [0, 2, 4, 7]) note('brass', degree(chordDeg, d, 0) - (d === 2 ? 1 : 0), t + 6 * sd, sd * 10, 0.5);
      note('drone', degree(chordDeg, 0, -1), t + 6 * sd, sd * 16, 0.7);
      const v = VOICES[color];
      if (v) v.motif.slice(0, 3).forEach(([st, deg, len], i) => note('brass', degree(chordDeg, deg + song.shift, v.oct), t + (8 + i * 2) * sd, len * sd, 0.6));
      S.target = Math.min(1, S.target + 0.15);
      break;
    }
    case 'take': { // taken: the answer, a bold major chord in the taker's voice
      const v = VOICES[color];
      kick(t, 0.7); noise(t, 0.8, 0.06, 3000);
      for (const d of [0, 2, 4]) note(v?.inst === 'marimba' || v?.inst === 'glass' ? 'brass' : v?.inst ?? 'brass', degree(0, d, (v?.oct ?? 1)), t, sd * 8, 0.55);
      note('bass', degree(0, 0, -1), t, sd * 8, 0.8);
      break;
    }
    case 'safe': {  // every team has a marble home: no aggros left, a relieved major cadence
      [[4, 6, 8], [0, 2, 4]].forEach((ch, k) => ch.forEach(d => note('pad', degree(0, d, 1), t + k * 8 * sd, sd * 10, 0.55)));
      note('bell', degree(0, 7, 1), t + 8 * sd, sd * 8, 0.4);
      break;
    }
    case 'home': {
      const v = VOICES[color];
      [0, 2, 4, 7].forEach((d, i) => note(v?.inst ?? 'bell', degree(chordDeg, d, (v?.oct ?? 2)), t + i * sd, sd * 2, 0.5));
      break;
    }
    case 'win': {
      // The winner's flourish, in the song's style: a snare roll into the
      // winner's motif up an octave over two bars of the song's chords (their
      // instrument, doubled by brass), then the home chord held out.
      const v = VOICES[color], inst = song.chip ? 'pluck' : v?.inst ?? 'brass';
      for (let i = 0; i < 8; i++) snare(t + i * sd, 0.08 + 0.03 * i);
      const t0 = t + 8 * sd, pr = prog();
      if (v) for (const [st, deg, len] of v.motif) {
        const ch = pr[Math.floor(st / 16) % 4];
        note(inst, degree(ch, deg + song.shift, v.oct + 1), t0 + st * sd, len * sd, 0.9);
        if (st % 4 === 0) note('brass', degree(ch, deg + song.shift, v.oct), t0 + st * sd, len * sd, 0.3);
      }
      for (let b = 0; b < 2; b++) {
        kick(t0 + b * 16 * sd, 0.6);
        for (const d of [0, 2, 4]) note('pad', degree(pr[b], d, 1), t0 + b * 16 * sd, 16 * sd, 0.45);
      }
      const tEnd = t0 + 32 * sd;
      kick(tEnd, 0.8); noise(tEnd, 1.2, 0.09, 3000);
      for (const d of [0, 2, 4, 7]) note(inst, degree(0, d, (v?.oct ?? 1)), tEnd, sd * 24, 0.55);
      for (const d of [0, 2, 4]) note('pad', degree(0, d, 1), tEnd, sd * 32, 0.8);
      note('bass', degree(0, 0, -1), tEnd, sd * 16, 0.9);
      break;
    }
  }
}

function startClock() {
  if (running) return;
  ensure();
  running = true;
  step = 0; nextTime = ctx.currentTime + 0.1;
  timer = setInterval(tick, 25);
}
function stopClock() {
  running = false;
  clearInterval(timer); timer = null;
}
function applyVolume() {
  if (!ctx) return;
  const on = enabled && !muted;
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setTargetAtTime(on ? 0.75 * volume : 0, ctx.currentTime, 0.4);
  if (on) startClock();
  else setTimeout(() => { if (!(enabled && !muted)) stopClock(); }, 1500);
}

// ---- Public API ---------------------------------------------------------------

export function setMusic(on) { enabled = !!on; if (enabled) ensure(); applyVolume(); }
export function setMusicMuted(m) { muted = !!m; applyVolume(); }
// Music volume, 0–1.
export function setMusicVolume(v) { volume = Math.max(0, Math.min(1, +v || 0)); applyVolume(); }
export function musicOn() { return enabled && !muted; }

// The position: players [{ color, pips, home, base }] (pips = the race still to go).
export function musicUpdate(players) {
  if (!players?.length) return;
  const START = 346;   // pips at the start of a game
  const sorted = [...players].sort((a, b) => a.pips - b.pips);
  const lead = sorted[0], second = sorted[1];
  const progress = Math.min(1, Math.max(0, (START - lead.pips) / (START - 20)));
  const close = second ? Math.max(0, 1 - (second.pips - lead.pips) / 60) : 0;
  S.target = Math.min(1, 0.12 + 0.6 * progress + 0.25 * close * progress);
  // The end of aggros: the last team without a marble home gets one.
  const noneHome = players.filter(p => p.home === 0).length;
  if (S.noneHome > 0 && noneHome === 0 && musicOn()) queue.push({ kind: 'safe' });
  S.noneHome = noneHome;
  const lap = lead.home >= 3 || lead.pips <= 40;
  if (lap && !S.finalLap && musicOn()) queue.push({ kind: 'lap' });
  S.finalLap = lap;
  // A new leader (by a clear margin, not a tie flicking back and forth).
  if (S.leader && lead.color !== S.leader && second && second.pips - lead.pips >= 3 && musicOn()) queue.push({ kind: 'lead', color: lead.color });
  else if (S.leader && lead.color !== S.leader && !(second && second.pips - lead.pips >= 3)) return finishUpdate(players, S.leader);
  // Aggro / baggro risk: someone with nothing home (or all in base) while the leader is well on the way.
  const risk = players.reduce((r, p) => Math.max(r, p === lead ? 0 : (p.base === 4 ? 1 : p.home === 0 ? 0.7 : 0) * progress), 0);
  S.dark = risk;
  finishUpdate(players, lead.color);
}
function finishUpdate(players, leader) {
  const lead = players.find(p => p.color === leader) ?? players[0];
  S.colors = players.map(p => p.color);
  S.leader = leader;
  for (const p of players) {
    const gap = p.pips - lead.pips;
    S.targets[p.color] = p === lead ? 1 : Math.max(0, 0.75 * Math.exp(-gap / 25));
  }
  for (const c of Object.keys(S.targets)) if (!S.colors.includes(c)) S.targets[c] = 0;
}

// Moments, played on the next beat.
export function musicRoll(dice, color) {
  if (!musicOn() || !dice) return;
  if (dice.includes(6)) queue.push({ kind: 'six', color, extra: { double: dice[0] === 6 && dice[1] === 6 } });
  else if (dice.includes(1)) queue.push({ kind: 'one', color });
}
// The cube: turned (drama), taken (a bold answer). A drop ends the game: the win flourish.
export function musicCube(kind, color) { if (musicOn()) queue.push({ kind, color }); }
// A roll with no move at all.
export function musicStuck(color) { if (musicOn()) queue.push({ kind: 'stuck', color }); }
export function musicHit(byColor, victimColor, heartbreak) {
  if (victimColor) S.duck[victimColor] = 32;
  if (musicOn()) queue.push({ kind: 'hit', color: byColor, extra: { victim: victimColor, heartbreak } });
}
export function musicDuck(color) { if (color) S.duck[color] = 32; }
export function musicHome(color) { if (musicOn()) queue.push({ kind: 'home', color }); }
// A marble's move: out of base, onto the star circle, into / out of the hub, a home slot climbed.
export function musicMove(color, from, to, isStar) {
  if (!musicOn() || !from || !to) return;
  const kind = from.zone === 'base' ? 'out' : to.zone === 'center' ? 'hubIn' : from.zone === 'center' ? 'hubOut'
    : from.zone === 'home' && to.zone === 'home' ? 'tidy' : to.zone === 'track' && isStar(to) && !isStar(from) ? 'star' : null;
  if (kind) queue.push({ kind, color, extra: { slot: to.slot } });
}
// nonStop: robot watch rooms, where the next game follows by itself; the DJ
// blends into its song. Otherwise the music fades away to nothing after the
// flourish (and comes back with the next game).
export function musicWin(color, nonStop = false) {
  if (!musicOn()) return;
  queue.length = 0;
  queue.push({ kind: 'win', color });
  S.target = 0.15;  // calm again for the next game
  clearTimeout(winBlendTimer);
  if (nonStop) winBlendTimer = setTimeout(() => { pickSong(); pickedNext = true; }, 6000);
  else winBlendTimer = setTimeout(() => { if (ctx && bus) { bus.gain.cancelScheduledValues(ctx.currentTime); bus.gain.setTargetAtTime(0, ctx.currentTime, 2.5); } }, 6000);
}
let winBlendTimer = null, pickedNext = false;
export function musicReset() {
  S.target = 0.15; S.dark = 0; S.finalLap = false; S.duck = {}; S.noneHome = 0;
  clearTimeout(winBlendTimer);
  if (ctx && bus) { bus.gain.cancelScheduledValues(ctx.currentTime); bus.gain.setTargetAtTime(0.9, ctx.currentTime, 0.5); }   // back after a fade-out
  if (!pickedNext) pickSong();   // already blending into it after the last win
  pickedNext = false;
}
// A new song for the new game (any but the last one). The next bar starts it.
export function pickSong(i) {
  const cur = blend?.to ?? song;
  const others = SONGS.filter(x => x !== cur);
  const next = SONGS[i] ?? others[Math.floor(Math.random() * others.length)];
  // Playing: blend into it; otherwise just switch.
  if (running && musicOn() && i == null) blend = { from: song, to: next, n: 0 };
  else { blend = null; setSong(next); }
}
function setSong(next) {
  song = next; minor = false;
  if (ctx && delayNode) {
    delayNode.delayTime.setTargetAtTime(song.delay[0], ctx.currentTime, 0.2);
    delayFb.gain.setTargetAtTime(song.delay[1], ctx.currentTime, 0.2);
  }
}
export const songName = () => (blend?.to ?? song).name;

// Browsers start audio only after a click or key press; resume then.
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { if (ctx?.state === 'suspended') ctx.resume(); });
// For checking from the console: what the music is doing.
window.__music = () => ({ song: song.name, state: ctx?.state, time: ctx?.currentTime, step, bpm: Math.round(bpm()), intensity: +S.intensity.toFixed(2), dark: S.dark, finalLap: S.finalLap, leader: S.leader,
  weights: Object.fromEntries(Object.entries(S.weights).map(([k, v]) => [k, +v.toFixed(2)])) });
// Record what the music plays for ms milliseconds (a sample to listen to): resolves to a data URL.
window.__musicRecord = ms => new Promise(res => {
  if (!ctx) return res(null);
  const dest = ctx.createMediaStreamDestination();
  master.connect(dest);
  const rec = new MediaRecorder(dest.stream), parts = [];
  rec.ondataavailable = e => parts.push(e.data);
  rec.onstop = () => { master.disconnect(dest); const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(new Blob(parts, { type: rec.mimeType })); };
  rec.start(); setTimeout(() => rec.stop(), ms);
});
// Console helpers for trying the songs: __musicSong(0–9), __musicSet({ target: 0.6 }).
window.__musicSong = i => { pickSong(i); return song.name; };
window.__musicSet = o => Object.assign(S, o);
