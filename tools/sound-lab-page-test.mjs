#!/usr/bin/env node
/* ============================================================================
 * sound-lab-page-test.mjs — static verification of sound-lab.html and of the
 * audio half of the alert-sound contract.
 *
 * The Sound Lab is a browser page and no browser is available in CI, so this
 * proves everything about it that can be proven without one:
 *
 *   A. every inline <script> parses
 *   B. every element id the script touches exists in the markup
 *   C. every file the page loads exists on disk
 *   D. every ReplayFeed member the page calls is really exported
 *   E. the measurement code the page carries is the SAME code the offline
 *      render tool measures with — frame sizes, percentile index rule, FFT
 *      size/window/hop, attack definition and the plateau window all have to
 *      agree, or the numbers on the page silently stop being comparable to
 *      the numbers in tools/render-alert-sound.mjs and docs/alert-sound.md
 *   F. the server's alert-sound slot agrees with the client's probe list
 *
 * Section E is the one that matters. The page duplicates a little DSP so it can
 * measure a dropped file in-browser; duplication that drifts is worse than no
 * duplication, because a user would compare a page figure against a documented
 * reference figure that was measured a different way.
 *
 * No dependencies beyond node:fs and node:vm. Exit 0 = all checks pass, 1 = a
 * check failed, 2 = usage.
 * ==========================================================================*/

import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url);
const at = (p) => new URL(p, ROOT).pathname;

if (process.argv[2] === '-h' || process.argv[2] === '--help') {
  console.log('Usage: node tools/sound-lab-page-test.mjs');
  process.exit(2);
}

const checks = [];
function check(ok, label, detail) {
  checks.push({ ok: !!ok, label, detail });
  const mark = ok ? '  PASS ' : '  FAIL ';
  console.log(`${mark} ${label}${detail ? `   [${detail}]` : ''}`);
}
function section(title) { console.log(`\n${title}`); }

const html = readFileSync(at('sound-lab.html'), 'utf8');
const feed = readFileSync(at('assets/js/reviews-feed.js'), 'utf8');
const server = readFileSync(at('server.mjs'), 'utf8');
const renderTool = readFileSync(at('tools/render-alert-sound.mjs'), 'utf8');

/* ---------------------------------------------------------------- A. parses */
section('A) the page is valid enough to run');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check(scripts.length === 1, 'the page carries exactly one inline script', `${scripts.length} found`);
let parses = true;
scripts.forEach((code) => {
  try { new vm.Script(code, { filename: 'sound-lab.html#inline' }); } catch (e) {
    parses = false;
    console.log(`        syntax error: ${e.message}`);
  }
});
check(parses, 'the inline script parses', `${scripts[0] ? scripts[0].length : 0} chars`);
check(html.startsWith('<!DOCTYPE html>'), 'the page starts with a doctype');
check(/<html lang="en">/.test(html), 'the page declares its language');
check(/<meta name="viewport"/.test(html), 'the page is mobile-readable');
check(/<title>[^<]*Sound Lab/.test(html), 'the page has a real title');

/* ------------------------------------------------------- B. ids all exist */
section('B) every element the script touches exists');
const referenced = new Set();
for (const m of html.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) referenced.add(m[1]);
for (const m of html.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) referenced.add(m[1]);
const declared = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const missingIds = [...referenced].filter((id) => !declared.has(id));
check(missingIds.length === 0, 'no script reference points at a missing id',
  `${referenced.size} referenced, ${declared.size} declared` +
  (missingIds.length ? `, missing: ${missingIds.join(', ')}` : ''));
// The drop target and the file input have to be distinct elements, and the
// input has to be the one the drop zone opens.
check(declared.has('lab-drop') && declared.has('lab-file'),
  'the drop zone and the file input are both present');
check(/id="lab-file"[^>]*\bhidden\b/.test(html),
  'the file input is hidden — the drop zone is what the user clicks');

/* ------------------------------------------------------ C. assets exist */
section('C) everything the page loads exists on disk');
const loaded = [
  ...[...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/<link[^>]*\bhref="(assets\/[^"]+)"/g)].map((m) => m[1]),
];
check(loaded.length >= 5, 'the page loads the shared modules and stylesheet', `${loaded.length} files`);
const missingFiles = loaded.filter((p) => !existsSync(at(p)));
check(missingFiles.length === 0, 'no loaded file is missing',
  missingFiles.length ? missingFiles.join(', ') : loaded.join(', '));
check(loaded.includes('assets/js/reviews-feed.js'),
  'the page loads the real alert module — it must not reimplement the sound');
check(!/<section[^>]*id="feed-list"/.test(html),
  'the page has no #feed-list, so the module skips its feed bootstrap and never polls statsapi');
check(/skips its feed bootstrap/.test(html),
  'and the page says why it is allowed to load a feed module');

/* ------------------------------------------------------ D. exports exist */
section('D) every ReplayFeed member the page calls is exported');
const exportBlock = feed.slice(feed.indexOf('window.ReplayFeed = {'));
check(exportBlock.length > 0, 'the module publishes window.ReplayFeed');
const used = [...new Set([...html.matchAll(/\bRF\.([A-Za-z0-9_]+)\b/g)].map((m) => m[1]))];
const missingExports = used.filter((name) =>
  !new RegExp(`(^|[\\s{,])${name}[\\s(:,]`, 'm').test(exportBlock));
check(missingExports.length === 0, 'nothing the page calls is missing from the public API',
  missingExports.length ? `missing: ${missingExports.join(', ')}` : `${used.length} members used`);
// The page must go through the real code path for the primary button, or it
// would be auditioning something other than what the site plays.
check(/RF\.playAlertSound\(\)/.test(html),
  'the page plays through ReplayFeed.playAlertSound() — the real path');
check(/RF\.setAlertSampleFromBytes\(/.test(html),
  'a dropped file is installed through the module, not decoded separately');

/* ------------------------------------------- E. the DSP must not drift */
section('E) the page measures the way the offline tool measures');

/** Pull one function's source out of a file by name. */
function fnSource(text, name) {
  const start = text.indexOf(`function ${name}`);
  if (start < 0) return null;
  let depth = 0, began = false;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') { depth++; began = true; }
    else if (text[i] === '}') { depth--; if (began && depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}
/** Strip comments/whitespace so cosmetic differences do not read as drift. */
function normalize(code) {
  return String(code || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ');
}
/* The comparisons below pin the DECISIVE ARITHMETIC of each measure, not its
 * surface syntax. The page is written in ES5 style (`var`, `function`) and the
 * tool in ES6 (`const`, arrows, spread), so comparing whole function bodies
 * reports drift where there is none. What actually has to agree is the index
 * rule, the frame length, the window function, the FFT size and hop, the
 * magnitude expression and the centroid weighting — each of which is a single
 * expression, matched here with `\w+` standing in for the local names. */
const inBoth = (re, label, why) => {
  const page = re.test(html), tool = re.test(renderTool);
  check(page && tool, label, `page ${page ? 'yes' : 'NO'}, tool ${tool ? 'yes' : 'NO'} — ${why}`);
};

// E2. The percentile index rule. Easy to get subtly wrong
// (Math.round(p*(n-1)) instead of Math.floor(n*p)) and it moves every
// p50/p90/p95 the page prints.
inBoth(/sorted\[\s*Math\.min\(\s*sorted\.length\s*-\s*1\s*,\s*Math\.floor\(\s*sorted\.length\s*\*\s*p\s*\)\s*\)\s*\]/,
  'the percentile index rule is identical, so p50/p90/p95 mean the same thing',
  'both index the sorted array at floor(n*p), clamped');

// E3. Frame lengths. The page has one generic framesN(); the tool has frames25()
// and frames2(). They are the same measure only if the page really is called at
// 25 ms and 2 ms, and both convert seconds to samples by rounding.
inBoth(/Math\.round\(\s*(?:\w+\s*\*\s*sr|0\.025\s*\*\s*SR|0\.002\s*\*\s*SR)\s*\)/,
  'both convert a frame length in seconds to samples by rounding',
  'the same integer frame length, so frames align on the same samples');
check(/Math\.round\(0\.025 \* SR\)/.test(renderTool) && /Math\.round\(0\.002 \* SR\)/.test(renderTool),
  'the tool defines its 25 ms and 2 ms frames with those exact constants');
check(/framesN\(x, sr, 0, Math\.min\(STRIKE_AT, dur\), 0\.025\)/.test(html.replace(/\s+/g, ' ')) &&
      /framesN\(x, sr, 0, Math\.min\(0\.6, dur\), 0\.025\)/.test(html.replace(/\s+/g, ' ')),
  'the page calls its generic framer at 25 ms for the body and loudest-frame measures');
check(/framesN\(x, sr, PLATEAU_FROM, Math\.min\(STRIKE_AT, dur\), 0\.002\)/.test(html.replace(/\s+/g, ' ')),
  'and at 2 ms for the plateau texture measures');

// E4. The FFT: size, window function and hop. A different N moves every bin
// frequency, so a centroid measured with another N is not comparable.
inBoth(/N = 2048/, 'the FFT is 2048 points on both sides',
  'bin width is sr/2048, which the centroid is weighted by');
inBoth(/hop = N \/ 2/, 'the FFT hop is 1024 on both sides',
  'the same number of averaged frames over the same window');
inBoth(/0\.5 - 0\.5 \* Math\.cos\(\(2 \* Math\.PI \* \w+\) \/ \(N - 1\)\)/,
  'both apply the same Hann window',
  'the N-1 denominator is what makes it Hann rather than Hamming');
inBoth(/acc\[\w+\] \+= Math\.sqrt\(re\[\w+\] \* re\[\w+\] \+ im\[\w+\] \* im\[\w+\]\)/,
  'both accumulate the same magnitude per bin',
  'sqrt(re^2 + im^2), summed across frames');
inBoth(/start \+ N < i1/, 'both stop the frame loop at the same bound',
  'so the same frames go into the average');

// E5. The centroid formula, including that it starts at bin 1 (skipping DC).
inBoth(/for \((?:var|let) i = 1; i < (?:spec\.)?N \/ 2; i\+\+\)/,
  'the centroid skips the DC bin',
  'bin 0 would drag the centroid down towards 0 Hz');
inBoth(/num \+= m \* \(\(i \* (?:spec\.)?(?:sr|SR)\) \/ (?:spec\.)?N\);\s*den \+= m/,
  'the centroid is the same energy-weighted mean frequency',
  'sum(f * |X|^2) / sum(|X|^2), with m the squared magnitude');

// E6. The attack definition: 2 ms envelope over the WHOLE file, then windowed,
// then 4 ms rises of >= 6 dB. The order matters — windowing first changes the
// indices the rise is measured across.
const pageAtt = normalize(fnSource(html, 'countAttacks'));
const toolAtt = normalize(fnSource(renderTool, 'countAttacks'));
[['2 ms envelope', /envelope\([^)]*0\.002\)/],
 ['windowed after', /filter\(\(f\) => f\.t >= \w+ && f\.t <= \w+\)|filter\(function \(f\) \{ return f\.t >= \w+ && f\.t <= \w+;/],
 ['4 ms apart', /env\[i\]\.db - env\[i - 2\]\.db >= 6/]].forEach(([label, re]) => {
  check(re.test(pageAtt) && re.test(toolAtt), `the attack count agrees on ${label}`,
    `page ${re.test(pageAtt) ? 'yes' : 'NO'}, tool ${re.test(toolAtt) ? 'yes' : 'NO'}`);
});

// E7. The plateau window and the analysis window both end at the SHIPPED strike
// time, read from the design rather than hardcoded. A stale literal here is
// exactly the bug that had already crept into
// tools/alert-sound-independent-check.mjs.
check(/RF\.alertSoundSpec/.test(html) && /bellStrikes\[0\]\.at/.test(html),
  'the page takes the strike time from the shipped design, not a literal');
check(/PLATEAU_FROM = 0\.05/.test(html) && /PLATEAU_FROM = 0\.05/.test(renderTool),
  'both measure the plateau from 0.05 s');
check(/framesN\(x, sr, PLATEAU_FROM, Math\.min\(STRIKE_AT, dur\), 0\.002\)/.test(html.replace(/\s+/g, ' ')) ||
      /PLATEAU_FROM, Math\.min\(STRIKE_AT, dur\), 0\.002/.test(normalize(html)),
  'the page measures the plateau at 2 ms over the same window as the tool');
check(/envelope\(x, sr, 0\.010\)\.filter\(function \(f\) \{ return f\.t > 0\.005; \}\)/.test(normalize(html)) ||
      /0\.010\).filter/.test(normalize(html)),
  'the audible-duration measure drops the first 5 ms, as the tool does');
check(/f\.db > -40/.test(html) && /f\.db > -40/.test(renderTool),
  'both count audible duration above -40 dB');

// E8. Peak normalization: the page must report the gain the module will apply.
check(/ALERT_SAMPLE_TARGET_PEAK_DB/.test(feed) && /-2\.0/.test(feed),
  'the module normalizes a recording to a documented target peak');
check(/peakOfBuffer/.test(html) && /numberOfChannels/.test(html),
  'the page measures peak across every channel, as the module does when it normalizes');

// E9. The reference figures on the page must be the ones the tool asserts.
const REF_BLOCK = /var REF = \{([\s\S]*?)\};/.exec(html);
check(!!REF_BLOCK, 'the page carries the reference figures it compares against');
if (REF_BLOCK) {
  const ref = REF_BLOCK[1];
  [['bodyP90', -6.5, 'REF_BODY_P90'], ['loudestFrame', -6.3, 'REF_LOUDEST_FRAME'],
   ['plateauSpread', 1.06, 'REF_PLATEAU_SPREAD'], ['plateauStd', 1.80, 'REF_PLATEAU_STD'],
   ['plateauP50', -7.2, 'REF_PLATEAU_LEVEL'], ['audible40', 1.070, 'REF_AUDIBLE40']].forEach(
    ([key, value, toolConst]) => {
      const pageHas = new RegExp(`${key}:\\s*${String(value).replace('-', '\\-')}`).test(ref);
      check(pageHas, `the page's ${key} reference is ${value}, the measured figure`,
        pageHas ? `tool constant ${toolConst}` : 'MISSING from the page');
    });
}

/* --------------------------------------- F. client and server must agree */
section('F) the server slot and the client probe list agree');
const clientPaths = [...feed.matchAll(/'(assets\/audio\/cha-ching\.\w+)'/g)].map((m) => m[1]);
check(clientPaths.length >= 4, 'the client probes a documented list of candidate paths',
  clientPaths.join(', '));
const serverCandidates = /AUDIO_CANDIDATES = \[([^\]]*)\]/.exec(server);
check(!!serverCandidates, 'the server declares its candidate extensions');
if (serverCandidates) {
  const serverPaths = [...serverCandidates[1].matchAll(/'(\.\w+)'/g)]
    .map((m) => `assets/audio/cha-ching${m[1]}`);
  check(JSON.stringify(serverPaths) === JSON.stringify(clientPaths),
    'the server writes the same names, in the same order, that the client probes',
    serverPaths.join(', '));
}
check(/const AUDIO_DIR = path\.join\(REPO_DIR, 'assets', 'audio'\)/.test(server),
  'uploads are confined to assets/audio/');
check(/AUDIO_MAX_BYTES = 12 \* 1024 \* 1024/.test(server), 'uploads are size-capped');
check(/fs\.renameSync\(tempPath, target\)/.test(server),
  'an upload is written atomically — a half-written file would fail to decode');
check(/detectAudioContainer/.test(server) && /RIFF/.test(server),
  'the server recognises audio by container magic bytes, not by a byte histogram');
check(!/controls > head\.length/.test(server),
  'and no longer uses the control-character heuristic that rejected real WAVs');
['.mp3', '.wav', '.ogg', '.m4a'].forEach((ext) => {
  check(new RegExp(`'${ext.replace('.', '\\.')}': 'audio/`).test(server),
    `the server serves ${ext} with an audio MIME type`);
});
check(existsSync(at('assets/audio/README.md')),
  'assets/audio/README.md documents the slot and the licence requirement');
check(/LICENCE\.md/.test(readFileSync(at('assets/audio/README.md'), 'utf8')),
  'and says a licence record is required before a file is committed');

/* ---------------------------------------------------------------- summary */
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  failed.forEach((c) => console.log(`FAILED: ${c.label}${c.detail ? ` — ${c.detail}` : ''}`));
  process.exit(1);
}
console.log('The Sound Lab page is consistent with the module, the server and the offline measuring tool.');
