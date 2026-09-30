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
 * These are not matters of taste. They are numbers measured off two real
 * cash-register "cha-ching" recordings, decoded to PCM and analysed;
 * docs/alert-sound.md names them and lists every figure in full.
 *
 *   R1  npm "stripe-play-ka-ching-sound" (MIT), clip 4kVTqUxJYBA.mp3
 *       1.081 s @ 48 kHz — the canonical ka-ching
 *   R2  a second "kaching" cash-register sound effect, 0.575 s @ 44.1 kHz
 *
 * THE "cha" (the mechanism), measured on the window before the bell strikes:
 *
 *   figure                        R1        R2      replaced build
 *   spectral centroid            6219 Hz  6033 Hz      3270 Hz   <- too dark
 *   low/mid/high band spread      1.0 dB   2.7 dB       4.2 dB
 *   crest (peak / rms)           12.9 dB  15.9 dB      15.6 dB
 *   attacks (4 ms rise >= 6 dB)       3       10            2
 *   bell vs mechanism (rms)      -0.1 dB  -4.3 dB      -0.7 dB
 *
 * The replaced build's centroid (3270 Hz against ~6100 Hz) is the number that
 * explains why it did not read as a cash register: its "cha" was a dark,
 * narrow, level band of noise — a hiss with a low rumble under it — where a
 * real one is bright, broadband, and full of separate little events.
 *
 * THE "ching" (the bell):
 *
 *   R1 rings at 2098 Hz, a peak standing 24 dB above everything around it in
 *      the 0.23-0.30 s window, and its prime decays at -39.7 dB/s
 *      (time constant 0.219 s) — a struck bell, not a sustained tone.
 *   R2's bell rings at 1523 / 4463 / 5502 Hz, i.e. mode ratios 1 : 2.93 : 3.61,
 *      with further modes at 4.69x and 5.24x. None of those is a harmonic.
 *
 * The design keeps R1's prime (2093 Hz) and puts R2's mode ratios on top of
 * it, which is where the inharmonic partials below come from.
 * ------------------------------------------------------------------------ */

const REF_PRIME_MIN = 2000, REF_PRIME_MAX = 2200;      // measured 2098 Hz (R1)
const REF_TAU_MIN = 0.20, REF_TAU_MAX = 0.36;          // measured 0.219 s (R1)
const REF_BALANCE_MIN = -5, REF_BALANCE_MAX = 1;       // measured -0.1 / -4.3 dB
const REF_CHA_CENTROID_MIN = 4500, REF_CHA_CENTROID_MAX = 7500;  // 6033 / 6219 Hz
const REF_CHA_SPREAD_MAX = 3.5;                        // measured 1.0 / 2.7 dB
const REF_CHA_CREST_MIN = 10, REF_CHA_CREST_MAX = 18;  // measured 12.9 / 15.9 dB
const REF_CHA_ATTACKS_MIN = 3;                         // measured 3 / 10
const REF_BELL_CREST_MIN = 12;                         // a struck bell is a tone

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

/* An averaged magnitude spectrum over a window: one FFT per 1024 samples,
 * Hann-windowed, magnitudes averaged. Used for the centroid and the band
 * energies of the "cha", which have to be measured over the whole syllable
 * rather than at one instant. */
function averageSpectrum (from, to, N = 2048) {
  const i0 = Math.max(0, Math.floor(from * SR));
  const i1 = Math.min(samples.length - N, Math.floor(to * SR));
  const hop = N / 2;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const acc = new Float64Array(N / 2);
  let frames = 0;
  for (let start = i0; start + N < i1; start += hop) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = samples[start + i] * win[i];
    // In-place radix-2 FFT (this tool has no FFT dependency, by design).
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      for (let i = 0; i < N; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const a = ang * k, wr = Math.cos(a), wi = Math.sin(a);
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
          const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        }
      }
    }
    for (let i = 0; i < N / 2; i++) acc[i] += Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    frames++;
  }
  for (let i = 0; i < N / 2; i++) acc[i] /= Math.max(1, frames);
  return { acc, N, frames };
}

/** Energy-weighted mean frequency — how bright a sound is. */
function spectralCentroid (spec) {
  const { acc, N } = spec;
  let num = 0, den = 0;
  for (let i = 1; i < N / 2; i++) { const m = acc[i] * acc[i]; num += m * ((i * SR) / N); den += m; }
  return num / den;
}

/** Mean magnitude across a frequency band of an averaged spectrum, in dB. */
function spectrumBand (spec, lo, hi) {
  const { acc, N } = spec;
  const bin = SR / N;
  let sum = 0, n = 0;
  for (let i = Math.max(1, Math.floor(lo / bin)); i <= Math.min(N / 2 - 1, Math.ceil(hi / bin)); i++) {
    sum += acc[i] * acc[i]; n++;
  }
  return db(Math.sqrt(sum / Math.max(1, n)));
}

/** How many separate attacks the ear gets: 4 ms rises of >= 6 dB. */
function countAttacks (from, to) {
  const env = envelope(samples, 0.002).filter((f) => f.t >= from && f.t <= to);
  let attacks = 0;
  for (let i = 2; i < env.length; i++) if (env[i].db - env[i - 2].db >= 6) attacks++;
  return attacks;
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

/* 2. the "cha": a bright, broadband, percussive mechanism ------------------ */
console.log('\n2) the "cha" mechanism (the layer the replaced build got wrong)');
const chaRms = rms(samples, 0, STRIKE_AT);
const bellRms = rms(samples, STRIKE_AT, STRIKE_AT + 0.25);
const balance = db(bellRms) - db(chaRms);
check(db(chaRms) > -32, 'the mechanism is loud enough to be a real syllable',
  `${db(chaRms).toFixed(1)} dB RMS over 0-${STRIKE_AT} s`);
check(balance >= REF_BALANCE_MIN && balance <= REF_BALANCE_MAX,
  'the mechanism is at least as loud as the bell, as it is in both references',
  `bell is ${balance >= 0 ? '+' : ''}${balance.toFixed(1)} dB vs the mechanism`);

const chaSpectrum = averageSpectrum(0, STRIKE_AT);
const chaCentroid = spectralCentroid(chaSpectrum);
check(chaCentroid >= REF_CHA_CENTROID_MIN && chaCentroid <= REF_CHA_CENTROID_MAX,
  'the "cha" is as bright as a real one (centroid 6033 / 6219 Hz in the references)',
  `centroid ${chaCentroid.toFixed(0)} Hz`);

const chaBands = {
  low: spectrumBand(chaSpectrum, 150, 400),
  mid: spectrumBand(chaSpectrum, 700, 1600),
  high: spectrumBand(chaSpectrum, 2500, 6000),
};
const chaSpread = Math.max(...Object.values(chaBands)) - Math.min(...Object.values(chaBands));
Object.entries(chaBands).forEach(([name, level]) => {
  check(level > -70, `the "cha" has audible ${name}-frequency content`, `${level.toFixed(1)} dB`);
});
check(chaSpread <= REF_CHA_SPREAD_MAX, 'the "cha" is broadband across low/mid/high, like a real mechanism',
  `${chaSpread.toFixed(1)} dB spread (references: 1.0 and 2.7)`);

const chaPeak = peak(samples, 0, STRIKE_AT);
const chaCrest = db(chaPeak) - db(chaRms);
check(chaCrest >= REF_CHA_CREST_MIN && chaCrest <= REF_CHA_CREST_MAX,
  'the "cha" is peaky like a mechanism, neither a flat tone nor isolated spikes',
  `crest ${chaCrest.toFixed(1)} dB (references: 12.9 and 15.9)`);
const chaAttacks = countAttacks(0, STRIKE_AT);
check(chaAttacks >= REF_CHA_ATTACKS_MIN,
  'the "cha" breaks into separate attacks, not one smooth band of noise',
  `${chaAttacks} attacks (references: 3 and 10; the replaced build managed 2)`);
const chaToneCrest = spectralCrest(0.01, STRIKE_AT - 0.01);
check(chaToneCrest <= 20, 'the "cha" is noise-like, not a tone', `crest ${chaToneCrest.toFixed(1)} dB`);
check(db(rms(samples, STRIKE_AT - 0.05, STRIKE_AT)) > -40,
  'the mechanism is still running when the bell is struck',
  `${db(rms(samples, STRIKE_AT - 0.05, STRIKE_AT)).toFixed(1)} dB RMS`);

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
// cannot skew it. This is the figure that separates a "ching" from a chime.
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
check(decayRate < -20 && decayRate > -60, 'the prime rings down like a struck bell, not a sustained tone',
  `${decayRate.toFixed(1)} dB/s`);
check(tau >= REF_TAU_MIN && tau <= REF_TAU_MAX,
  'the prime time constant matches the measured 0.22 s of a real register bell',
  `tau ${tau.toFixed(3)} s`);

// How long until the prime is 20 dB down: R1 needs about 1.0 s to get there,
// which is exactly why the alert is audible for the 1-2 s that was asked for.
const bellAttackLevel = bellTone(STRIKE_AT + 0.01, STRIKE_AT + 0.02);
let t20 = null;
for (let t = STRIKE_AT; t + 0.01 < 1.6; t += 0.005) {
  if (db(bellTone(t, t + 0.01)) < db(bellAttackLevel) - 20) { t20 = t - STRIKE_AT; break; }
}
check(t20 !== null && t20 > 0.08 && t20 < 1.10, 'the prime is 20 dB down within about a second of the strike',
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
check(residual < 2.5, 'the ring decays smoothly, without a slow warble', `residual ${residual.toFixed(2)} dB`);
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
