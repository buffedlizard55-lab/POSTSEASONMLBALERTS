#!/usr/bin/env node
/* ============================================================================
 * reviews-feed-test.mjs — deterministic tests for the all-games replay feed
 * diff helpers (buildEventKey / mergeFeedEvents / sortFeedEntries) in
 * assets/js/reviews-feed.js.
 *
 * Run: node tools/reviews-feed-test.mjs
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/js/reviews-feed.js', import.meta.url), 'utf8');

/* Controllable clock: identical to the real Date while clockOffsetMs is 0.
 * The audio-alert test advances it past the 2.5s cooldown deterministically. */
let clockOffsetMs = 0;
class FakeDate extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(Date.now() + clockOffsetMs);
  }
  static now() { return super.now() + clockOffsetMs; }
}

/* Recording stub for the Web Audio graph (filled in below, used by the
 * audio-alert section at the end of this file). */
const audioLog = {
  oscillators: [], sources: [], buffers: [], gains: [], edges: [], shapers: [],
  resumes: 0, ctx: null, decodes: [], playedSamples: [],
};

/* A controllable fetch for the real-recording path. `mode` decides what an
 * audio-asset request answers with, so both branches can be tested:
 *   'missing' — every candidate 404s (a fresh clone: no asset committed)
 *   'html'    — a host that answers unknown paths with a 200 HTML error page
 *   'audio'   — the asset is there and decodes
 */
const fakeNet = { mode: 'missing', requests: [], audioBytes: null, decoded: null };
/* NOTE: `new Uint8Array(Array.from(str))` is NOT the bytes of `str` — each
 * character coerces to NaN and becomes 0, which silently makes every
 * "is this an HTML error page?" check pass for the wrong reason. Encode by
 * code unit. */
function bytesOf(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}
function fakeFetch (url) {
  fakeNet.requests.push(String(url));
  if (fakeNet.mode === 'missing') return Promise.resolve({ ok: false, status: 404 });
  if (fakeNet.mode === 'html') {
    return Promise.resolve({
      ok: true, status: 200,
      // A real static host answers with its full index.html — well over the
      // 512-byte length guard, so only looksLikeHtml() can catch it.
      arrayBuffer: () => Promise.resolve(bytesOf(
        '<!DOCTYPE html><html lang="en"><head><title>Site</title></head><body>'
        + '<!-- '.padEnd(900, 'x') + '-->'
        + '<h1>404 page not found</h1></body></html>').buffer),
    });
  }
  return Promise.resolve({
    ok: true, status: 200,
    arrayBuffer: () => Promise.resolve(fakeNet.audioBytes),
  });
}

function stubAudioParam(events) {
  return {
    value: 0,
    setValueAtTime(v, t) { events.push({ kind: 'set', v, t }); },
    linearRampToValueAtTime(v, t) { events.push({ kind: 'lin', v, t }); },
    exponentialRampToValueAtTime(v, t) {
      // Real browsers throw on a zero target — catch that bug class here.
      assert.ok(v > 0, 'exponentialRampToValueAtTime target must be > 0 (0 throws in browsers)');
      events.push({ kind: 'exp', v, t });
    },
  };
}

function stubAudioNode(kind, extra = {}) {
  const node = {
    _kind: kind,
    ...extra,
    connect(to) { audioLog.edges.push([node, to]); return to; },
    disconnect() {},
  };
  return node;
}

class StubAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 100;
    this.sampleRate = 48000;
    this.destination = stubAudioNode('destination');
    audioLog.ctx = this;
  }
  resume() { audioLog.resumes += 1; return Promise.resolve(); }
  createGain() {
    const n = stubAudioNode('gain');
    n.gain = stubAudioParam((n._gainEvents = []));
    audioLog.gains.push(n);
    return n;
  }
  createBuffer(channels, length, sampleRate) {
    const buffer = {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData(channel) {
        assert.equal(channel, 0);
        return this.channelData;
      },
      channelData: new Float32Array(length),
    };
    audioLog.buffers.push(buffer);
    return buffer;
  }
  createBufferSource() {
    const n = stubAudioNode('bufferSource');
    n.buffer = null;
    n.start = (t) => { n.startedAt = t; audioLog.sources.push(n); };
    n.stop = (t) => { n.stoppedAt = t; };
    return n;
  }
  createOscillator() {
    const n = stubAudioNode('oscillator');
    n.type = null; // must be set explicitly by the code under test
    n.frequency = stubAudioParam((n._freqEvents = []));
    n.startedAt = null;
    n.stoppedAt = null;
    n.start = (t) => { n.startedAt = t; audioLog.oscillators.push(n); };
    n.stop = (t) => { n.stoppedAt = t; };
    return n;
  }
  createDelay() {
    const n = stubAudioNode('delay');
    n.delayTime = stubAudioParam((n._delayEvents = []));
    return n;
  }
  createBiquadFilter() {
    const n = stubAudioNode('filter', { type: null });
    n.frequency = stubAudioParam((n._freqEvents = []));
    n.Q = { value: 0 };
    return n;
  }
  createWaveShaper() {
    // Recorded so the tests can assert the master bus really ends in the
    // soft-clipper and that its curve is the designed one.
    const n = stubAudioNode('waveShaper', { curve: null, oversample: 'none' });
    audioLog.shapers.push(n);
    return n;
  }
  decodeAudioData(bytes, ok, fail) {
    audioLog.decodes.push({ bytes });
    if (fakeNet.decoded) {
      if (ok) ok(fakeNet.decoded);
      return Promise.resolve(fakeNet.decoded);
    }
    const err = new Error('undecodable');
    if (fail) fail(err);
    return Promise.reject(err);
  }
}

const context = {
  console: { warn() {}, error() {}, log() {} },
  Map, Set, Date: FakeDate, Math, Number, String, Object, Array, URLSearchParams, CSS: { escape: (s) => s },
  UI: { el: () => ({}), clear: () => ({}) },
  MLB: {},
  window: { AudioContext: StubAudioContext },
  fetch: fakeFetch,
  // The host's typed arrays: the module builds the soft-clip curve with
  // Float32Array, and a VM-private one would not be comparable to the host's.
  Float32Array, Float64Array, Uint8Array,
  document: { addEventListener() {}, removeEventListener() {}, querySelector: () => null },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  module: { exports: {} },
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'assets/js/reviews-feed.js' });

const {
  buildEventKey, mergeFeedEvents, reconcileScoreImpact, reviewChanged,
  sortFeedEntries, gameTeamsLabel,
  isUsableName, officialTeamName, gameSideTeam,
  pollIntervalMs, waitAfterScan, reviewFetchPriority, mapPool,
  shouldAlertForReview, visibleInAllFeed,
  runsRemovableFromReview, shouldRunRiskAlert, diffRunRiskKeys,
  normalizeChallengeCounts, challengeCountIrregularities,
  teamSideInGame, teamChallengeLine, gameChallengeLine,
} = context.module.exports;

/* ------------------------------------------------------- 1. Stable keys */

assert.equal(buildEventKey(823341, { id: 'play-34-main' }), '823341:play-34-main');
assert.equal(buildEventKey(823342, { id: 'play-15-ev-0' }), '823342:play-15-ev-0');
assert.equal(buildEventKey(823342, { id: 'live-active-review' }), '823342:live-active-review');
// Same at-bat id in different games must not collide.
assert.notEqual(buildEventKey(1, { id: 'play-1-main' }), buildEventKey(2, { id: 'play-1-main' }));

/* --------------------------------------------------- 2. First merge = add */

const state = { seen: new Map(), order: [] };
const mk = (id, typeKey, outcome, inProgress = false) => ({
  id, typeKey, reviewType: typeKey === 'abs' ? 'ABS Challenge' : 'Manager Challenge',
  outcome, outcomeLabel: outcome === 'overturned' ? 'Call Overturned' : 'Call Stands',
  inProgress, description: 'desc ' + id, timestamp: '2026-08-19T01:00:00Z',
});
const gamePk = 823341;

const first = mergeFeedEvents(state, gamePk, [mk('play-34-main', 'manager', 'overturned')]);
assert.equal(first.added.length, 1);
assert.equal(first.updated.length, 0);
assert.equal(first.ended.length, 0);
assert.equal(state.order.length, 1);

/* ------------------------------------------- 3. Same poll again = no-op */

const second = mergeFeedEvents(state, gamePk, [mk('play-34-main', 'manager', 'overturned')]);
assert.equal(second.added.length, 0);
assert.equal(second.updated.length, 0);
assert.equal(second.ended.length, 0);
assert.equal(state.order.length, 1, 'no duplicate keys');

/* ------------------------------------------- 4. Outcome change = update */

const third = mergeFeedEvents(state, gamePk, [
  mk('play-34-main', 'manager', 'overturned'),
  mk('play-40-ev-0', 'abs', 'stands', true), // was in progress
]);
assert.equal(third.added.length, 1);
assert.equal(third.updated.length, 0);
const fourth = mergeFeedEvents(state, gamePk, [
  mk('play-34-main', 'manager', 'overturned'),
  mk('play-40-ev-0', 'abs', 'stands', false), // now resolved
]);
assert.equal(fourth.added.length, 0);
assert.equal(fourth.updated.length, 1, 'in-progress -> resolved should mark updated');
assert.equal(fourth.updated[0].review.inProgress, false);

/* ----------------------- 4b. Observed score change across review resolution */

const riskImpact = {
  context: 'home_plate',
  scoringSide: 'away',
  runsCredited: 1,
  runsAtRisk: 1,
  runsAtRiskAtStart: 1,
  scoreAtReviewStart: { away: 6, home: 5 },
  possibleScoreAfterReview: { away: 5, home: 5 },
  officialScoreAfterReview: null,
  currentScore: { away: 6, home: 5 },
  possibleScoreIfRemoved: { away: 5, home: 5 },
  teamLabels: { away: 'NYY', home: 'BOS' },
};
const activeRisk = {
  ...mk('play-51-main', 'manager', 'in_progress', true),
  outcomeLabel: 'In Progress',
  reason: 'tag play at home',
  scoreImpact: riskImpact,
};
const activeTrackerState = { seen: new Map(), order: [] };
mergeFeedEvents(activeTrackerState, 98, [activeRisk]);
const repeatedActive = mergeFeedEvents(activeTrackerState, 98, [activeRisk]);
assert.equal(repeatedActive.updated.length, 0, 'unchanged active tracker poll is a no-op');

const activeRiskLaterPoll = reconcileScoreImpact(activeRisk, {
  ...activeRisk,
  scoreImpact: {
    ...riskImpact,
    scoreAtReviewStart: { away: 7, home: 5 },
    currentScore: { away: 7, home: 5 },
    possibleScoreAfterReview: { away: 6, home: 5 },
    possibleScoreIfRemoved: { away: 6, home: 5 },
  },
});
assert.equal(activeRiskLaterPoll.scoreImpact.scoreAtReviewStart.away, 6,
  'later active polls cannot rewrite the first observed score');
assert.equal(activeRiskLaterPoll.scoreImpact.possibleScoreAfterReview.away, 5,
  'the possible score remains paired with the first active snapshot');

const activeWithoutScenario = {
  ...activeRisk,
  scoreImpact: {
    ...riskImpact,
    runsCredited: 0,
    runsAtRisk: 0,
    runsAtRiskAtStart: 0,
    possibleScoreAfterReview: null,
    possibleScoreIfRemoved: null,
  },
};
const mismatchedLaterScenario = reconcileScoreImpact(activeWithoutScenario, {
  ...activeRisk,
  scoreImpact: {
    ...riskImpact,
    scoreAtReviewStart: { away: 7, home: 5 },
    currentScore: { away: 7, home: 5 },
    possibleScoreAfterReview: { away: 6, home: 5 },
    possibleScoreIfRemoved: { away: 6, home: 5 },
  },
});
assert.equal(mismatchedLaterScenario.scoreImpact.possibleScoreAfterReview, null,
  'a later scenario computed from a different score is not paired with the first snapshot');
assert.equal(mismatchedLaterScenario.scoreImpact.runsAtRiskAtStart, 0);
const enrichedSameScoreScenario = reconcileScoreImpact(activeWithoutScenario, activeRisk);
assert.equal(enrichedSameScoreScenario.scoreImpact.possibleScoreAfterReview.away, 5,
  'new runner details can add a scenario when its score still matches the first snapshot');
assert.equal(enrichedSameScoreScenario.scoreImpact.runsAtRiskAtStart, 1);

const finalRemoved = {
  ...mk('play-51-main', 'manager', 'overturned', false),
  reason: 'tag play at home',
  scoreImpact: {
    context: 'home_plate', scoringSide: 'away', runsCredited: 0, runsAtRisk: 0,
    runsAtRiskAtStart: 0,
    scoreAtReviewStart: null,
    possibleScoreAfterReview: null,
    officialScoreAfterReview: { away: 5, home: 5 },
    currentScore: { away: 5, home: 5 },
    possibleScoreIfRemoved: null,
    teamLabels: { away: 'NYY', home: 'BOS' },
  },
};
const scoreState = { seen: new Map(), order: [] };
mergeFeedEvents(scoreState, 99, [activeRisk]);
const resolvedScore = mergeFeedEvents(scoreState, 99, [finalRemoved]);
assert.equal(resolvedScore.updated.length, 1);
assert.equal(resolvedScore.updated[0].review.scoreImpact.actualRunsRemoved, 1,
  '6-5 active score -> 5-5 resolved score records one observed run removal');
assert.equal(resolvedScore.updated[0].review.scoreImpact.scoreBeforeReview.away, 6);
assert.equal(resolvedScore.updated[0].review.scoreImpact.scoreAfterReview.away, 5);
assert.equal(resolvedScore.updated[0].review.scoreImpact.scoreAtReviewStart.away, 6,
  'before-review snapshot is the call-on-field score first observed');
assert.equal(resolvedScore.updated[0].review.scoreImpact.possibleScoreAfterReview.away, 5,
  'conditional score survives resolution');
assert.equal(resolvedScore.updated[0].review.scoreImpact.runsAtRiskAtStart, 1,
  'the scenario retains how many credited runs were originally at risk');
assert.equal(resolvedScore.updated[0].review.scoreImpact.officialScoreAfterReview.away, 5,
  'actual-after snapshot comes from the resolved play');
const repeatedFinal = mergeFeedEvents(scoreState, 99, [finalRemoved]);
assert.equal(repeatedFinal.updated.length, 0, 'unchanged final poll is a no-op');
assert.equal(scoreState.seen.get('99:play-51-main').review.scoreImpact.actualRunsRemoved, 1,
  'observed removal persists after later final-only payloads');

const finalOnlyState = { seen: new Map(), order: [] };
mergeFeedEvents(finalOnlyState, 100, [finalRemoved]);
mergeFeedEvents(finalOnlyState, 100, [finalRemoved]);
assert.equal(finalOnlyState.seen.get('100:play-51-main').review.scoreImpact.scoreAtReviewStart, null,
  'repeated final-only polls never back-fill Before review from the final score');
assert.equal(finalOnlyState.seen.get('100:play-51-main').review.scoreImpact.officialScoreAfterReview.away, 5);

const missingStartState = { seen: new Map(), order: [] };
const activeWithoutScore = {
  ...activeRisk,
  id: 'play-52-main',
  scoreImpact: {
    ...activeWithoutScenario.scoreImpact,
    activeReviewObserved: true,
    scoreAtReviewStart: null,
    currentScore: null,
  },
};
const finalAfterMissingStart = {
  ...finalRemoved,
  id: 'play-52-main',
  scoreImpact: {
    ...finalRemoved.scoreImpact,
    activeReviewObserved: false,
    officialScoreAfterReview: { away: 5, home: 5 },
    currentScore: { away: 5, home: 5 },
  },
};
mergeFeedEvents(missingStartState, 102, [activeWithoutScore]);
mergeFeedEvents(missingStartState, 102, [finalAfterMissingStart]);
const repeatedMissingStartFinal = mergeFeedEvents(missingStartState, 102, [finalAfterMissingStart]);
const missingStartImpact = missingStartState.seen.get('102:play-52-main').review.scoreImpact;
assert.equal(repeatedMissingStartFinal.updated.length, 0);
assert.equal(missingStartImpact.activeReviewObserved, true,
  'later final polls remember that an active payload was seen even when its score was incomplete');
assert.equal(missingStartImpact.scoreAtReviewStart, null);
assert.equal(missingStartImpact.officialScoreAfterReview.away, 5);

const aliasState = { seen: new Map(), order: [] };
const syntheticActiveRisk = { ...activeRisk, id: 'live-active-review', atBatIndex: 51 };
const resolvedAliasRisk = { ...finalRemoved, atBatIndex: 51 };
mergeFeedEvents(aliasState, 101, [syntheticActiveRisk]);
const aliasedResolution = mergeFeedEvents(aliasState, 101, [resolvedAliasRisk]);
assert.equal(aliasedResolution.added.length, 0,
  'a resolved play id replaces its matching status-only active id instead of duplicating it');
assert.equal(aliasedResolution.updated.length, 1);
assert.equal(aliasedResolution.ended.length, 0);
assert.equal(aliasState.seen.has('101:live-active-review'), false);
assert.equal(aliasState.seen.get('101:play-51-main').review.scoreImpact.scoreAtReviewStart.away, 6);
assert.equal(aliasState.seen.get('101:play-51-main').review.scoreImpact.officialScoreAfterReview.away, 5);

const finalRetained = {
  ...finalRemoved,
  outcome: 'stands',
  outcomeLabel: 'Call Stands',
  scoreImpact: {
    ...finalRemoved.scoreImpact,
    officialScoreAfterReview: { away: 6, home: 5 },
    currentScore: { away: 6, home: 5 },
  },
};
const retained = reconcileScoreImpact(activeRisk, finalRetained);
assert.equal(retained.scoreImpact.runsRetained, 1,
  'unchanged official score records that the observed at-risk run remained');
assert.equal(retained.scoreImpact.actualRunsRemoved, undefined);

const activeBoundaryPending = {
  ...activeRisk,
  scoreImpact: {
    context: 'boundary', scoringSide: 'home', runsCredited: 0, runsAtRisk: 0,
    currentScore: { away: 3, home: 3 }, teamLabels: { away: 'NYY', home: 'BAL' },
  },
};
const finalBoundaryAdded = reconcileScoreImpact(activeBoundaryPending, {
  ...finalRemoved,
  scoreImpact: {
    context: 'boundary', scoringSide: 'home', runsCredited: 1, runsAtRisk: 0,
    currentScore: { away: 3, home: 4 }, teamLabels: { away: 'NYY', home: 'BAL' },
  },
});
assert.equal(finalBoundaryAdded.scoreImpact.actualRunsAdded, 1,
  '3-3 boundary review -> 3-4 resolution records one observed added run');

const opponentAlsoMoved = reconcileScoreImpact(activeRisk, {
  ...finalRemoved,
  scoreImpact: {
    ...finalRemoved.scoreImpact,
    officialScoreAfterReview: { away: 5, home: 6 },
    currentScore: { away: 5, home: 6 },
  },
});
assert.equal(opponentAlsoMoved.scoreImpact.actualRunsRemoved, undefined,
  'do not attribute a score transition when the other team score also changed');

const sameOutcomeNewImpact = {
  ...activeRisk,
  scoreImpact: { ...riskImpact, runsAtRisk: 2 },
};
assert.equal(reviewChanged(activeRisk, sameOutcomeNewImpact), true,
  'new score-impact data updates a row even while outcome remains in progress');

/* ------------------------------------------- 5. Gone key = ended (synthetic) */

const fifth = mergeFeedEvents(state, gamePk, [mk('play-34-main', 'manager', 'overturned')]);
assert.equal(fifth.ended.length, 1, 'synthesized live-active-review entry should end when gone');
assert.equal(state.order.length, 1);

/* ------------------------------------------- 6. Multi-game isolation */

const state2 = { seen: new Map(), order: [] };
mergeFeedEvents(state2, 823341, [mk('play-34-main', 'manager', 'overturned')]);
const other = mergeFeedEvents(state2, 823342, [mk('play-15-ev-0', 'abs', 'stands')]);
assert.equal(other.added.length, 1);
assert.equal(other.ended.length, 0, 'clearing one game must not touch another game');

/* ------------------------------------------- 7. Sort newest-first */

const entries = [
  { gamePk: 1, review: { timestamp: '2026-08-19T03:00:00Z' }, firstSeen: 1 },
  { gamePk: 2, review: { timestamp: null }, firstSeen: 5 },
  { gamePk: 3, review: { timestamp: '2026-08-19T02:00:00Z' }, firstSeen: 3 },
];
const sorted = sortFeedEntries(entries);
assert.equal(sorted[0].gamePk, 1, 'real timestamp wins');
assert.equal(sorted[1].gamePk, 3, 'second by timestamp');
assert.equal(sorted[2].gamePk, 2, 'no timestamp falls back to firstSeen');

/* --------------------------- 8. Official team names, never "undefined" */

// REAL schedule shape (verified live on statsapi.mlb.com, 2026-08-19):
// teams.*.team carries ONLY { id, name, link } — there is no `abbreviation`.
// The old renderer interpolated `${team.abbreviation}` here and printed
// "undefined @ undefined" on every feed row and active-strip item.
const schedGame = {
  gamePk: 823342,
  season: '2026',
  teams: {
    away: { team: { id: 116, name: 'Detroit Tigers', link: '/api/v1/teams/116' } },
    home: { team: { id: 134, name: 'Pittsburgh Pirates', link: '/api/v1/teams/134' } },
  },
};
// Official directory as returned by MLB.getTeams() (GET /api/v1/teams).
const directory = {
  116: { id: 116, name: 'Detroit Tigers', abbreviation: 'DET', teamName: 'Tigers' },
  134: { id: 134, name: 'Pittsburgh Pirates', abbreviation: 'PIT', teamName: 'Pirates' },
};

const label = gameTeamsLabel(schedGame, directory);
assert.equal(label, 'Detroit Tigers @ Pittsburgh Pirates');
assert.ok(!label.includes('undefined'), 'row headline must never contain "undefined"');

// Directory empty (its request failed): official full names still come from
// the schedule itself — the label must be identical, not degraded.
assert.equal(gameTeamsLabel(schedGame, {}), 'Detroit Tigers @ Pittsburgh Pirates');

// Missing team objects entirely -> explicit placeholders, never "undefined".
assert.equal(gameTeamsLabel({}, directory), 'AWY @ HOM');
assert.equal(gameTeamsLabel({ teams: {} }, directory), 'AWY @ HOM');

// Degenerate schedule entry with no name: fall back to the official
// directory name, then its abbreviation, then the placeholder — in order.
const noNames = { teams: { away: { team: { id: 116 } }, home: { team: { id: 134 } } } };
assert.equal(gameTeamsLabel(noNames, directory), 'Detroit Tigers @ Pittsburgh Pirates');
const abbrevOnly = { 116: { id: 116, name: null, abbreviation: 'DET' } };
assert.equal(gameTeamsLabel(noNames, abbrevOnly), 'DET @ HOM');
assert.equal(gameTeamsLabel(noNames, {}), 'AWY @ HOM');

// Literal "undefined" / "null" strings must never print.
assert.equal(isUsableName('undefined'), false);
assert.equal(isUsableName('null'), false);
assert.equal(isUsableName(''), false);
assert.equal(isUsableName(undefined), false);
assert.equal(isUsableName('Detroit Tigers'), true);
const poisoned = {
  teams: {
    away: { team: { id: 116, name: 'undefined' } },
    home: { team: { id: 134, name: 'null' } },
  },
};
assert.equal(gameTeamsLabel(poisoned, directory), 'Detroit Tigers @ Pittsburgh Pirates');
assert.ok(!gameTeamsLabel(poisoned, directory).includes('undefined'));
assert.ok(!gameTeamsLabel(poisoned, {}).includes('undefined'));
assert.equal(gameTeamsLabel(poisoned, {}), 'AWY @ HOM');

// Flattened side object (no nested .team) still resolves a name.
const flat = {
  teams: {
    away: { id: 116, name: 'Detroit Tigers' },
    home: { id: 134, locationName: 'Pittsburgh', teamName: 'Pirates' },
  },
};
assert.equal(gameSideTeam(flat, 'away').name, 'Detroit Tigers');
assert.equal(gameTeamsLabel(flat, {}), 'Detroit Tigers @ Pittsburgh Pirates');
assert.equal(officialTeamName({ id: 116 }, directory, 'AWY'), 'Detroit Tigers');

/* --------------------------- 9. Poll cadence helpers (no invented delays) */

assert.equal(pollIntervalMs({ hasLive: false, hasActiveReview: false, liveMs: 2000, reviewMs: 1000, idleMs: 15000 }), 15000);
assert.equal(pollIntervalMs({ hasLive: true, hasActiveReview: false, liveMs: 2000, reviewMs: 1000, idleMs: 15000 }), 2000);
assert.equal(pollIntervalMs({ hasLive: true, hasActiveReview: true, liveMs: 2000, reviewMs: 1000, idleMs: 15000 }), 1000);
assert.equal(pollIntervalMs({ hasLive: false, hasActiveReview: true, liveMs: 2000, reviewMs: 1000, idleMs: 15000 }), 1000,
  'an in-progress review still uses the review cadence even if the slate is no longer Live');

assert.equal(waitAfterScan(2000, 0), 2000);
assert.equal(waitAfterScan(2000, 800), 1200, 'scan time is subtracted from the cycle');
assert.equal(waitAfterScan(2000, 2500), 0, 'over-budget scan waits 0, never negative');
assert.equal(waitAfterScan(2000, -5), 2000, 'negative elapsed is ignored, not invented');
assert.equal(waitAfterScan(NaN, 100), 0);
assert.equal(waitAfterScan(-10, 0), 0);

assert.equal(reviewFetchPriority({ status: { detailedState: 'Manager Challenge', abstractGameState: 'Live' } }, false), 0);
assert.equal(reviewFetchPriority({ status: { detailedState: 'In Progress', abstractGameState: 'Live' } }, true), 0);
assert.equal(reviewFetchPriority({ status: { detailedState: 'In Progress', abstractGameState: 'Live' } }, false), 1);
assert.equal(reviewFetchPriority({ status: { detailedState: 'Final', abstractGameState: 'Final' } }, false), 2);
// "In Progress" must NOT match /review/ — that would falsely prioritize every live game.
assert.equal(reviewFetchPriority({ status: { detailedState: 'In Progress', abstractGameState: 'Live' } }, false), 1);

const seen = [];
await mapPool(['a', 'b', 'c', 'd'], 2, async (item) => { seen.push(item); });
assert.deepEqual(seen.slice().sort(), ['a', 'b', 'c', 'd'], 'mapPool visits every item');
await mapPool([], 4, async () => { throw new Error('must not run on empty'); });

/* ----------------------------- 10. Alert gating (which events make sound) */

// POSTSEASON BUILD — every tracked category alerts, ABS pitch challenges
// INCLUDED (the upstream regular-season build silenced routine ABS challenges).
assert.equal(shouldAlertForReview({ typeKey: 'abs' }), true);
// …and every other observed review typeKey alerts too.
assert.equal(shouldAlertForReview({ typeKey: 'manager' }), true);
assert.equal(shouldAlertForReview({ typeKey: 'crew_chief' }), true);
assert.equal(shouldAlertForReview({ typeKey: 'boundary' }), true);
assert.equal(shouldAlertForReview({ typeKey: 'review' }), true);
assert.equal(shouldAlertForReview({ typeKey: 'rules' }), true);
// Defensive: junk input never alerts.
assert.equal(shouldAlertForReview(null), false);
assert.equal(shouldAlertForReview({}), false);
assert.equal(shouldAlertForReview({ typeKey: 42 }), false);

/* ------------------------ 10b. All-section visibility (the complete feed)
 *
 * POSTSEASON BUILD — the All section shows EVERY tracked category: challenges,
 * reviews, boundary calls, under-review status, run-at-risk entries AND ABS
 * pitch challenges (the upstream regular-season build sectioned ABS out of
 * All to keep it readable). The ABS tab / stat / counters remain alongside
 * the complete All feed. This gate is independent of alerting (§10).
 */

// The category the upstream build excluded is now INCLUDED: ABS (code "MJ").
assert.equal(visibleInAllFeed({ typeKey: 'abs' }), true);
// Every other observed review typeKey belongs in All as well…
['manager', 'crew_chief', 'boundary', 'review', 'rules'].forEach((typeKey) => {
  assert.equal(visibleInAllFeed({ typeKey }), true, `${typeKey} must stay in the All section`);
});
// …including when flagged run-at-risk or under review.
assert.equal(visibleInAllFeed({ typeKey: 'manager', inProgress: true }), true);
assert.equal(visibleInAllFeed({ typeKey: 'abs', inProgress: true }), true);
// Defensive: unknown / malformed entries fail OPEN — an unrecognized event
// must never be silently hidden from the main feed.
assert.equal(visibleInAllFeed(null), true);
assert.equal(visibleInAllFeed(undefined), true);
assert.equal(visibleInAllFeed({}), true);
assert.equal(visibleInAllFeed({ typeKey: 42 }), true);

/* ---------------------- 11. Audio alert is a cash-register cha-ching
 *
 * Drives window.ReplayFeed against a recording AudioContext stub and verifies
 * the real sound graph against the alert's own design data (ALERT_SOUND): the
 * key clack, gear clicks and ratchet that make the "cha", the inharmonic metal
 * bell struck ONCE that makes the "ching", the drawer that keeps moving after
 * it, the ~2-second master envelope, silence while muted, and the unchanged
 * cooldown / suspended-context behaviour.
 *
 * Nothing here is a hard-coded node count: the expected graph is derived from
 * ALERT_SOUND, so the test fails if the design data and the builder drift.
 */

const ReplayFeed = context.window.ReplayFeed;
assert.ok(ReplayFeed, 'window.ReplayFeed API is exported');

const SPEC = ReplayFeed.alertSoundSpec;
assert.ok(SPEC, 'the alert sound design data is exported for verification');
assert.equal(context.module.exports.ALERT_SOUND, SPEC, 'Node export exposes the same design data');

// What the design says the graph must contain.
const BELL_STRIKES = SPEC.bellStrikes.length;
const BELL_PARTIALS = SPEC.bellPartials.length;
const THUMPS = [SPEC.leverBody, SPEC.drawerStop];
const THUMP_TONES = THUMPS.reduce((n, t) => n + t.tones.length, 0);
const BEDS = SPEC.beds.length;
const NOISE_SOURCES = 1                                          // the key clack
  + SPEC.gearClicks.length                                       // the gear-click train
  + BEDS                                                         // the mechanism beds
  + 1                                                            // the drawer slide
  + BELL_STRIKES                                                 // one hammer tick per strike
  + 1;                                                           // the drawer-stop click
const EXPECTED_OSCILLATORS = BELL_STRIKES * BELL_PARTIALS + THUMP_TONES;

// 11a. Disabled by default (no localStorage in this VM): nothing plays.
assert.equal(ReplayFeed.getSoundEnabled(), false);
ReplayFeed.playAlertSound();
assert.equal(audioLog.oscillators.length, 0, 'no sound while the toggle is off');
assert.equal(audioLog.sources.length, 0, 'no mechanical noise while the toggle is off');

// 11b. Enabling plays exactly one preview alert (the user-gesture path).
ReplayFeed.setSoundEnabled(true);
assert.equal(ReplayFeed.getSoundEnabled(), true);
const previewCount = audioLog.oscillators.length;
const previewSources = audioLog.sources.length;
assert.equal(previewCount, EXPECTED_OSCILLATORS,
  `${BELL_STRIKES} bell strike(s) x ${BELL_PARTIALS} partials plus ${THUMP_TONES} thud tones`);
assert.equal(previewSources, NOISE_SOURCES, 'every mechanical noise layer is scheduled');

// 11c. The "cha": every mechanical layer is a short band-passed noise burst or
// a swept noise band, the key lands first, and the whole mechanism is still
// running when the bell is struck. The mechanism is deliberately LOUD — in
// every reference recording the "cha" is level with the bell, and burying it
// is what made the previous build sound like a plain chime.
assert.equal(audioLog.buffers.length, NOISE_SOURCES, 'each mechanical layer owns its own noise buffer');
audioLog.sources.forEach((source) => {
  assert.equal(source._kind, 'bufferSource');
  assert.ok(source.buffer.length > 0, 'each mechanical sound has an audio buffer');
  assert.ok(source.buffer.channelData.some((sample) => sample !== 0), 'noise buffer is non-silent');
  const filter = audioLog.edges.find(([node]) => node === source)?.[1];
  assert.equal(filter?.type, 'bandpass', 'mechanical noise is band-pass filtered');
  assert.ok(source.stoppedAt === undefined, 'buffer sources are not force-stopped early');
});
const struck = 100 + SPEC.bellStrikes[0].at;
assert.equal(audioLog.sources[0].startedAt, 100 + SPEC.keyClack.at, 'the key clack fires first');
assert.ok(audioLog.sources[0].startedAt < struck, 'the key is down before the bell rings');
SPEC.gearClicks.forEach((click, index) => {
  assert.equal(audioLog.sources[1 + index].startedAt, 100 + click.at,
    'gear click ' + (index + 1) + ' fires at its designed time');
  assert.ok(audioLog.sources[1 + index].startedAt < struck, 'the gear train runs before the bell');
});
const bedIndex = 1 + SPEC.gearClicks.length;
SPEC.beds.forEach((bed, i) => {
  assert.equal(audioLog.sources[bedIndex + i].startedAt, 100 + bed.at,
    `the "${bed.name}" mechanism bed runs under the clicks`);
  assert.ok(audioLog.sources[bedIndex + i].startedAt < struck,
    `the "${bed.name}" bed is running before the bell is struck`);
});
const drawerIndex = bedIndex + BEDS;
assert.equal(audioLog.sources[drawerIndex].startedAt, 100 + SPEC.drawerSlide.at,
  'the drawer starts rolling while the mechanism is still running');
assert.ok(audioLog.sources[drawerIndex].startedAt < struck, 'the drawer opens across the bell, not before it');
SPEC.bellStrikes.forEach((strike, index) => {
  const tick = audioLog.sources[drawerIndex + 1 + index];
  assert.equal(tick.startedAt, 100 + strike.at - SPEC.hammerTick.lead,
    'the hammer tick lands just before the strike');
});
assert.equal(audioLog.sources[drawerIndex + 1 + BELL_STRIKES].startedAt, 100 + SPEC.drawerStop.at,
  'the drawer-stop thud fires after the bell, as it does in real recordings');
// Every swept noise band (each mechanism bed, and the drawer) ramps downward.
const sweeps = audioLog.edges
  .map(([, target]) => target)
  .filter((node) => node._kind === 'filter' && node._freqEvents.length >= 2);
assert.equal(sweeps.length, BEDS + 1,
  `${BEDS} mechanism beds plus the drawer slide are swept filters`);
[...SPEC.beds, SPEC.drawerSlide].forEach((spec) => {
  assert.ok(spec.toCentre < spec.fromCentre, 'every swept band really descends');
});
sweeps.forEach((node) => {
  const events = node._freqEvents;
  const lo = Math.min(events[0].v, events[events.length - 1].v);
  const hi = Math.max(events[0].v, events[events.length - 1].v);
  const matches = [...SPEC.beds, SPEC.drawerSlide].some((spec) =>
    Math.abs(hi - spec.fromCentre) < 1e-6 && Math.abs(lo - spec.toCentre) < 1e-6);
  assert.ok(matches, 'each swept filter runs from its designed high centre down to its low centre');
});

// 11c-bis. The "cha" is a MECHANISM that runs, not a burst of noise that
// decays. Measured from real recordings, the envelope of the "cha" ramps up
// over ~45 ms and then HOLDS a plateau at -6 to -9 dB until the bell is
// struck; the replaced build peaked at once and decayed, which is why it
// sounded like a hiss and measured 2 attacks instead of 3.
//
// Two things produce that plateau here, and both are asserted:
//   (a) each bed's own buffer is chopped into uneven bursts (`rattle`), and
//   (b) each bed's gain envelope is a staircase that rises, holds, then gives
//       way sharply just before the strike so the bell's arrival is an event.
// tools/render-alert-sound.mjs measures the combined result on rendered PCM
// against the reference recording (plateau p95-p50 1.20 dB vs the reference's
// 1.06 dB, plateau p50 -8.2 dB vs -7.2 dB); this test pins the design that
// produces it, so a spec edit cannot quietly undo it.
SPEC.beds.forEach((bed) => {
  assert.ok(bed.rattle > 0.2,
    `the "${bed.name}" bed is chopped into bursts (a rattle), not left smooth`);
  assert.ok(Array.isArray(bed.envelope) && bed.envelope.length >= 8,
    `the "${bed.name}" bed has a shaped staircase envelope, not a bare attack-and-fade`);

  const strike = SPEC.bellStrikes[0].at - bed.at;   // strike time in bed-local seconds
  assert.ok(strike > 0.1, `the "${bed.name}" bed is still running when the bell is struck`);

  const peak = bed.envelope.reduce((a, b) => (b[1] > a[1] ? b : a));
  assert.ok(peak[0] >= 0.03,
    `the "${bed.name}" bed ramps up to its peak over ${(peak[0] * 1000).toFixed(0)} ms instead of starting at it`);

  // (a) The rise is a STAIRCASE: several distinct levels on the way up, which
  // is what makes the attack read as parts of a machine engaging in sequence.
  const riseLevels = new Set(bed.envelope.filter(([t]) => t <= peak[0]).map(([, v]) => v));
  assert.ok(riseLevels.size >= 4,
    `the "${bed.name}" bed rises in ${riseLevels.size} distinct steps (references: 4+)`);

  // (b) It HOLDS the plateau from the peak to just before the strike. A bed
  // that decays through the plateau is the replaced build's defect.
  const held = bed.envelope.filter(([t]) => t >= peak[0] && t <= strike - 0.02);
  assert.ok(held.length >= 1, `the "${bed.name}" bed holds its plateau up to the strike`);
  held.forEach(([t, v]) => {
    assert.ok(v >= 0.8 * peak[1],
      `the "${bed.name}" bed holds at ${(20 * Math.log10(v / peak[1])).toFixed(1)} dB below its peak at t=${t} s`);
  });
  assert.ok(strike - held[held.length - 1][0] <= 0.05,
    `the "${bed.name}" plateau really extends to the strike, not just past the attack`);

  // (c) It GIVES WAY just before the strike. If the mechanism is still at full
  // level when the bell lands, the bell has no arrival and the "CHING" is
  // masked; the drop is what makes the strike audible as an event.
  const giveWay = bed.envelope.find(([t, v]) => t > strike - 0.02 && t <= strike + 0.01 && v < 0.5 * peak[1]);
  assert.ok(giveWay,
    `the "${bed.name}" bed drops away at the strike (t=${giveWay ? giveWay[0] : 'never'} s)`);

  const last = bed.envelope[bed.envelope.length - 1];
  assert.ok(last[1] < 0.01, `the "${bed.name}" bed's envelope ends in silence`);
});

// The buffers themselves are modulated, not smooth white noise. Measured at
// 1.1 ms windows (200 divisions of the buffer): the bright bed's relative sd
// is 0.152 with a 1.94x loudest/quietest ratio, the body bed's is 0.081 with
// 1.50x. The bright bed carries the rattle, so it must be the more uneven.
function bufferModulation(channelData, divisions) {
  const CHUNK = Math.max(1, Math.floor(channelData.length / divisions));
  const levels = [];
  for (let i = 0; i + CHUNK <= channelData.length; i += CHUNK) {
    let sum = 0;
    for (let k = i; k < i + CHUNK; k++) sum += channelData[k] * channelData[k];
    levels.push(Math.sqrt(sum / CHUNK));
  }
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const sd = Math.sqrt(levels.reduce((a, v) => a + (v - mean) ** 2, 0) / levels.length) / mean;
  return { sd, ratio: Math.max(...levels) / Math.max(1e-12, Math.min(...levels)) };
}
const brightBed = SPEC.beds.find((bed) => bed.fromCentre > 4000);
assert.ok(brightBed, 'one mechanism bed is the bright rattle (above 4 kHz)');
assert.ok(brightBed.toCentre > 2000, 'the bright bed stays bright all the way down its sweep');
const bodyBed = SPEC.beds.find((bed) => bed.fromCentre < 2500);
assert.ok(bodyBed, 'a second mechanism bed carries the low-mid body of the machine');
assert.ok(bodyBed.toCentre > 400 && bodyBed.fromCentre < 2500,
  'the body bed covers the 700-1600 Hz band the broadband check measures');
[[brightBed, 0.10, 1.4], [bodyBed, 0.05, 1.2]].forEach(([bed, minSd, minRatio]) => {
  const mod = bufferModulation(audioLog.sources[bedIndex + SPEC.beds.indexOf(bed)].buffer.channelData, 200);
  assert.ok(mod.sd > minSd,
    `the "${bed.name}" bed's noise really is modulated (relative sd ${mod.sd.toFixed(3)} > ${minSd})`);
  assert.ok(mod.ratio > minRatio,
    `the "${bed.name}" bed has loud bursts and quiet gaps (${mod.ratio.toFixed(2)}x > ${minRatio}x)`);
});
// The bright bed must be the more uneven of the two — it is the rattle.
const brightMod = bufferModulation(audioLog.sources[bedIndex + SPEC.beds.indexOf(brightBed)].buffer.channelData, 200);
const bodyMod = bufferModulation(audioLog.sources[bedIndex + SPEC.beds.indexOf(bodyBed)].buffer.channelData, 200);
assert.ok(brightMod.sd > bodyMod.sd, 'the bright bed rattles more than the body bed');
assert.ok(SPEC.drawerSlide.toCentre > 400, 'the drawer sweep does not drag the "cha" into a rumble');

// 11d. The "ching": every bell partial is a sine at fundamental x ratio; the
// prime decays with the measured 0.219 s time constant (a struck bell, not a
// sustained tone); the low body partials outlast the prime and the bright
// metallic ones die before it — that spread is what reads as metal.
const bellOscillators = audioLog.oscillators.filter((osc) => osc.type === 'sine');
assert.equal(bellOscillators.length, BELL_STRIKES * BELL_PARTIALS,
  'the bell graph is ' + BELL_STRIKES + ' strike(s) x ' + BELL_PARTIALS + ' partials');
const expectedFrequencies = [];
SPEC.bellStrikes.forEach(() => SPEC.bellPartials.forEach((p) => {
  expectedFrequencies.push(SPEC.bellFundamental * p.ratio);
}));
assert.deepEqual(
  bellOscillators.map((osc) => osc.frequency.value).sort((a, b) => a - b),
  expectedFrequencies.slice().sort((a, b) => a - b),
  'every bell partial sits at fundamental x ratio');
const upperRatios = SPEC.bellPartials.map((partial) => partial.ratio).filter((ratio) => ratio > 1);
assert.ok(upperRatios.every((ratio) => Math.abs(ratio - Math.round(ratio)) > 1e-6),
  'no upper partial is an exact harmonic (a metal bell is not a harmonic series)');
const decayOf = (osc) => {
  const gain = audioLog.edges.find(([src]) => src === osc)?.[1];
  return Math.max(...gain._gainEvents.map((event) => event.t));
};
// Group partials by strike (same start time) and check decay order per strike.
// Partials of one strike no longer share an exact start time: twelve sine
// oscillators all starting at phase 0 sum into one spike, so each partial is
// offset by `phase * bellPhaseSpread` (a real hammer does not phase-lock a
// bell's modes). Group them by strike within that spread instead.
const SPREAD = SPEC.bellPhaseSpread || 0;
assert.ok(SPREAD > 0 && SPREAD <= 0.004,
  'the partials are decorrelated by a sub-audible spread, not by an audible one');
const byStart = new Map();
bellOscillators.forEach((osc) => {
  const idx = SPEC.bellStrikes.findIndex((strike) =>
    osc.startedAt >= 100 + strike.at - 1e-9 &&
    osc.startedAt <= 100 + strike.at + SPREAD + 1e-9);
  assert.ok(idx >= 0, 'every bell partial belongs to a designed strike');
  if (!byStart.has(idx)) byStart.set(idx, []);
  byStart.get(idx).push(osc);
});
assert.equal(byStart.size, BELL_STRIKES, 'the bell is struck exactly ' + BELL_STRIKES + ' time(s)');
// The offsets must actually differ, or the decorrelation is a no-op.
const starts = new Set(bellOscillators.map((osc) => osc.startedAt.toFixed(6)));
assert.ok(starts.size >= Math.min(BELL_PARTIALS, 6),
  `the ${BELL_PARTIALS} partials are spread over ${starts.size} distinct start times`);

// The measured shape: tau falls as the partial rises. The prime's own time
// constant is bounded rather than pinned. A real register bell was measured at
// 0.219 s; the design holds 0.33 s so the ring carries the 1-2 s alert that was
// asked for (the reference file cuts off at 1.08 s with the bell still going).
// The band keeps it from drifting into a sustained tone above or a tick below.
const primePartial = SPEC.bellPartials.find((p) => p.ratio === 1);
assert.ok(primePartial, 'the design names a prime partial');
assert.ok(primePartial.tau >= 0.20 && primePartial.tau <= 0.34,
  `the prime rings for ${primePartial.tau} s: long enough to carry the alert, short enough to be a strike`);
const byRatio = SPEC.bellPartials.slice().sort((a, b) => a.ratio - b.ratio);
for (let i = 1; i < byRatio.length; i++) {
  assert.ok(byRatio[i].tau <= byRatio[i - 1].tau + 1e-9,
    `partial ${byRatio[i].ratio}x decays no slower than ${byRatio[i - 1].ratio}x (higher partials die first)`);
}
assert.ok(byRatio[0].tau > primePartial.tau,
  'the lowest body partial outlasts the prime, which is what carries the tail');
const brightest = byRatio[byRatio.length - 1];
assert.ok(brightest.tau < primePartial.tau, 'the top metallic partial dies before the prime');

byStart.forEach((group) => {
  assert.equal(group.length, BELL_PARTIALS, 'each strike excites every partial');
  const ordered = group.slice().sort((a, b) => a.frequency.value - b.frequency.value);
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(decayOf(ordered[i]) <= decayOf(ordered[i - 1]) + SPREAD + 1e-9,
      'in the built graph, each higher partial stops no later than the one below it');
  }
  ordered.forEach((osc) => {
    const gain = audioLog.edges.find(([src]) => src === osc)[1];
    const events = gain._gainEvents;
    const kinds = events.map((event) => event.kind).join(',');
    assert.ok(kinds.includes('lin') && kinds.includes('exp'), 'partials attack then decay exponentially');
    const peaks = events.filter((event) => event.kind === 'lin').map((event) => event.v);
    assert.ok(Math.max(...peaks) > 0, 'partial has a positive attack level');
  });
});
// One strike only: "cha-CHING", not "ching-ching".
assert.equal(SPEC.bellStrikes.length, 1, 'the bell is struck once');
const tickBefore = SPEC.bellStrikes.every((strike) => {
  const tickTime = strike.at - SPEC.hammerTick.lead;
  return audioLog.sources.some((src) => Math.abs(src.startedAt - (100 + tickTime)) < 1e-6);
});
assert.ok(tickBefore, 'every bell strike has its hammer tick just before it');

// 11e. The master envelope runs the designed length (about two seconds), never
// props the sound up past the hold point, and fades to silence.
// The master bus ends in the soft-clipper, so the destination edge comes from
// the WaveShaper and the master gain is the node feeding it.
const shaper = audioLog.shapers[audioLog.shapers.length - 1];
assert.ok(shaper, 'the master bus ends in a WaveShaper soft-clipper');
assert.ok(audioLog.edges.some(([src, dst]) => src === shaper && dst._kind === 'destination'),
  'the soft-clipper is what is wired to the audio destination');
const masterEdge = audioLog.edges.find(([src, dst]) => dst === shaper);
assert.ok(masterEdge && masterEdge[0]._kind === 'gain', 'the master gain feeds the soft-clipper');
const masterEvents = masterEdge[0]._gainEvents;
// The curve itself: it must be the designed one, must be antisymmetric and
// monotonic (a folded curve adds distortion and DC), and its largest output
// must be the ceiling — which is what makes clipping impossible.
const curve = shaper.curve;
assert.ok(curve instanceof Float32Array, 'the soft-clip curve is a Float32Array');
assert.equal(curve.length, SPEC.softClip.curveSize, 'the curve is the designed size');
assert.equal(shaper.oversample, SPEC.softClip.oversample, 'the soft-clipper oversamples as designed');
const mid = (curve.length - 1) / 2;
assert.ok(Math.abs(curve[mid]) < 1e-6, 'the curve passes through zero (no DC offset)');
let maxAbs = 0, monotonic = true, antisym = true;
for (let i = 0; i < curve.length; i++) {
  maxAbs = Math.max(maxAbs, Math.abs(curve[i]));
  if (i > 0 && curve[i] < curve[i - 1] - 1e-9) monotonic = false;
}
for (let i = 0; i <= mid; i++) if (Math.abs(curve[curve.length - 1 - i] + curve[i]) > 1e-5) antisym = false;
assert.ok(monotonic, 'the curve saturates instead of folding back');
assert.ok(antisym, 'the curve is antisymmetric (no even harmonics, no DC)');
assert.ok(Math.abs(maxAbs - SPEC.softClip.ceiling) < 1e-4,
  'the curve cannot output more than its ceiling, so the alert cannot clip');
assert.ok(SPEC.softClip.ceiling < 0.99, 'that ceiling is below full scale');
const masterEnd = masterEvents.find((event) => event.kind === 'lin' && event.v === 0);
assert.ok(masterEnd, 'the master envelope fades fully to silence');
assert.equal(Number((masterEnd.t - 100).toFixed(3)), SPEC.totalLength,
  'the complete cash-register alert lasts ' + SPEC.totalLength + ' seconds');
assert.ok(SPEC.totalLength >= 1.5, 'the alert is at least 1.5 seconds long');
assert.equal(Math.max(...masterEvents.map((event) => event.v)), SPEC.level,
  'the master gain holds the designed alert level');
// It must NOT hold the level past holdUntil — the bell has to be free to ring
// down on its own (holding it flat is what made the old build a chime).
const holdEvent = masterEvents.find((event) => event.t === 100 + SPEC.holdUntil);
assert.ok(holdEvent && holdEvent.v === SPEC.level, 'the master holds until ' + SPEC.holdUntil + 's');
assert.ok(SPEC.holdUntil < SPEC.totalLength, 'the envelope then fades instead of holding to the end');

// 11f. The 2.5s cooldown: an immediate repeat is suppressed…
ReplayFeed.playAlertSound();
assert.equal(audioLog.oscillators.length, previewCount, 'cooldown blocks an immediate repeat');
assert.equal(audioLog.sources.length, previewSources, 'cooldown also suppresses the mechanism');
// …and after the cooldown a new alert plays.
clockOffsetMs = 3000;
audioLog.ctx.state = 'suspended';
ReplayFeed.playAlertSound();
assert.equal(audioLog.oscillators.length, previewCount * 2, 'alert plays again after the cooldown');
assert.equal(audioLog.sources.length, previewSources * 2, 'the second alert schedules the full graph');
assert.ok(audioLog.resumes >= 1, 'a suspended AudioContext is resumed before playing');

// 11g. Disabling silences it again (and no preview on mute).
ReplayFeed.setSoundEnabled(false);
assert.equal(ReplayFeed.getSoundEnabled(), false);
assert.equal(audioLog.oscillators.length, previewCount * 2, 'muting plays nothing');
assert.equal(audioLog.sources.length, previewSources * 2, 'muting plays no mechanical noise');

/* ------------------------- 12. Run-at-risk detection (the ASAP alert)
 *
 * A run already on the scoreboard can only be "at risk" when the review is
 * still active AND the official payload credits runs to the reviewed event.
 * Nothing here is inferred from a score delta or predicted from a ruling.
 */

const activeOneRun = {
  typeKey: 'manager', inProgress: true,
  scoreImpact: { runsCredited: 1, runsAtRisk: 1, runsAtRiskAtStart: 1 },
};
const activeThreeRun = {
  typeKey: 'boundary', inProgress: true,
  scoreImpact: { runsCredited: 3, runsAtRisk: 3, runsAtRiskAtStart: 3 },
};

// 12a. Active + credited runs = at risk, with the observed count.
assert.equal(runsRemovableFromReview(activeOneRun), 1);
assert.equal(runsRemovableFromReview(activeThreeRun), 3);
assert.equal(shouldRunRiskAlert(activeOneRun), true);
assert.equal(shouldRunRiskAlert(activeThreeRun), true);

// 12b. Every review type is eligible — unlike the new-review chime gate, the
// run-at-risk gate is driven by the DATA, not by the review's type. ABS included.
['manager', 'crew_chief', 'boundary', 'review', 'rules', 'abs'].forEach((typeKey) => {
  assert.equal(shouldRunRiskAlert({ ...activeOneRun, typeKey }), true,
    `${typeKey} with a credited run at risk must alert`);
});
// The new-review chime includes ABS in this build; the two gates stay
// independent, and the run-at-risk gate remains data-driven.
assert.equal(shouldAlertForReview({ typeKey: 'abs' }), true);
assert.equal(shouldRunRiskAlert({ typeKey: 'abs' }), false,
  'an ABS challenge with no credited run is still not a run-risk event');

// 12c. A resolved review can never put a run at risk.
assert.equal(shouldRunRiskAlert({ ...activeOneRun, inProgress: false }), false);
assert.equal(runsRemovableFromReview({ ...activeOneRun, inProgress: false }), 0);

// 12d. An active review with no scoring runner tied to it is not at risk.
assert.equal(shouldRunRiskAlert({
  typeKey: 'boundary', inProgress: true,
  scoreImpact: { runsCredited: 0, runsAtRisk: 0, runsAtRiskAtStart: 0 },
}), false);

// 12e. reconcileScoreImpact() preserves the FIRST snapshot, so
// runsAtRiskAtStart can lag at 0 on the poll where runner records land. The
// largest observed candidate wins so a late run is never dropped.
assert.equal(runsRemovableFromReview({
  typeKey: 'manager', inProgress: true,
  scoreImpact: { runsAtRiskAtStart: 0, runsAtRisk: 0, runsCredited: 2 },
}), 2);

// 12f. Malformed input never throws and never alerts.
[null, undefined, {}, { inProgress: true }, { inProgress: true, scoreImpact: null },
  { inProgress: true, scoreImpact: 7 },
  { inProgress: true, scoreImpact: { runsCredited: NaN } },
  { inProgress: true, scoreImpact: { runsCredited: -1 } },
  { inProgress: true, scoreImpact: { runsCredited: '2' } },
  { inProgress: 1, scoreImpact: { runsCredited: 2 } },
].forEach((bad) => {
  assert.equal(runsRemovableFromReview(bad), 0, `zero runs for ${JSON.stringify(bad)}`);
  assert.equal(shouldRunRiskAlert(bad), false, `no run-at-risk alert for ${JSON.stringify(bad)}`);
});

// 12g. It agrees with MLBReviews.runsRemovableByReview() on the tracker
// fixture used by section 4b above (the two implementations must not drift).
assert.equal(runsRemovableFromReview(activeRisk), 1);
assert.equal(shouldRunRiskAlert(activeRisk), true);

/* --------------- 13. Alert de-duplication across polls (diffRunRiskKeys) */

const keyOf = (entry) => buildEventKey(entry.gamePk, entry.review);
const entryOf = (gamePk, review) => ({ gamePk, review });

// 13a. First sighting of a risky review starts an alert.
let tracked = new Set();
const pollOne = diffRunRiskKeys(tracked, [
  entryOf(1, { ...activeOneRun, id: 'play-5-main' }),
  entryOf(2, { ...activeOneRun, id: 'play-9-main', inProgress: false }),
], keyOf);
assert.deepEqual([...pollOne.started], ['1:play-5-main'], 'only the risky review alerts');
assert.deepEqual([...pollOne.cleared], []);
assert.deepEqual([...pollOne.next], ['1:play-5-main']);
tracked = pollOne.next;

// 13b. The SAME review still active on the next poll must NOT re-alert.
const pollTwo = diffRunRiskKeys(tracked, [
  entryOf(1, { ...activeOneRun, id: 'play-5-main' }),
], keyOf);
assert.deepEqual([...pollTwo.started], [], 'a still-running review does not re-alert every poll');
assert.deepEqual([...pollTwo.cleared], []);
tracked = pollTwo.next;

// 13c. A second game going at-risk alerts on its own, once.
const pollThree = diffRunRiskKeys(tracked, [
  entryOf(1, { ...activeOneRun, id: 'play-5-main' }),
  entryOf(2, { ...activeThreeRun, id: 'play-11-main' }),
], keyOf);
assert.deepEqual([...pollThree.started], ['2:play-11-main']);
assert.deepEqual([...pollThree.next].sort(), ['1:play-5-main', '2:play-11-main']);
tracked = pollThree.next;

// 13d. Resolution clears the key (so a later, genuinely new review on the
// same play can alert again) without alerting on the way out.
const pollFour = diffRunRiskKeys(tracked, [
  entryOf(1, { ...activeOneRun, id: 'play-5-main', inProgress: false }),
  entryOf(2, { ...activeThreeRun, id: 'play-11-main' }),
], keyOf);
assert.deepEqual([...pollFour.started], []);
assert.deepEqual([...pollFour.cleared], ['1:play-5-main']);
assert.deepEqual([...pollFour.next], ['2:play-11-main']);
tracked = pollFour.next;

// 13e. An entry that vanishes from the feed entirely is cleared too.
const pollFive = diffRunRiskKeys(tracked, [], keyOf);
assert.deepEqual([...pollFive.cleared], ['2:play-11-main']);
assert.equal(pollFive.next.size, 0);

// 13f. After clearing, the same play going back under review alerts again.
const pollSix = diffRunRiskKeys(pollFive.next, [
  entryOf(1, { ...activeOneRun, id: 'play-5-main' }),
], keyOf);
assert.deepEqual([...pollSix.started], ['1:play-5-main'], 'a re-review re-alerts');

// 13g. Defensive: junk entries are skipped, not crashed on.
const pollJunk = diffRunRiskKeys(new Set(), [null, undefined, { gamePk: 3 }], keyOf);
assert.deepEqual([...pollJunk.started], []);
assert.equal(pollJunk.next.size, 0);
// An array (not a Set) is accepted as the previous state.
assert.deepEqual([...diffRunRiskKeys(['1:play-5-main'], [
  entryOf(1, { ...activeOneRun, id: 'play-5-main' }),
], keyOf).started], []);

/* ------------- 14. Run-at-risk uses the same cash-register cha-ching
 *
 * Both alert paths must build the same sound graph and share the existing
 * cooldown, so a run-at-risk review cannot introduce a second sound.
 * Counts come from ALERT_SOUND, so the two tests can never drift apart.
 */

function captureAlertGraph() {
  const voices = audioLog.oscillators.map((osc) => {
    const edge = audioLog.edges.find(([source]) => source === osc);
    assert.ok(edge, 'each bell partial connects into a gain node');
    return {
      type: osc.type,
      frequency: osc.frequency.value,
      gain: edge[1]._gainEvents.map((event) => `${event.kind}@${event.v}t${event.t}`).join(','),
      start: osc.startedAt,
      stop: osc.stoppedAt,
    };
  });
  const clacks = audioLog.sources.map((source) => ({
    start: source.startedAt,
    stop: source.stoppedAt,
    length: source.buffer.length,
  }));
  const shaper = audioLog.shapers[audioLog.shapers.length - 1];
  assert.ok(shaper, 'the sound ends in the master soft-clipper');
  assert.ok(audioLog.edges.some(([src, dst]) => src === shaper && dst._kind === 'destination'),
    'the soft-clipper is connected to the destination');
  const masterEdge = audioLog.edges.find(([src, dst]) => dst === shaper);
  assert.ok(masterEdge, 'the sound has a master gain feeding the soft-clipper');
  const master = masterEdge[0]._gainEvents.map((event) => `${event.kind}@${event.v}t${event.t}`).join(',');
  return { voices, clacks, master };
}

function resetAudioLog() {
  audioLog.oscillators.length = 0;
  audioLog.sources.length = 0;
  audioLog.buffers.length = 0;
  audioLog.gains.length = 0;
  audioLog.edges.length = 0;
  audioLog.shapers.length = 0;
  audioLog.decodes.length = 0;
  audioLog.playedSamples.length = 0;
}

resetAudioLog();
clockOffsetMs = 60000;
audioLog.ctx.state = 'running';

// 14a. Silent while muted, exactly like the ordinary alert.
ReplayFeed.playRunRiskAlertSound();
assert.equal(audioLog.oscillators.length, 0, 'no run-at-risk alert while the toggle is off');
assert.equal(audioLog.sources.length, 0, 'no register mechanism while the toggle is off');

// 14b. Capture the ordinary alert played when sound is enabled.
ReplayFeed.setSoundEnabled(true);
const ordinaryAlert = captureAlertGraph();
assert.equal(ordinaryAlert.voices.length, EXPECTED_OSCILLATORS,
  'ordinary alert schedules the bell partials and the mechanical thuds');
assert.equal(ordinaryAlert.clacks.length, NOISE_SOURCES,
  'ordinary alert schedules every mechanical noise layer');

// 14c. Capture run-at-risk playback and compare the whole scheduled graph.
resetAudioLog();
clockOffsetMs = 120000;
ReplayFeed.playRunRiskAlertSound();
const runRiskAlert = captureAlertGraph();
assert.deepEqual(runRiskAlert, ordinaryAlert,
  'run-at-risk must use the exact same cash-register sound and timings');

// The signature remains the same metal bell, struck once, with the same envelope.
assert.equal(runRiskAlert.voices.length, EXPECTED_OSCILLATORS);
const sines = runRiskAlert.voices.filter((voice) => voice.type === 'sine');
const thuds = runRiskAlert.voices.filter((voice) => voice.type === 'triangle');
assert.equal(sines.length, BELL_STRIKES * BELL_PARTIALS, 'every bell strike keeps its full partial set');
assert.equal(thuds.length, THUMP_TONES, 'the mechanical thuds are still there');
const primes = sines.filter((voice) => Math.abs(voice.frequency - SPEC.bellFundamental) < 1e-6);
assert.equal(primes.length, BELL_STRIKES, 'the bell strike rings at the register-bell pitch');
assert.ok(primes[0].start >= 100 + SPEC.bellStrikes[0].at - 1e-9 &&
          primes[0].start <= 100 + SPEC.bellStrikes[0].at + (SPEC.bellPhaseSpread || 0) + 1e-9,
  'the strike lands where the design says (within the sub-audible partial spread)');
assert.ok(runRiskAlert.master.includes('lin@' + SPEC.level + 't' + (100 + SPEC.holdUntil)),
  'the master envelope holds the ring at full level until ' + SPEC.holdUntil + 's');
assert.ok(runRiskAlert.master.includes('lin@0t' + (100 + SPEC.totalLength)),
  'the master envelope ends at ' + SPEC.totalLength + ' seconds');

// 14d. ONE shared cooldown — the same sound must never overlap itself.
resetAudioLog();
ReplayFeed.playAlertSound();
assert.equal(audioLog.oscillators.length, 0,
  'ordinary alert is blocked by the run-at-risk alert that just played');
ReplayFeed.playRunRiskAlertSound();
assert.equal(audioLog.oscillators.length, 0, 'an immediate run-at-risk repeat is blocked');
clockOffsetMs = 130000;
ReplayFeed.playRunRiskAlertSound();
assert.equal(audioLog.oscillators.length, EXPECTED_OSCILLATORS,
  'it plays again after the shared 2.5s cooldown');
assert.equal(audioLog.sources.length, NOISE_SOURCES,
  'the repeat includes the key clack, the gear clicks, the ratchet, the drawer and the hammer tick');

// 14e. A suspended context is resumed before the run-at-risk alert plays.
const resumesBefore = audioLog.resumes;
audioLog.ctx.state = 'suspended';
clockOffsetMs = 140000;
ReplayFeed.playRunRiskAlertSound();
assert.ok(audioLog.resumes > resumesBefore, 'run-at-risk alert resumes a suspended AudioContext');

ReplayFeed.setSoundEnabled(false);

/* --------------------------- 15. Challenges-remaining tracker (pure helpers)
 * Fixtures are VERBATIM live captures from statsapi.mlb.com on 2026-08-28:
 *   - game 824638 (CIN @ CHC, In Progress): feed/live gameData carried
 *       review:        {hasChallenges:false, away:{used:0,remaining:1}, home:{used:0,remaining:1}}
 *       absChallenges: {hasChallenges:true,  away:{usedSuccessful:2,usedFailed:0,remaining:2},
 *                                            home:{usedSuccessful:3,usedFailed:0,remaining:2}}
 *   - game 824879 (LAD @ ATL, Final 2026-08-27): review home used:2 remaining:0,
 *       absChallenges away usedFailed:1 remaining:1.
 *   - game 776162 (BAL @ NYY, Final 2025-09-27, pre-ABS season): feed/live
 *       gameData has review but NO absChallenges object at all.
 */

// 15a. Both live sources normalize; nothing is invented.
const live824638 = normalizeChallengeCounts(
  { hasChallenges: false, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
  { hasChallenges: true,
    away: { usedSuccessful: 2, usedFailed: 0, remaining: 2 },
    home: { usedSuccessful: 3, usedFailed: 0, remaining: 2 } });
assert.equal(live824638.manager.away.used, 0);
assert.equal(live824638.manager.home.remaining, 1);
assert.equal(live824638.abs.away.usedSuccessful, 2);
assert.equal(live824638.abs.home.remaining, 2);

// 15b. Pre-ABS season (verified 2025 game 776162): abs stays null, never 0.
const preAbs = normalizeChallengeCounts(
  { hasChallenges: true, away: { used: 0, remaining: 1 }, home: { used: 1, remaining: 0 } },
  null);
assert.equal(preAbs.abs, null, 'missing absChallenges must stay null, not zero-filled');
assert.equal(preAbs.manager.home.used, 1);

// 15c. Wholly missing/malformed input yields null, and partial numbers stay null.
assert.equal(normalizeChallengeCounts(null, null), null);
assert.equal(normalizeChallengeCounts({}, {}), null);
const malformed = normalizeChallengeCounts(
  { away: { used: 'one', remaining: -2 }, home: { used: 1 } }, null);
assert.equal(malformed.manager.away, null, 'non-numeric/negative counters are rejected');
assert.equal(malformed.manager.home.used, 1);
assert.equal(malformed.manager.home.remaining, null, 'a missing counter is null, never 0');

// 15d. Irregularity flag: a used counter can never decrease within a game.
const before = normalizeChallengeCounts(
  { away: { used: 1, remaining: 0 }, home: { used: 0, remaining: 1 } },
  { away: { usedSuccessful: 1, usedFailed: 1, remaining: 1 }, home: { usedSuccessful: 0, usedFailed: 0, remaining: 2 } });
const regressed = normalizeChallengeCounts(
  { away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
  { away: { usedSuccessful: 0, usedFailed: 1, remaining: 1 }, home: { usedSuccessful: 0, usedFailed: 0, remaining: 2 } });
const issues = challengeCountIrregularities(before, regressed);
assert.equal(JSON.stringify(issues),
  JSON.stringify(['manager.away.used decreased 1 → 0', 'abs.away.usedSuccessful decreased 1 → 0']));

// 15e. remaining may legitimately rise (successful ABS challenges are retained;
// extra innings can regain one) — never flagged in either direction.
const regained = normalizeChallengeCounts(
  { away: { used: 1, remaining: 0 }, home: { used: 0, remaining: 1 } },
  { away: { usedSuccessful: 1, usedFailed: 1, remaining: 2 }, home: { usedSuccessful: 0, usedFailed: 0, remaining: 2 } });
assert.equal(challengeCountIrregularities(before, regained).length, 0,
  'a rising remaining counter is not an irregularity');
assert.equal(challengeCountIrregularities(null, regained).length, 0);
assert.equal(challengeCountIrregularities(before, null).length, 0);

// 15f. teamSideInGame reads only the schedule's team ids.
const cinChc = { teams: {
  away: { team: { id: 113, name: 'Cincinnati Reds', link: '/api/v1/teams/113' } },
  home: { team: { id: 112, name: 'Chicago Cubs', link: '/api/v1/teams/112' } },
} };
assert.equal(teamSideInGame(cinChc, 113), 'away');
assert.equal(teamSideInGame(cinChc, 112), 'home');
assert.equal(teamSideInGame(cinChc, 999), null);
assert.equal(teamSideInGame(cinChc, null), null);

// 15g. Per-team line: only ABS/manager types, only observed counters.
assert.equal(teamChallengeLine(live824638, 'away', 'CIN', 'abs', 'now'),
  'CIN: 2 ABS challenges left now (2 successful · 0 failed)');
assert.equal(teamChallengeLine(live824638, 'home', 'CHC', 'manager', 'now'),
  'CHC: 1 manager challenge left now (0 used)');
assert.equal(teamChallengeLine(live824638, 'away', 'CIN', 'boundary', 'now'), null,
  'crew-chief/boundary reviews are not charged to a team counter');
assert.equal(teamChallengeLine(preAbs, 'away', 'BAL', 'abs', 'now'), null,
  'no ABS counters in a pre-ABS season — nothing rendered, not 0');
assert.equal(teamChallengeLine(live824638, null, 'CIN', 'abs', 'now'), null);

// 15h. Both-teams summary omits unavailable halves and never zero-fills.
assert.equal(gameChallengeLine(live824638, { away: 'CIN', home: 'CHC' }, 'Challenges left'),
  'Challenges left: CIN 1 MGR · 2 ABS — CHC 1 MGR · 2 ABS');
assert.equal(gameChallengeLine(preAbs, { away: 'BAL', home: 'NYY' }, 'Challenges left'),
  'Challenges left: BAL 1 MGR — NYY 0 MGR');
assert.equal(gameChallengeLine(null, { away: 'CIN', home: 'CHC' }), null);
assert.equal(gameChallengeLine(normalizeChallengeCounts({}, {}), {}), null);
const blob15 = [
  teamChallengeLine(live824638, 'away', 'CIN', 'abs', 'now'),
  gameChallengeLine(live824638, { away: 'CIN', home: 'CHC' }),
].join(' | ');
assert.ok(!blob15.includes('undefined'), `challenge lines leaked "undefined": ${blob15}`);

/* -------- 16. The real-recording path (and the synthesized fallback)
 *
 * The site prefers a REAL cash-register recording if one is installed at
 * assets/audio/cha-ching.{mp3,wav,ogg,m4a}, and falls back to the synthesized
 * cha-ching (sections 11 and 14) when there is not one. That dual path is the
 * whole design: a fresh clone is never silent, and installing a recording
 * never requires editing code.
 *
 * These tests drive both branches through the public API with a stubbed
 * fetch/decodeAudioData, because the sandbox and CI have no audio asset.
 */

/** A decoded-audio stub: what `decodeAudioData` hands back in a browser. */
function fakeAudioBuffer({ duration = 1.5, peak = 0.5, channels = 1, sampleRate = 44100 } = {}) {
  const frames = Math.max(1, Math.round(duration * sampleRate));
  const data = [];
  for (let c = 0; c < channels; c++) {
    const ch = new Float32Array(frames);
    // A peak exactly where peakOfBuffer() will find it, so gain is computable.
    ch[Math.floor(frames / 2)] = c === 0 ? peak : peak * 0.5;
    data.push(ch);
  }
  return {
    duration, sampleRate, numberOfChannels: channels, length: frames,
    getChannelData: (c) => data[c],
  };
}
const TARGET_PEAK_DB = -2.0;
const targetPeak = Math.pow(10, TARGET_PEAK_DB / 20);

function soundIsEnabled(enabled) {
  ReplayFeed.setSoundEnabled(enabled);
  assert.equal(ReplayFeed.getSoundEnabled(), enabled);
}

// Sections 11-15 turn the sound on without ever awaiting, so the probe they
// kicked off is still suspended mid-loop when we get here. Drain it first, or
// its remaining requests would be counted as section 16's.
await new Promise((resolve) => setTimeout(resolve, 0));

// 16a. A fresh clone: every candidate path 404s. The probe must try all of
// them once, resolve null, and leave the synthesized alert in charge.
fakeNet.mode = 'missing';
ReplayFeed.clearAlertSample();
fakeNet.requests.length = 0;
resetAudioLog();
clockOffsetMs = 200000;
audioLog.ctx.state = 'running';
soundIsEnabled(true);
const probeResult = await ReplayFeed.primeAlertSound();
assert.equal(probeResult, null, 'no recording is installed, so the probe resolves null');
assert.equal(ReplayFeed.getAlertSample(), null, 'and nothing is adopted as the alert');
// Spread both sides: `alertSamplePaths` is built inside the module's VM realm,
// and deepStrictEqual compares prototypes, so a VM array never equals a host
// array even with identical contents. (Same trap as the soft-clip curve, which
// web-audio-engine silently drops when it is a cross-realm Float32Array.)
assert.deepEqual([...fakeNet.requests], [...ReplayFeed.alertSamplePaths],
  'the probe tries exactly the documented candidate paths, once each, in order');
assert.equal(audioLog.decodes.length, 0, 'a 404 is never handed to the decoder');

resetAudioLog();
clockOffsetMs = 210000;
ReplayFeed.playAlertSound();
assert.equal(audioLog.oscillators.length, EXPECTED_OSCILLATORS,
  'with no recording, the alert is the full synthesized graph — never silent');
assert.equal(audioLog.sources.length, NOISE_SOURCES,
  'and every mechanical noise layer is still scheduled');

// The probe must not become a retry storm: later alerts reuse the "no asset"
// answer instead of re-fetching four URLs on every alert.
fakeNet.requests.length = 0;
clockOffsetMs = 220000;
ReplayFeed.playAlertSound();
clockOffsetMs = 230000;
ReplayFeed.playAlertSound();
assert.equal(fakeNet.requests.length, 0,
  'a missing asset is probed once per page load, not on every alert');

// 16b. A static host that answers unknown paths with a 200 HTML error page
// must be rejected before the decoder sees it, so the fallback stays clean.
fakeNet.mode = 'html';
// The decoder must be WORKING here, so the only thing that can stop the HTML
// error page from being adopted as the alert is looksLikeHtml(). With the
// decoder failing, this assertion would pass for the wrong reason.
fakeNet.decoded = fakeAudioBuffer({ duration: 1.5, peak: 0.5 });
fakeNet.requests.length = 0;
resetAudioLog();
ReplayFeed.clearAlertSample();
assert.equal(await ReplayFeed.primeAlertSound(), null,
  'an HTML error page is not mistaken for audio');
assert.equal(ReplayFeed.getAlertSample(), null, 'and is not adopted as the alert');
assert.equal(audioLog.decodes.length, 0,
  'HTML bytes are never handed to decodeAudioData');

// 16c. A real recording IS installed: it wins, and the synthesized graph is
// not built at all. This is the path a user gets after dropping in a file.
fakeNet.mode = 'audio';
fakeNet.audioBytes = new Uint8Array(4096).buffer;   // big enough to pass the length guard
fakeNet.decoded = fakeAudioBuffer({ duration: 1.5, peak: 0.5 });
fakeNet.requests.length = 0;
ReplayFeed.clearAlertSample();
resetAudioLog();
clockOffsetMs = 240000;
const installed = await ReplayFeed.primeAlertSound();
assert.ok(installed, 'the installed recording is adopted');
assert.equal(fakeNet.requests.length, 1,
  'a working install costs exactly one request (the first candidate wins)');
assert.equal(fakeNet.requests[0], ReplayFeed.alertSamplePaths[0]);

const info = ReplayFeed.getAlertSample();
assert.ok(info, 'the installed recording is reported for the Sound Lab');
assert.equal(info.url, ReplayFeed.alertSamplePaths[0]);
assert.equal(info.duration, 1.5);
assert.equal(info.sampleRate, 44100);
assert.equal(info.channels, 1);
assert.ok(Math.abs(info.gain - targetPeak / 0.5) < 1e-9,
  `a quiet recording is normalized up to ${TARGET_PEAK_DB} dBFS, not left quiet`);

resetAudioLog();
clockOffsetMs = 250000;
ReplayFeed.playAlertSound();
assert.equal(audioLog.sources.length, 1, 'the alert plays exactly one buffer source');
assert.equal(audioLog.oscillators.length, 0, 'no synthesized bell is built on top of it');
assert.equal(audioLog.shapers.length, 0, 'no synthesizer graph is built at all');
assert.equal(audioLog.sources[0].buffer, fakeNet.decoded, 'and it is the installed recording');
const sampleGainEdge = audioLog.edges.find(([src]) => src === audioLog.sources[0]);
assert.ok(sampleGainEdge, 'the recording goes through a gain node');
assert.ok(Math.abs(sampleGainEdge[1].gain.value - info.gain) < 1e-12,
  'that gain is the normalization gain, so the alert level is consistent');
assert.ok(audioLog.edges.some(([src, dst]) => src === sampleGainEdge[1] && dst._kind === 'destination'),
  'and it reaches the destination');

// 16d. A brick-walled master is cut, and the clamps are real limits.
fakeNet.decoded = fakeAudioBuffer({ duration: 1.0, peak: 1.0 });
ReplayFeed.clearAlertSample();
const hot = await ReplayFeed.primeAlertSound();
assert.ok(Math.abs(hot.gain - targetPeak) < 1e-9,
  'a hot recording is cut to the same target peak, so it cannot clip');
fakeNet.decoded = fakeAudioBuffer({ duration: 1.0, peak: 0.001 });
ReplayFeed.clearAlertSample();
const whisper = await ReplayFeed.primeAlertSound();
assert.ok(whisper.gain <= 8,
  `a near-silent file is not boosted past the clamp (gain ${whisper.gain})`);
fakeNet.decoded = fakeAudioBuffer({ duration: 1.0, peak: 1.0, channels: 2 });
ReplayFeed.clearAlertSample();
const stereo = await ReplayFeed.primeAlertSound();
assert.equal(stereo.gain, Math.max(0.1, Math.min(8, targetPeak / 1.0)),
  'normalization uses the loudest channel across a stereo file');
fakeNet.decoded = fakeAudioBuffer({ duration: 0.02 });
ReplayFeed.clearAlertSample();
assert.equal(await ReplayFeed.primeAlertSound(), null,
  'a stub shorter than 50 ms is not adopted as the alert');

// 16e. The recording shares the same toggle and the same 2.5 s cooldown, so
// swapping paths cannot introduce a second alert or an overlapping one.
fakeNet.decoded = fakeAudioBuffer({ duration: 1.5, peak: 0.5 });
ReplayFeed.clearAlertSample();
await ReplayFeed.primeAlertSound();
soundIsEnabled(false);
resetAudioLog();
clockOffsetMs = 260000;
ReplayFeed.playAlertSound();
assert.equal(audioLog.sources.length, 0, 'muting silences the recording too');
soundIsEnabled(true);
resetAudioLog();
clockOffsetMs = 270000;
ReplayFeed.playAlertSound();
assert.equal(audioLog.sources.length, 1, 'unmuting plays the recording');
clockOffsetMs = 271000;
ReplayFeed.playAlertSound();
assert.equal(audioLog.sources.length, 1, 'the shared cooldown blocks an immediate repeat');
clockOffsetMs = 280000;
ReplayFeed.playRunRiskAlertSound();
assert.equal(audioLog.sources.length, 2,
  'run-at-risk plays the SAME recording — one alert sound for the page');

// 16f. The Sound Lab's drag-and-drop path: install from bytes the caller
// already holds, with no network request at all.
ReplayFeed.clearAlertSample();
fakeNet.requests.length = 0;
fakeNet.decoded = fakeAudioBuffer({ duration: 1.2, peak: 0.8 });
const fromBytes = await ReplayFeed.setAlertSampleFromBytes(new Uint8Array(2048).buffer, 'my-cha-ching.mp3');
assert.ok(fromBytes, 'a dropped file is adopted');
assert.equal(fakeNet.requests.length, 0, 'installing from bytes makes no network request');
assert.equal(ReplayFeed.getAlertSample().url, 'my-cha-ching.mp3',
  'and it is reported under the name the user gave it');
assert.equal(await ReplayFeed.setAlertSampleFromBytes(new Uint8Array(64).buffer, 'tiny.mp3'), null,
  'a too-short file is refused');
assert.equal(await ReplayFeed.setAlertSampleFromBytes(
  bytesOf('<!DOCTYPE html><html><body>nope</body></html>' + 'x'.repeat(4096)).buffer, 'page.html'),
  null, 'an HTML file dropped by mistake is refused, not decoded');
assert.equal(await ReplayFeed.setAlertSampleFromBytes(null, 'nothing'), null,
  'no bytes is refused without throwing');

// 16g. Undecodable audio bytes must fall back to the synthesizer, never throw
// and never leave the page silent.
fakeNet.decoded = null;   // decodeAudioData now fails
ReplayFeed.clearAlertSample();
fakeNet.audioBytes = new Uint8Array(4096).buffer;
assert.equal(await ReplayFeed.primeAlertSound(), null, 'undecodable bytes resolve null');
resetAudioLog();
clockOffsetMs = 290000;
ReplayFeed.playAlertSound();
assert.equal(audioLog.oscillators.length, EXPECTED_OSCILLATORS,
  'an undecodable asset falls back to the synthesized cha-ching');
assert.equal(audioLog.sources.length, NOISE_SOURCES,
  'and the fallback is complete, not a partial graph');

// 16h. clearAlertSample() really re-arms the probe, which is what lets the
// Sound Lab install a file after the page has already loaded.
fakeNet.decoded = fakeAudioBuffer({ duration: 1.5, peak: 0.5 });
fakeNet.requests.length = 0;
assert.equal(await ReplayFeed.primeAlertSound(), null, 'still latched as "no asset"');
assert.equal(fakeNet.requests.length, 0, 'the latch means no further probing');
ReplayFeed.clearAlertSample();
assert.ok(await ReplayFeed.primeAlertSound(), 'after clearing, the probe runs again and finds it');
assert.equal(fakeNet.requests.length, 1);

soundIsEnabled(false);

console.log('Replay feed tests passed successfully!');
