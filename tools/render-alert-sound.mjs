#!/usr/bin/env node
/* ============================================================================
 * render-alert-sound.mjs — render the SHIPPED cash-register alert to a WAV
 * through a real Web Audio implementation and measure what actually comes out.
 *
 * The site's alert is synthesized (no audio file), so the only way to check the
 * sound for real is to run its graph through an audio engine and analyse the
 * PCM. This tool loads assets/js/reviews-feed.js in a VM exactly like
 * tools/reviews-feed-test.mjs does, drives the real public path
 * (ReplayFeed.setSoundEnabled(true) -> playAlertSound() ->
 * buildCashRegisterChime()), renders it offline with `web-audio-engine`
 * (a complete Web Audio implementation in JS), writes a listenable WAV and
 * then measures the result.
 *
 * Run: node tools/render-alert-sound.mjs [outfile.wav]
 *
 * `web-audio-engine` is an OPTIONAL dependency that is deliberately not part of
 * the site or of the CI smoke suite (the site ships with no build step and no
 * runtime dependencies). When it is not installed this tool says so and exits
 * 0, so it can never break CI:
 *
 *   npm install --no-save web-audio-engine
 *   node tools/render-alert-sound.mjs
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const OUT = process.argv[2] || 'alert-sound.wav';
const SR = 48000;
const RENDER_SECONDS = 2.4;

/* ------------------------------------------------- optional audio engine */
let OfflineAudioContext = null;
try {
  const require = createRequire(import.meta.url);
  ({ OfflineAudioContext } = require('web-audio-engine'));
} catch (_) {
  try {
    ({ OfflineAudioContext } = await import('web-audio-engine'));
  } catch (_) {
    console.log('web-audio-engine is not installed — skipping the render check.');
    console.log('Run:  npm install --no-save web-audio-engine  &&  node tools/render-alert-sound.mjs');
    process.exit(0);
  }
}

/* --------------------------------------------- load the shipped module */
/* Deterministic noise. The alert builds its mechanical layers from
 * Math.random(), and an unseeded render makes every run measure slightly
 * differently — and makes the seeded A/B renders below compare different noise
 * rather than the same noise with one layer removed. So hand the module a
 * seeded PRNG, reset once per graph build. */
function mulberry32(seed) {
  return function random() {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const NOISE_SEED = 0x5EED1234;

function loadShippedModule(offlineContext) {
  const source = readFileSync(new URL('../assets/js/reviews-feed.js', import.meta.url), 'utf8');
  class FakeAudioContext { constructor() { return offlineContext; } }
  // A copy, so overriding random() does not leak into the host's Math.
  const seededMath = Object.create(Math);
  seededMath.random = mulberry32(NOISE_SEED);
  const context = {
    console: { warn() {}, error() {}, log() {} },
    Map, Set, Date, Number, String, Object, Array, URLSearchParams,
    Math: seededMath,
    CSS: { escape: (s) => s },
    UI: { el: () => ({}), clear: () => ({}) },
    MLB: {},
    window: { AudioContext: FakeAudioContext },
    document: { addEventListener() {}, querySelector: () => null },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    module: { exports: {} },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'assets/js/reviews-feed.js' });
  return context;
}

function newContext() {
  return new OfflineAudioContext(1, Math.ceil(SR * RENDER_SECONDS), SR);
}

/* --------------------------------------------------------- WAV writer */
function toWav(samples, sampleRate) {
  const bytes = samples.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  const out = Buffer.alloc(44 + bytes);
  header.copy(out, 0);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return out;
}

/* --------------------------------------------------------- DSP helpers */
const db = (v) => (v > 0 ? 20 * Math.log10(v) : -140);

function rms(samples, fromSec, toSec) {
  const i0 = Math.max(0, Math.floor(fromSec * SR));
  const i1 = Math.min(samples.length, Math.floor(toSec * SR));
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, i1 - i0));
}

function peak(samples, fromSec, toSec) {
  const i0 = Math.max(0, Math.floor(fromSec * SR));
  const i1 = Math.min(samples.length, Math.floor(toSec * SR));
  let p = 0;
  for (let i = i0; i < i1; i++) p = Math.max(p, Math.abs(samples[i]));
  return p;
}

/** Goertzel: energy at one frequency over a window (cheap partial detector). */
function toneLevel(samples, fromSec, seconds, frequency) {
  const n = Math.floor(seconds * SR);
  const i0 = Math.floor(fromSec * SR);
  const w = (2 * Math.PI * frequency) / SR;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i0 + i] || 0;
    const s0 = v + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (n / 2);
}

/** 10 ms RMS envelope in dB. */
function envelope(samples, frameSec = 0.01) {
  const hop = Math.floor(frameSec * SR);
  const out = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let sum = 0;
    for (let k = i; k < i + hop; k++) sum += samples[k] * samples[k];
    out.push({ t: (i + hop / 2) / SR, db: db(Math.sqrt(sum / hop)) });
  }
  return out;
}

/* ------------------------------------------------------------- checks */
const checks = [];
function check(ok, label, detail) {
  checks.push({ ok, label, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `   [${detail}]` : ''}`);
}

/* --------------------------------------------------------------- main */
console.log('Rendering the shipped alert sound (assets/js/reviews-feed.js) …');

const offline = newContext();
const shipped = loadShippedModule(offline);
const ReplayFeed = shipped.window.ReplayFeed;
assert.ok(ReplayFeed, 'window.ReplayFeed is exported');
const SPEC = ReplayFeed.alertSoundSpec;
assert.ok(SPEC, 'ALERT_SOUND design data is exported');

// Exactly the code path a user gesture runs: enabling the toggle plays one alert.
ReplayFeed.setSoundEnabled(true);
const rendered = await offline.startRendering();
const samples = rendered.getChannelData(0);

mkdirSync(new URL('.', import.meta.url).pathname ? '.' : '.', { recursive: true });
writeFileSync(OUT, toWav(samples, SR));
console.log(`Wrote ${OUT} (${(samples.length / SR).toFixed(2)}s @ ${SR}Hz) — play it to hear the alert.\n`);

/* ---------------------------------------------------------------------------
 * What the checks below compare against
 *
 * These are not matters of taste. They are the numbers measured off real
 * cash-register recordings; docs/alert-sound.md names the files and lists
 * every figure in full.
 *
 *   reference                             prime    prime tau   20 dB fall
 *   C  stripe-play-ka-ching-sound (MIT)   2100 Hz  0.196 s     0.24 s
 *   D  freesound 721774 cash-register     2097 Hz  0.168 s     0.44 s
 *   A  antique register recording          ~6 kHz  0.144 s     0.06 s
 *
 * Two more figures come from the same files, and they are the two the build
 * this replaced got wrong:
 *
 *   - how much louder the bell ("ching") is than the mechanism ("cha"):
 *       +0.4 dB (C), -3.1 dB (A)  -> the mechanism is NOT a quiet prelude.
 *       The replaced build was +14.2 dB, so its "cha" was inaudible.
 *   - how flat the "cha" is across low / mid / high bands (a mechanical
 *     clatter is broadband; a few thin ticks are not):
 *       1.2 dB (C), 6.5 dB (D), 4.8 dB (A)
 *       The replaced build was 23.7 dB — all click, no body.
 * ------------------------------------------------------------------------ */

const REF_PRIME_MIN = 2000, REF_PRIME_MAX = 2200;   // measured 2097-2100 Hz
const REF_TAU_MIN = 0.13, REF_TAU_MAX = 0.28;       // measured 0.168-0.196 s
const REF_BALANCE_MIN = -5, REF_BALANCE_MAX = 7;    // measured +0.4 / -3.1 dB
const REF_CHA_SPREAD_MAX = 10;                      // measured 1.2 / 6.5 / 4.8 dB
const REF_CHA_CREST_MAX = 18;                       // measured 9.5 / 15.4 / 12.8 dB
const REF_BELL_CREST_MIN = 16;                      // measured 42.9 / 17.8 / 31.9 dB

const STRIKE_AT = SPEC.bellStrikes[0].at;

/**
 * Mean Goertzel level across a frequency band — a band-energy estimate.
 * NOTE: toneLevel() takes (from, DURATION), not (from, to); these helpers take
 * (from, to) and convert, so callers never have to remember which is which.
 */
function bandLevel (from, to, lo, hi, step) {
  let sum = 0, n = 0;
  for (let f = lo; f <= hi; f += step) { sum += toneLevel(samples, from, to - from, f) ** 2; n++; }
  return Math.sqrt(sum / Math.max(1, n));
}

/** Peak-to-mean ratio across 300 Hz-12 kHz: low for noise, high for a tone. */
function spectralCrest (from, to) {
  const values = [];
  for (let f = 300; f <= 12000; f += 50) values.push(toneLevel(samples, from, to - from, f));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return db(Math.max(...values) / mean);
}

/** Re-render the same graph with one layer changed, for an A/B comparison. */
async function renderWith (mutate) {
  const off = newContext();
  const mod = loadShippedModule(off);
  const variant = JSON.parse(JSON.stringify(SPEC));
  mutate(variant);
  mod.module.exports.buildCashRegisterChime(off, off.destination, 0, variant);
  return (await off.startRendering()).getChannelData(0);
}

/* 1. duration and level ---------------------------------------------------- */
let lastAudible = 0;
for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > 3e-4) lastAudible = i;
const totalPeak = peak(samples, 0, samples.length);

console.log('1) the alert as a whole');
check(lastAudible / SR >= 1.0 && lastAudible / SR <= 2.1, 'lasts 1-2 seconds as requested',
  `audible to ${(lastAudible / SR).toFixed(3)} s`);
check(totalPeak < 0.99, 'does not clip', `peak ${(db(totalPeak)).toFixed(1)} dBFS`);
check(totalPeak > 0.15 && totalPeak < 0.71, 'sits at a sensible alert level',
  `peak ${(db(totalPeak)).toFixed(1)} dBFS`);

/* 2. the "cha": the mechanism, as loud as the bell -------------------------- */
console.log('\n2) the "cha" mechanism (the layer the old build buried)');
const chaRms = rms(samples, 0, STRIKE_AT);
const bellRms = rms(samples, STRIKE_AT, STRIKE_AT + 0.25);
const balance = db(bellRms) - db(chaRms);
check(db(chaRms) > -35, 'the mechanism is loud enough to be a real syllable',
  `${db(chaRms).toFixed(1)} dB RMS over 0-${STRIKE_AT} s`);
check(balance >= REF_BALANCE_MIN && balance <= REF_BALANCE_MAX,
  'the mechanism sits level with the bell, as it does in real recordings',
  `bell is ${balance >= 0 ? '+' : ''}${balance.toFixed(1)} dB vs the mechanism`);

// A mechanical clatter is broadband. Measure the low / mid / high bands of the
// "cha" and require them within REF_CHA_SPREAD_MAX of each other — the old
// build's "cha" was 23.7 dB apart (thin ticks, no body).
const chaBands = {
  low: bandLevel(0.01, STRIKE_AT - 0.01, 150, 400, 25),
  mid: bandLevel(0.01, STRIKE_AT - 0.01, 700, 1600, 60),
  high: bandLevel(0.01, STRIKE_AT - 0.01, 2500, 6000, 200),
};
const chaSpread = Math.max(...Object.values(chaBands).map(db)) - Math.min(...Object.values(chaBands).map(db));
Object.entries(chaBands).forEach(([name, level]) => {
  check(db(level) > -70, `the "cha" has audible ${name}-frequency content`, `${db(level).toFixed(1)} dB`);
});
check(chaSpread <= REF_CHA_SPREAD_MAX, 'the "cha" is broadband across low/mid/high, like a real mechanism',
  `${chaSpread.toFixed(1)} dB spread (references: 1.2-6.5)`);
const chaCrest = spectralCrest(0.01, STRIKE_AT - 0.01);
check(chaCrest <= REF_CHA_CREST_MAX, 'the "cha" is noise-like, not a tone', `crest ${chaCrest.toFixed(1)} dB`);
check(db(rms(samples, 0.12, 0.20)) > -40, 'the mechanism is still running when the bell is struck',
  `${db(rms(samples, 0.12, 0.20)).toFixed(1)} dB RMS`);

/* 3. the "ching": the bell, measured --------------------------------------- */
console.log('\n3) the register bell');
const prime = toneLevel(samples, STRIKE_AT + 0.02, 0.10, SPEC.bellFundamental);
check(prime > 0, `bell prime at ${SPEC.bellFundamental} Hz`, `${db(prime).toFixed(1)} dB`);
check(SPEC.bellFundamental >= REF_PRIME_MIN && SPEC.bellFundamental <= REF_PRIME_MAX,
  'the prime is in the measured register-bell band', `${SPEC.bellFundamental} Hz`);
SPEC.bellPartials.forEach((partial) => {
  const f = SPEC.bellFundamental * partial.ratio;
  if (f > SR / 2 - 200) return;
  const level = toneLevel(samples, STRIKE_AT + 0.02, 0.10, f);
  check(level > prime * 0.02, `partial ${partial.ratio}x (${f.toFixed(0)} Hz) rings`,
    `${db(level / prime).toFixed(1)} dB below the prime`);
});
const upperRatios = SPEC.bellPartials.map((p) => p.ratio).filter((r) => r > 1);
check(upperRatios.every((r) => Math.abs(r - Math.round(r)) > 1e-6),
  'no upper partial is an exact harmonic (a metal bell is not a harmonic series)');
const bellCrest = spectralCrest(STRIKE_AT + 0.02, STRIKE_AT + 0.27);
check(bellCrest >= REF_BELL_CREST_MIN,
  'the bell is dominated by its prime — a struck tone, not a clatter',
  `crest ${bellCrest.toFixed(1)} dB`);

// The decay is measured on a bell-only render so the drawer and the mechanism
// cannot skew it. This is the figure that turned the old chime into a
// cha-ching: the old bell's time constant was 0.85 s (a sustained tone); real
// register bells measure 0.168 s and 0.196 s.
const bellOnly = await renderWith((v) => {
  v.keyClack = { ...v.keyClack, level: 1e-5 };
  v.gearClicks = v.gearClicks.map((c) => ({ ...c, level: 1e-5 }));
  v.ratchet = { ...v.ratchet, level: 1e-5 };
  v.leverBody = { ...v.leverBody, level: 1e-5 };
  v.drawerSlide = { ...v.drawerSlide, level: 1e-5 };
  v.drawerStop = { ...v.drawerStop, level: 1e-5, clickLevel: 1e-5 };
});
function bellTone (t0, t1) {
  const n = Math.floor((t1 - t0) * SR);
  const i0 = Math.floor(t0 * SR);
  const w = (2 * Math.PI * SPEC.bellFundamental) / SR;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const v = bellOnly[i0 + i] || 0;
    const s0 = v + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (n / 2);
}
const early = bellTone(STRIKE_AT + 0.06, STRIKE_AT + 0.12);
const late = bellTone(STRIKE_AT + 0.46, STRIKE_AT + 0.52);
const decayRate = (db(late) - db(early)) / 0.40;
const tau = -1 / (decayRate / 8.686);
check(decayRate < -28 && decayRate > -70, 'the prime rings down like a struck bell, not a sustained tone',
  `${decayRate.toFixed(1)} dB/s`);
check(tau >= REF_TAU_MIN && tau <= REF_TAU_MAX,
  'the prime time constant matches the measured 0.17-0.20 s', `tau ${tau.toFixed(3)} s`);

// How long until the prime is 20 dB down: measured 0.24 s (C) and 0.44 s (D).
const bellAttackLevel = bellTone(STRIKE_AT + 0.01, STRIKE_AT + 0.02);
let t20 = null;
for (let t = STRIKE_AT; t + 0.01 < 1.4; t += 0.005) {
  if (db(bellTone(t, t + 0.01)) < db(bellAttackLevel) - 20) { t20 = t - STRIKE_AT; break; }
}
check(t20 !== null && t20 > 0.08 && t20 < 0.60, 'the prime is 20 dB down within 0.6 s of the strike',
  t20 === null ? 'never' : `${t20.toFixed(3)} s after the strike`);

// Metal: the bright upper partials die faster than the prime.
const brightPair = SPEC.bellPartials.filter((p) => p.ratio > 2 && p.ratio < 2.8)
  .sort((a, b) => b.gain - a.gain)[0];
const brightEarly = toneLevel(samples, STRIKE_AT + 0.02, 0.06, SPEC.bellFundamental * brightPair.ratio);
const brightLate = toneLevel(samples, STRIKE_AT + 0.34, 0.06, SPEC.bellFundamental * brightPair.ratio);
const primeEarly2 = toneLevel(samples, STRIKE_AT + 0.02, 0.06, SPEC.bellFundamental);
const primeLate2 = toneLevel(samples, STRIKE_AT + 0.34, 0.06, SPEC.bellFundamental);
check(db(brightLate) - db(brightEarly) < db(primeLate2) - db(primeEarly2),
  `the bright ${brightPair.ratio}x partial dies faster than the prime`,
  `${(db(brightLate) - db(brightEarly)).toFixed(1)} dB vs ${(db(primeLate2) - db(primeEarly2)).toFixed(1)} dB`);

/* 4. one strike, with its hammer tick (A/B against the same graph) ---------- */
console.log('\n4) the bell is struck ONCE, with a hammer tick (seeded A/B renders)');
const noBell = await renderWith((v) => { v.bellStrikes = []; });
const withBellAt = rms(samples, STRIKE_AT + 0.02, STRIKE_AT + 0.30);
const noBellAt = rms(noBell, STRIKE_AT + 0.02, STRIKE_AT + 0.30);
check(db(withBellAt) - db(noBellAt) >= 3,
  'the bell layer is clearly audible over the mechanism',
  `+${(db(withBellAt) - db(noBellAt)).toFixed(1)} dB vs the same graph without the bell`);

const noTick = await renderWith((v) => { v.hammerTick = { ...v.hammerTick, level: 1e-5 }; });
// Measured in the sliver between the tick starting and the bell's tone
// blooming, so the comparison isolates the tick itself.
const tickFrom = STRIKE_AT - SPEC.hammerTick.lead - 0.0005;
const tickTo = STRIKE_AT - 0.0005;
const tickGain = db(rms(samples, tickFrom, tickTo)) - db(rms(noTick, tickFrom, tickTo));
check(tickGain >= 1.5, 'the hammer tick lands just before the tone (the attack of the "ching")',
  `+${tickGain.toFixed(1)} dB`);

// One attack only: after the strike the prime must never re-excite.
let biggestRise = 0;
for (let t = STRIKE_AT + 0.10; t + 0.01 < STRIKE_AT + 0.80; t += 0.01) {
  const now = bellTone(t, t + 0.01);
  const before = bellTone(t - 0.03, t - 0.02);
  biggestRise = Math.max(biggestRise, db(now / Math.max(before, 1e-12)));
}
check(biggestRise < 2.0, 'there is no second bell strike (the prime never re-attacks)',
  `largest rise after the strike: +${biggestRise.toFixed(1)} dB`);
const attacks = [];
envelope(samples, 0.002).forEach((frame, index, all) => {
  if (index < 4) return;
  const rise = frame.db - all[index - 4].db;
  if (frame.t > STRIKE_AT - 0.02 && frame.t < STRIKE_AT + 0.06 && rise > 3 && frame.db > -40) {
    attacks.push(+frame.t.toFixed(3));
  }
});
check(attacks.length >= 1, 'a sharp bell attack is detectable at the strike',
  `at ${attacks.slice(0, 3).join(', ')} s`);

/* 5. the ring -------------------------------------------------------------- */
console.log('\n5) the ring');
const env = envelope(samples, 0.025).filter((f) => f.t >= STRIKE_AT + 0.25 && f.t <= 1.35);
const meanT = env.reduce((a, f) => a + f.t, 0) / env.length;
const meanV = env.reduce((a, f) => a + f.db, 0) / env.length;
let num = 0, den = 0;
env.forEach((f) => { num += (f.t - meanT) * (f.db - meanV); den += (f.t - meanT) ** 2; });
const slope = num / den;
const residual = Math.sqrt(env.reduce((a, f) => a + (f.db - (meanV + slope * (f.t - meanT))) ** 2, 0) / env.length);
check(slope < -3, 'the ring keeps decaying (no flat tone)', `${slope.toFixed(1)} dB/s`);
check(residual < 2.2, 'the ring decays smoothly, without a slow warble', `residual ${residual.toFixed(2)} dB`);
// Look for holes only where the alert is meant to be sounding, not in the tail.
const quietRuns = envelope(samples, 0.01).filter((f) => f.t > 0.1 && f.t < 1.35 && f.db < -60).length;
check(quietRuns < 12, 'no silent hole inside the alert', `${(quietRuns * 10)} ms below -60 dB`);

/* -------------------------------------------------------------- report */
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  failed.forEach((c) => console.log(`FAILED: ${c.label}`));
  process.exit(1);
}
console.log('The shipped alert sound renders and measures like a real cash-register cha-ching.');
