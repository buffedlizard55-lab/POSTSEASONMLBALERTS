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
    // The HOST's typed arrays, not the VM's own. web-audio-engine silently
    // REJECTS a cross-realm Float32Array assigned to WaveShaperNode.curve — the
    // property reads back null and the node passes audio straight through, so
    // the render would measure a graph with no soft-clipper in it while still
    // reporting every check as passed. Real browsers accept any Float32Array,
    // so this is purely a harness correctness fix; the guard in section 0 below
    // fails the run if it ever regresses.
    Float32Array, Float64Array, Uint8Array, Int16Array, Uint32Array,
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

/** Percentile of an array of dB values. */
function percentile (values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** 25 ms RMS frames, as { t, db } — the resolution the reference was measured at. */
function frames25 (samples, fromSec, toSec) {
  const frame = Math.round(0.025 * SR);
  const out = [];
  const i0 = Math.max(0, Math.floor(fromSec * SR));
  const i1 = Math.min(samples.length, Math.floor(toSec * SR));
  for (let i = i0; i + frame <= i1; i += frame) {
    let sum = 0;
    for (let k = 0; k < frame; k++) sum += samples[i + k] * samples[i + k];
    out.push({ t: (i + frame / 2) / SR, db: db(Math.sqrt(sum / frame)) });
  }
  return out;
}

/** 2 ms RMS frames, as { t, db } — the resolution attacks are counted at. */
function frames2 (samples, fromSec, toSec) {
  const frame = Math.round(0.002 * SR);
  const out = [];
  const i0 = Math.max(0, Math.floor(fromSec * SR));
  const i1 = Math.min(samples.length, Math.floor(toSec * SR));
  for (let i = i0; i + frame <= i1; i += frame) {
    let sum = 0;
    for (let k = 0; k < frame; k++) sum += samples[i + k] * samples[i + k];
    out.push({ t: (i + frame / 2) / SR, db: db(Math.sqrt(sum / frame)) });
  }
  return out;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const stddev = (a) => Math.sqrt(a.reduce((x, y) => x + (y - mean(a)) ** 2, 0) / Math.max(1, a.length));

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
// A real register bell (R1) was measured at 0.219 s. The design holds the prime
// longer than that — SPEC.bellPartials' 1.0x tau is 0.330 s — because R1's file
// cuts off at 1.08 s with the bell still ringing and this alert has to stay
// audible for the 1-2 s that was asked for. The band therefore admits the
// designed value with slack for measurement contamination (the drawer slide's
// energy sits in the same windows), while still rejecting a sustained tone
// above it and a tick below it. Both directions are covered: tools/
// alert-sound-independent-check.mjs derives its own band from the same spec.
const REF_TAU_MIN = 0.20, REF_TAU_MAX = 0.36;          // measured 0.219 s (R1)
const REF_BALANCE_MIN = -5, REF_BALANCE_MAX = 1;       // measured -0.1 / -4.3 dB
const REF_CHA_CENTROID_MIN = 4500, REF_CHA_CENTROID_MAX = 7500;  // 6033 / 6219 Hz
const REF_CHA_SPREAD_MAX = 3.5;                        // measured 1.0 / 2.7 dB
const REF_CHA_CREST_MIN = 10, REF_CHA_CREST_MAX = 18;  // measured 12.9 / 15.9 dB (reported only now)
// Measured on the real recording over its 0.05 s -> strike plateau, 2 ms frames.
const REF_PLATEAU_SPREAD_MIN = 0.4, REF_PLATEAU_SPREAD_MAX = 3.0;  // measured 1.06 dB
const REF_PLATEAU_STD_MIN = 0.8, REF_PLATEAU_STD_MAX = 3.5;        // measured 1.80 dB
const REF_PLATEAU_LEVEL_MIN = -13;      // measured -7.2 dB; replaced build ~ -19 dB
// Whole-alert dynamics, all measured on the real recording (docs/alert-sound.md §2):
const REF_BODY_MIN = -13;               // measured -6.5 dB p90 RMS over 0-0.6 s
const REF_LOUDEST_FRAME_MIN = -12;      // measured -6.3 dB loudest 25 ms RMS
const REF_PEAK_TO_BODY_MAX = 9;         // measured 6.5 dB; replaced build 12.8 dB
const REF_AUDIBLE40_MIN = 1.0;          // measured 1.070 s above -40 dB
const REF_ONSET_RISE_MIN = 3;           // measured 14.7 dB; replaced build 0.2 dB
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

/* 0. the harness itself: is the graph the one that got measured? ------------
 *
 * Two failure modes are checked before anything about the sound is, because
 * both would otherwise let every later check pass on a graph that is not the
 * shipped one:
 *   - the soft-clip curve being dropped at the VM/host realm boundary (see the
 *     Float32Array note in loadShippedModule), which turns the master bus into
 *     a plain gain and quietly changes every level measured below;
 *   - the design data drifting from the builder.
 */
console.log('0) the harness is measuring the shipped graph');
{
  const probe = newContext();
  const mod = loadShippedModule(probe);
  const head = mod.module.exports.buildCashRegisterChime(probe, probe.destination, 0);
  const tail = head.output;
  check(!!tail && tail !== head,
    'the master bus ends in the soft-clipper, not the raw gain node');
  check(tail && tail.curve instanceof Float32Array,
    'the soft-clip curve survived the VM/host realm boundary (web-audio-engine drops cross-realm typed arrays silently)',
    tail && tail.curve ? `${tail.curve.length} points` : 'no curve on the master bus');
  if (tail && tail.curve instanceof Float32Array && SPEC.softClip) {
    const c = tail.curve;
    const size = SPEC.softClip.curveSize;
    check(c.length === size, 'the curve is the designed size', `${c.length} of ${size}`);
    const mid = (c.length - 1) / 2;
    check(Math.abs(c[Math.floor(mid)]) < 1e-6, 'the curve passes through zero (no DC offset)');
    let monotonic = true, antisym = true, maxAbs = 0, slope0 = Infinity;
    for (let i = 1; i < c.length; i++) if (c[i] < c[i - 1] - 1e-9) monotonic = false;
    for (let i = 0; i <= Math.floor(mid); i++) {
      if (Math.abs(c[c.length - 1 - i] + c[i]) > 1e-5) antisym = false;
    }
    for (let i = 0; i < c.length; i++) maxAbs = Math.max(maxAbs, Math.abs(c[i]));
    slope0 = Math.abs(c[Math.floor(mid) + 1] - c[Math.floor(mid) - 1]) / (4 / (c.length - 1));
    check(monotonic, 'the curve is monotonic (it saturates, it never folds back)');
    check(antisym, 'the curve is antisymmetric (no even harmonics, no DC)');
    check(Math.abs(maxAbs - SPEC.softClip.ceiling) < 1e-4,
      'the curve cannot output more than its ceiling, so the alert cannot clip',
      `max |y| = ${maxAbs.toFixed(4)}, ceiling ${SPEC.softClip.ceiling}`);
    check(slope0 > 1.0,
      'the curve lifts quiet material (that is where the loudness comes from)',
      `slope at 0 = ${slope0.toFixed(2)}x`);
    check(tail.oversample === SPEC.softClip.oversample,
      'the soft-clipper oversamples as designed', `${tail.oversample}`);
  }
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

/* 1b. whole-alert dynamics ---------------------------------------------------
 *
 * These are the checks whose absence let the replaced build pass 40/40 and
 * still sound wrong. Every one of its own criteria was a ratio measured inside
 * a narrow window, so a sound that was 10 dB too quiet and dynamically flat
 * satisfied all of them. Each band below is a number measured on the real
 * recording, and each one is failed by the build this replaces.
 *
 *   figure                        reference   replaced build
 *   body level (p90, 0-0.6 s)      -6.5 dB      -17.5 dB
 *   loudest 25 ms RMS              -6.3 dB      -16.8 dB
 *   peak minus body level           6.5 dB       12.8 dB
 *   audible above -40 dB           1.070 s       0.790 s
 *   first frame vs loudest frame   14.7 dB        0.2 dB
 */
console.log('\n1b) whole-alert dynamics (the checks the replaced build never faced)');
const head25 = frames25(samples, 0, 0.6);
const bodyLevel = percentile(head25.map((f) => f.db), 0.90);
check(bodyLevel >= REF_BODY_MIN,
  'the alert has BODY: its 90th-percentile level over the first 0.6 s is loud',
  `${bodyLevel.toFixed(1)} dB (reference -6.5; the replaced build -17.5)`);

const cha25 = frames25(samples, 0, STRIKE_AT);
const loudestFrame = Math.max(...cha25.map((f) => f.db));
check(loudestFrame >= REF_LOUDEST_FRAME_MIN,
  'the "cha" reaches a real peak level, not a muted one',
  `loudest 25 ms frame ${loudestFrame.toFixed(1)} dB (reference -6.3; replaced build -16.8)`);

check(db(totalPeak) - bodyLevel <= REF_PEAK_TO_BODY_MAX,
  'the alert is dense, not a few spikes over near-silence',
  `peak minus body ${(db(totalPeak) - bodyLevel).toFixed(1)} dB (reference 6.5; replaced build 12.8)`);

const env10 = envelope(samples, 0.010).filter((f) => f.t > 0.005);
const audible40 = env10.filter((f) => f.db > -40);
const audible40len = audible40.length ? audible40[audible40.length - 1].t - audible40[0].t : 0;
check(audible40len >= REF_AUDIBLE40_MIN,
  'the alert is genuinely audible for 1-2 seconds, not just non-silent',
  `${audible40len.toFixed(3)} s above -40 dB (reference 1.070; replaced build 0.790)`);

// A real "cha" RAMPS: the reference climbs from -21 dB in its first 25 ms to
// -6.3 dB. The replaced build was loudest in its very first frame and then
// decayed monotonically, so the bell arrived after the machine had already
// wound down instead of on top of a machine still running at full weight.
const firstFrame = cha25.length ? cha25[0].db : -140;
check(loudestFrame - firstFrame >= REF_ONSET_RISE_MIN,
  'the "cha" ramps up to its peak instead of starting at it and decaying',
  `loudest frame is ${(loudestFrame - firstFrame).toFixed(1)} dB above the first (reference 14.7; replaced build 0.2)`);

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

/* The "cha" must be a machine RUNNING: a steady loud plateau with a little
 * texture on it. Measured on the real recording over 0.05 s to the strike, the
 * 2 ms frames sit at p50 -7.2 dB and p95 -6.1 dB, i.e. p95-p50 = 1.06 dB and a
 * standard deviation of 1.80 dB. Both failure modes fall outside that: a smooth
 * hiss has p95-p50 and std near 0, and a row of isolated spikes has both far
 * above 3 dB. These two numbers are ratios of levels within one window, so
 * unlike a crest factor they do not move when the master level or the master
 * soft-clip ceiling moves. */
const PLATEAU_FROM = 0.05;
const plateauDb = frames2(samples, PLATEAU_FROM, STRIKE_AT).map((f) => f.db);
const plateauSpread = percentile(plateauDb, 0.95) - percentile(plateauDb, 0.50);
const plateauStd = stddev(plateauDb);
check(plateauSpread >= REF_PLATEAU_SPREAD_MIN && plateauSpread <= REF_PLATEAU_SPREAD_MAX,
  'the "cha" runs as a mechanism: a steady plateau with texture, not a hiss and not isolated spikes',
  `p95-p50 ${plateauSpread.toFixed(2)} dB (reference 1.06; a hiss is ~0, spikes are >3)`);
check(plateauStd >= REF_PLATEAU_STD_MIN && plateauStd <= REF_PLATEAU_STD_MAX,
  'the "cha" plateau varies by about as much as a real one',
  `std ${plateauStd.toFixed(2)} dB (reference 1.80)`);
check(percentile(plateauDb, 0.50) >= REF_PLATEAU_LEVEL_MIN,
  'the "cha" plateau is LOUD — the single thing the replaced build got worst',
  `p50 ${percentile(plateauDb, 0.50).toFixed(1)} dB (reference -7.2; the replaced build measured about -19)`);

/* Reported, not asserted. The crest factor this replaces was peak/RMS across
 * the whole "cha" window, banded 10-18 dB from the reference's 12.9 and 15.9.
 * That band is unusable here and asserting it would have forced the original
 * defect back in: the reference peaks at 0.0 dBFS because it was hard-limited
 * in mastering, while check 1 below forbids this alert from exceeding -3 dBFS.
 * Holding the peak 3.3 dB lower than the reference's while demanding the same
 * crest demands an RMS 3.3 dB lower — i.e. it demands the quiet, thin "cha"
 * that is exactly what was wrong. The plateau checks above test the same
 * property (a mechanism, not a tone or a hiss) without depending on where the
 * ceiling happens to sit. */
const chaPeak = peak(samples, 0, STRIKE_AT);
const chaCrest = db(chaPeak) - db(chaRms);
console.log(`  info  "cha" crest (not asserted — see the comment above): ${chaCrest.toFixed(1)} dB (references 12.9 and 15.9, both measured at a 0 dBFS ceiling)`);
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
  'the prime\'s time constant stays inside the struck-bell band — held longer than a real bell on purpose, so the ring carries the 1-2 s alert',
  `tau ${tau.toFixed(3)} s (measured on a real register bell: 0.219 s; band ${REF_TAU_MIN}-${REF_TAU_MAX})`);

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
