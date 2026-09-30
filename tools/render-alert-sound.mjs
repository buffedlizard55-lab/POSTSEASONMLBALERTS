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
function loadShippedModule(offlineContext) {
  const source = readFileSync(new URL('../assets/js/reviews-feed.js', import.meta.url), 'utf8');
  class FakeAudioContext { constructor() { return offlineContext; } }
  const context = {
    console: { warn() {}, error() {}, log() {} },
    Map, Set, Date, Math, Number, String, Object, Array, URLSearchParams,
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

/* 1. duration and level */
let lastAudible = 0;
for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > 3e-4) lastAudible = i;
const totalPeak = peak(samples, 0, samples.length);
console.log('1) the alert as a whole');
check(lastAudible / SR >= 1.5 && lastAudible / SR <= 2.1, 'rings for at least 1.5 s (request: 1-2 s)',
  `audible to ${(lastAudible / SR).toFixed(3)} s`);
check(totalPeak < 0.99, 'does not clip', `peak ${(db(totalPeak)).toFixed(1)} dBFS`);
check(totalPeak > 0.1 && totalPeak < 0.55, 'sits at a sensible alert level', `peak ${(db(totalPeak)).toFixed(1)} dBFS`);

/* 2. "cha" mechanism ahead of the "ching" */
console.log('\n2) the "cha" mechanism');
const chaPeak = peak(samples, 0, 0.11);
const bellPeak = peak(samples, 0.15, 0.30);
check(chaPeak > 0.02, 'lever/keys are audible before the bell', `peak ${db(chaPeak).toFixed(1)} dBFS`);
check(db(bellPeak) - db(chaPeak) >= 4 && db(bellPeak) - db(chaPeak) <= 18,
  'the mechanism sits under the bell, not on top of it', `${(db(bellPeak) - db(chaPeak)).toFixed(1)} dB below`);
const slideRms = rms(samples, 0.12, 0.155);
check(db(slideRms) > -45, 'the drawer slide is present in the gap before the bell', `${db(slideRms).toFixed(1)} dB RMS`);

/* 3. the bell: designed partials actually present, inharmonic, upper faster */
console.log('\n3) the register bell');
const prime = toneLevel(samples, 0.2, 0.3, SPEC.bellFundamental);
check(prime > 0, `bell prime at ${SPEC.bellFundamental} Hz`, `${db(prime).toFixed(1)} dB`);
SPEC.bellPartials.forEach((partial) => {
  const f = SPEC.bellFundamental * partial.ratio;
  if (f > SR / 2 - 200) return;
  const level = toneLevel(samples, 0.2, 0.3, f);
  check(level > prime * 0.02, `partial ${partial.ratio}x (${f.toFixed(0)} Hz) rings`,
    `${db(level / prime).toFixed(1)} dB below the prime`);
});

/* 4. two strikes: render the same graph with the second tap removed and diff */
console.log('\n4) the bell is struck twice (seeded A/B against the same graph minus the 2nd tap)');
const offA = newContext();
const modA = loadShippedModule(offA);
const specNoSecond = JSON.parse(JSON.stringify(SPEC));
specNoSecond.bellStrikes = specNoSecond.bellStrikes.slice(0, 1);
modA.module.exports.buildCashRegisterChime(offA, offA.destination, 0, specNoSecond);
const withoutSecond = (await offA.startRendering()).getChannelData(0);
const secondTapAt = SPEC.bellStrikes[1].at;
const withSecondAt = rms(samples, secondTapAt - 0.005, secondTapAt + 0.025);
const withoutSecondAt = rms(withoutSecond, secondTapAt - 0.005, secondTapAt + 0.025);
check(db(withSecondAt) - db(withoutSecondAt) >= 1.0,
  `the second tap changes the sound at ${secondTapAt} s (it is not a no-op)`,
  `+${(db(withSecondAt) - db(withoutSecondAt)).toFixed(1)} dB vs single strike`);
const firstStrikeTimes = [];
envelope(samples, 0.002).forEach((frame, index, all) => {
  if (index < 4) return;
  const rise = frame.db - all[index - 4].db;
  if (frame.t > 0.14 && frame.t < 0.40 && rise > 6 && frame.db > -35) firstStrikeTimes.push(+frame.t.toFixed(3));
});
check(firstStrikeTimes.length >= 1, 'a sharp bell attack is detectable', `at ${firstStrikeTimes.slice(0, 3).join(', ')} s`);

/* 5. the ring lasts and decays smoothly to the end */
console.log('\n5) the ring');
const env = envelope(samples, 0.025).filter((frame) => frame.t >= 0.45 && frame.t <= 1.45);
const meanT = env.reduce((a, f) => a + f.t, 0) / env.length;
const meanV = env.reduce((a, f) => a + f.db, 0) / env.length;
let num = 0, den = 0;
env.forEach((f) => { num += (f.t - meanT) * (f.db - meanV); den += (f.t - meanT) ** 2; });
const slope = num / den;
const residual = Math.sqrt(env.reduce((a, f) => a + (f.db - (meanV + slope * (f.t - meanT))) ** 2, 0) / env.length);
check(slope < -3, 'the ring keeps decaying (no flat tone)', `${slope.toFixed(1)} dB/s`);
check(residual < 1.6, 'the ring decays smoothly, without a slow warble', `residual ${residual.toFixed(2)} dB`);
check(db(rms(samples, 1.6, 1.85)) > -55, 'still ringing in the last quarter second',
  `${db(rms(samples, 1.6, 1.85)).toFixed(1)} dB RMS`);
const quietRuns = envelope(samples, 0.01).filter((f) => f.t > 0.1 && f.t < 1.7 && f.db < -60).length;
check(quietRuns < 12, 'no silent hole inside the alert', `${(quietRuns * 10)} ms below -60 dB`);

/* -------------------------------------------------------------- report */
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  failed.forEach((c) => console.log(`FAILED: ${c.label}`));
  process.exit(1);
}
console.log('The shipped alert sound renders and measures as designed.');
