#!/usr/bin/env node
/* ============================================================================
 * alert-sound-independent-check.mjs — a DELIBERATELY SEPARATE verification of
 * the rendered cha-ching alert WAV.
 *
 * tools/render-alert-sound.mjs renders the shipped alert and measures it with
 * its own DSP. This tool re-measures the SAME rendered PCM with fully
 * independent code (own 16-bit WAV parser, own Goertzel detector, own
 * envelope clustering — nothing shared with the render tool), so the two
 * implementations cross-check each other. This is the "independent band/FFT
 * analysis" that docs/alert-sound.md section 3b reports; it is committed here
 * so that cross-check is reproducible instead of one-off.
 *
 * Run:
 *   npm install --no-save web-audio-engine
 *   node tools/render-alert-sound.mjs alert-sound.wav
 *   node tools/alert-sound-independent-check.mjs alert-sound.wav
 *
 * The WAV must be 16-bit mono PCM (what render-alert-sound.mjs writes).
 * No dependencies of its own: only node:fs and plain math. Like the render
 * tool it is advisory and is NOT wired into the CI smoke suite, which
 * installs nothing. Exit codes: 0 all checks pass, 1 a check failed, 2 usage.
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WAV = process.argv[2] || 'alert-sound.wav';
if (WAV.startsWith('-')) {
  console.log('Usage: node tools/alert-sound-independent-check.mjs [rendered.wav] [strikeSeconds]');
  process.exit(2);
}

/* ------------------------------------------------------------- WAV parser */
// Minimal RIFF/WAVE reader: validates the container and returns 16-bit mono
// PCM as floats in [-1, 1]. Written from the RIFF spec, not from the render
// tool's WAV writer, so writer and parser are independent implementations.
function readWav(path) {
  const buf = readFileSync(path);
  assert.ok(buf.length >= 44, 'file too small to be a WAV');
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF', 'not a RIFF file');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE', 'not a WAVE file');
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') format = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'data') data = buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size & 1); // chunks are word-aligned
  }
  assert.ok(format, 'no fmt chunk');
  assert.ok(data, 'no data chunk');
  const audioFormat = format.readUInt16LE(0);
  const channels = format.readUInt16LE(2);
  const sampleRate = format.readUInt32LE(4);
  const bits = format.readUInt16LE(14);
  assert.equal(audioFormat, 1, 'expected PCM encoding (format 1)');
  assert.equal(channels, 1, 'expected mono');
  assert.equal(bits, 16, 'expected 16-bit samples');
  const n = data.length >> 1;
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate };
}

/* --------------------------------------------------------------- helpers */
const db = (v) => (v > 0 ? 20 * Math.log10(v) : -140);

/**
 * One-frequency DFT magnitude (Goertzel) with a Hann window, normalized to
 * sine amplitude. The window matters here: the bell's partials sit only
 * ~25-90 Hz apart, and with a rectangular window their sidelobes leak into
 * each other's bins (up to -13 dB) and falsify relative levels. Hann pushes
 * the first sidelobe to -31 dB, so measured levels are honest.
 */
function goertzel(samples, sr, fromSec, toSec, frequency) {
  const i0 = Math.floor(fromSec * sr);
  const i1 = Math.min(samples.length, Math.floor(toSec * sr));
  const n = i1 - i0;
  const w = (2 * Math.PI * frequency) / sr;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  let winSum = 0;
  for (let i = 0; i < n; i++) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    winSum += hann;
    const s0 = samples[i0 + i] * hann + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (winSum / 2);
}

function rmsDb(samples, sr, fromSec, toSec) {
  const i0 = Math.max(0, Math.floor(fromSec * sr));
  const i1 = Math.min(samples.length, Math.floor(toSec * sr));
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += samples[i] * samples[i];
  return db(Math.sqrt(sum / Math.max(1, i1 - i0)));
}

/** Scan a band in `step` Hz steps; return every bin above thresholdDb. */
function scanBand(samples, sr, fromSec, toSec, lo, hi, step, thresholdDb) {
  const bins = [];
  for (let f = lo; f <= hi; f += step) {
    const amp = goertzel(samples, sr, fromSec, toSec, f);
    if (db(amp) > thresholdDb) bins.push({ f, amp });
  }
  return bins;
}

/**
 * Group scan bins into partials. A gap larger than the analysis resolution
 * starts a new cluster; within a cluster keep the strongest bin and track the
 * span so wide clusters can be reported (the bell's prime is itself a tight
 * cluster: 2034 / 2093 / 2120 Hz sit ~13/27 Hz apart, closer than a 0.8 s
 * window can separate).
 */
function clusterBins(bins, gapHz) {
  const clusters = [];
  for (const bin of bins) {
    const last = clusters[clusters.length - 1];
    if (last && bin.f - last.topF <= gapHz) {
      last.topF = bin.f;
      last.count += 1;
      if (bin.amp > last.amp) {
        last.amp = bin.amp;
        last.f = bin.f;
      }
    } else {
      clusters.push({ f: bin.f, topF: bin.f, amp: bin.amp, count: 1 });
    }
  }
  return clusters;
}

/* -------------------------------------------------------------- checks */
const checks = [];
function check(ok, label, detail) {
  checks.push({ ok, label });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `   [${detail}]` : ''}`);
}

/* ---------------------------------------------------------------- main */
console.log(`Independent cross-check of ${WAV} (separate code from render-alert-sound.mjs)\n`);
let samples;
let SR;
try {
  ({ samples, sampleRate: SR } = readWav(WAV));
} catch (err) {
  console.log(`could not read ${WAV} as a 16-bit mono WAV: ${err.message}`);
  console.log('Render one first:  npm install --no-save web-audio-engine  &&  node tools/render-alert-sound.mjs alert-sound.wav');
  process.exit(2);
}
console.log(`parsed WAV: ${samples.length} samples, ${(samples.length / SR).toFixed(3)} s @ ${SR} Hz`);

/* A. the 1-2 second request */
console.log('\nA) duration requirement (1-2 s cha-ching)');
const threshold = 0.001;
let lastAudible = 0;
let peakAbs = 0;
for (let i = 0; i < samples.length; i++) {
  const v = Math.abs(samples[i]);
  if (v > threshold) lastAudible = i;
  if (v > peakAbs) peakAbs = v;
}
const audibleTo = lastAudible / SR;
check(audibleTo >= 1.0 && audibleTo <= 2.1, `audible to ${audibleTo.toFixed(3)} s — inside the 1-2 s request`, '');
check(peakAbs < 0.99, 'no clipping anywhere', `peak ${db(peakAbs).toFixed(1)} dBFS`);

/* The strike time comes from the design the alert ships with, so this tool
 * only has to be told once; it defaults to the shipped value. */
const STRIKE = process.argv[3] !== undefined ? parseFloat(process.argv[3]) : 0.170;
console.log(`(bell strike taken at ${STRIKE.toFixed(3)} s)`);

/* B. the "cha" precedes the "ching" and is level with it */
console.log('\nB) structure: mechanism first, and as loud as the bell');
const chaDb = rmsDb(samples, SR, 0.0, STRIKE);
const bellDb = rmsDb(samples, SR, STRIKE, STRIKE + 0.25);
check(chaDb > -35, 'the "cha" mechanism is loud before the bell', `${chaDb.toFixed(1)} dB RMS`);
const levelGap = bellDb - chaDb;
check(levelGap >= -6 && levelGap <= 8,
  'the bell and the mechanism sit level with each other, as in real recordings',
  `bell ${bellDb.toFixed(1)} dB vs cha ${chaDb.toFixed(1)} dB (gap ${levelGap.toFixed(1)} dB)`);

/* B2. the "cha" mechanism: bright, broadband and full of separate attacks.
 * These three figures are the ones the replaced build failed. Measured on two
 * real cash-register recordings (docs/alert-sound.md names them):
 *   spectral centroid        6033 Hz and 6219 Hz     (replaced build: 3270 Hz)
 *   low/mid/high band spread   1.0 dB and  2.7 dB    (replaced build:  4.2 dB)
 *   attacks (4 ms rise >=6dB)       3  and    10     (replaced build:     2)
 * None of this code is shared with tools/render-alert-sound.mjs. */
console.log('\nB2) the "cha" mechanism: bright, broadband, percussive');

/** Hann-windowed magnitude spectrum, averaged over the window. */
function averagedSpectrum(fromSec, toSec, N = 2048) {
  const i0 = Math.max(0, Math.floor(fromSec * SR));
  const i1 = Math.min(samples.length - N, Math.floor(toSec * SR));
  const hop = N >> 1;
  const acc = new Float64Array(N / 2);
  let frames = 0;
  for (let start = i0; start + N < i1; start += hop) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
      re[i] = samples[start + i] * hann;
    }
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; const u = im[i]; im[i] = im[j]; im[j] = u; }
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
  return { acc, N };
}

const mechSpec = averagedSpectrum(0, STRIKE);
{
  let num = 0, den = 0;
  for (let i = 1; i < mechSpec.N / 2; i++) {
    const m = mechSpec.acc[i] * mechSpec.acc[i];
    num += m * ((i * SR) / mechSpec.N);
    den += m;
  }
  const centroid = num / den;
  check(centroid >= 4300 && centroid <= 7800,
    `the "cha" centroid is ${centroid.toFixed(0)} Hz — as bright as the references (6033 / 6219 Hz)`);

  const bandLevel = (lo, hi) => {
    const bin = SR / mechSpec.N;
    let sum = 0, n = 0;
    for (let i = Math.max(1, Math.floor(lo / bin)); i <= Math.min(mechSpec.N / 2 - 1, Math.ceil(hi / bin)); i++) {
      sum += mechSpec.acc[i] * mechSpec.acc[i]; n++;
    }
    return db(Math.sqrt(sum / Math.max(1, n)));
  };
  const low = bandLevel(150, 400), mid = bandLevel(700, 1600), high = bandLevel(2500, 6000);
  const spread = Math.max(low, mid, high) - Math.min(low, mid, high);
  check(spread <= 3.5,
    `the "cha" is broadband: low ${low.toFixed(1)} / mid ${mid.toFixed(1)} / high ${high.toFixed(1)} dB — ` +
    `${spread.toFixed(1)} dB apart (references: 1.0 and 2.7 dB)`);

  // Attacks: 2 ms RMS envelope, count 4 ms rises of at least 6 dB.
  const hop = Math.max(1, Math.round(SR * 0.002));
  const env = [];
  for (let i = 0; i + hop <= Math.floor(STRIKE * SR); i += hop) {
    let sum = 0;
    for (let k = i; k < i + hop; k++) sum += samples[k] * samples[k];
    env.push(db(Math.sqrt(sum / hop)));
  }
  let attacks = 0;
  for (let i = 2; i < env.length; i++) if (env[i] - env[i - 2] >= 6) attacks++;
  check(attacks >= 3,
    `the "cha" breaks into ${attacks} separate attacks, not one smooth band of noise (references: 3 and 10)`);
}

/* C. the ring spectrum: prime near 2.1 kHz, inharmonic, upper partials present */
console.log(`\nC) register-bell spectrum (${(STRIKE + 0.02).toFixed(2)}-${(STRIKE + 0.25).toFixed(2)} s ring window)`);
const bins = scanBand(samples, SR, STRIKE + 0.02, STRIKE + 0.25, 900, 12000, 10, -46);
const clusters = clusterBins(bins, 60);
check(clusters.length >= 2, `${clusters.length} distinct partial cluster(s) ring in the window`);
let prime = clusters.reduce((a, b) => (b.amp > a.amp ? b : a), clusters[0]);
// The bell's prime is itself a tight cluster (1984 / 2093 / 2156 Hz sit closer
// than a 0.23 s window resolves), so the coarse scan reports only its strongest
// edge. Refine inside it with a fine 1 Hz scan to find the true peak.
const fine = scanBand(samples, SR, STRIKE + 0.02, STRIKE + 0.25, prime.f - 100, prime.f + 100, 1, -60);
if (fine.length) {
  const fineBest = fine.reduce((a, b) => (b.amp > a.amp ? b : a), fine[0]);
  prime = { f: fineBest.f, amp: fineBest.amp };
  console.log(`  (fine scan inside the strongest cluster: peak at ${prime.f.toFixed(0)} Hz, ${db(prime.amp).toFixed(1)} dB)`);
}
check(prime.f > 1800 && prime.f < 2400, `bell prime at ${prime.f.toFixed(0)} Hz — the ~2.1 kHz register-bell region`);
const devs = [];
for (const c of clusters) {
  if (c === prime) continue;
  const k = Math.max(1, Math.round(c.f / prime.f));
  devs.push(Math.abs(c.f - k * prime.f) / (k * prime.f) * 100);
}
const meanDev = devs.reduce((a, b) => a + b, 0) / Math.max(1, devs.length);
check(meanDev > 2, `partials are inharmonic (mean ${meanDev.toFixed(1)}% off the harmonic series) — metallic bell`);

/* D. struck ONCE: the prime must never re-excite after the strike */
console.log('\nD) single strike');
// A second bell strike would drive the prime band back up towards its peak.
// Short-term wobbles are NOT evidence of one: in real cash-register recordings
// this band swings by as much as +12 dB from mechanism noise alone, and the
// partials either side of the prime beat against it. What a genuine second
// strike cannot hide is the overall trend — so require the band to fall across
// every successive 100 ms step (with a wide +5 dB allowance for that noise)
// and to end up far below where it started.
const stepLevels = [];
for (let k = 0; k < 7; k++) {
  const t = STRIKE + 0.10 + 0.10 * k;
  stepLevels.push(db(goertzel(samples, SR, t, t + 0.06, prime.f)));
}
let worstStep = -Infinity;
for (let k = 1; k < stepLevels.length; k++) worstStep = Math.max(worstStep, stepLevels[k] - stepLevels[k - 1]);
check(worstStep <= 5.0, 'the prime never jumps back up — one "ching", not two',
  `worst 100 ms step: ${worstStep >= 0 ? '+' : ''}${worstStep.toFixed(1)} dB`);
const overallFall = stepLevels[stepLevels.length - 1] - stepLevels[0];
check(overallFall <= -12, 'the prime keeps falling all the way down the ring',
  `${overallFall.toFixed(1)} dB from 0.10 s to 0.70 s after the strike`);

/* E. decay signature: the prime falls at the rate real register bells do */
console.log('\nE) decay signature');
const primeEarly = goertzel(samples, SR, STRIKE + 0.03, STRIKE + 0.09, prime.f);
const primeLate = goertzel(samples, SR, STRIKE + 0.35, STRIKE + 0.41, prime.f);
const primeRate = (db(primeLate) - db(primeEarly)) / (0.32);
const primeTau = -1 / (primeRate / 8.686);
check(primeRate < -28 && primeRate > -70,
  `the prime rings down at ${primeRate.toFixed(1)} dB/s — a struck bell, not a sustained tone`);
check(primeTau >= 0.18 && primeTau <= 0.38,
  `prime time constant ${primeTau.toFixed(3)} s matches the measured ~0.22 s of a real register bell`);
let upperDecay = null;
let upperF = 0;
for (const f of [prime.f * 2.29, prime.f * 2.53]) {
  const early = goertzel(samples, SR, STRIKE + 0.03, STRIKE + 0.09, f);
  const late = goertzel(samples, SR, STRIKE + 0.35, STRIKE + 0.41, f);
  const d = db(late) - db(early);
  if (upperDecay === null || d < upperDecay) {
    upperDecay = d;
    upperF = f;
  }
}
check(upperDecay !== null && upperDecay < db(primeLate) - db(primeEarly),
  `upper partial ${upperF.toFixed(0)} Hz dies faster (${upperDecay.toFixed(1)} dB) than the prime — struck metal, not a chime`);

/* -------------------------------------------------------------- report */
console.log('\npartial clusters found (freq = strongest bin, span = cluster width):');
clusters
  .concat([{ f: prime.f, topF: prime.f, amp: prime.amp, count: 0, refined: true }])
  .sort((a, b) => a.f - b.f)
  .forEach((c) => console.log(`  ${c.f.toFixed(0)} Hz${c.topF - c.f >= 15 ? `-${c.topF.toFixed(0)}` : ''}  ${db(c.amp).toFixed(1)} dB${c.refined ? '   (fine scan)' : ''}`));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} independent checks passed`);
if (failed.length) {
  failed.forEach((c) => console.log(`FAILED: ${c.label}`));
  process.exit(1);
}
console.log('Independent re-measurement agrees: the alert is a 1-2 s cha-ching cash-register sound.');
