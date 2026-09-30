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
const audioLog = { oscillators: [], sources: [], buffers: [], gains: [], edges: [], resumes: 0, ctx: null };

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
}

const context = {
  console: { warn() {}, error() {}, log() {} },
  Map, Set, Date: FakeDate, Math, Number, String, Object, Array, URLSearchParams, CSS: { escape: (s) => s },
  UI: { el: () => ({}), clear: () => ({}) },
  MLB: {},
  window: { AudioContext: StubAudioContext },
  document: { addEventListener() {}, querySelector: () => null },
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
const NOISE_SOURCES = 1                                          // the key clack
  + SPEC.gearClicks.length                                       // the ratchet clicks
  + 1                                                            // the mechanism bed
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
assert.equal(audioLog.sources[bedIndex].startedAt, 100 + SPEC.ratchet.at,
  'the mechanism bed runs under the clicks');
assert.equal(audioLog.sources[bedIndex + 1].startedAt, 100 + SPEC.drawerSlide.at,
  'the drawer starts rolling while the mechanism is still running');
assert.ok(audioLog.sources[bedIndex + 1].startedAt < struck, 'the drawer opens across the bell, not before it');
SPEC.bellStrikes.forEach((strike, index) => {
  const tick = audioLog.sources[bedIndex + 2 + index];
  assert.equal(tick.startedAt, 100 + strike.at - SPEC.hammerTick.lead,
    'the hammer tick lands just before the strike');
});
assert.equal(audioLog.sources[bedIndex + 2 + BELL_STRIKES].startedAt, 100 + SPEC.drawerStop.at,
  'the drawer-stop thud fires after the bell, as it does in real recordings');
// Both swept noise bands (the mechanism bed and the drawer) ramp downward.
const sweeps = audioLog.edges
  .map(([, target]) => target)
  .filter((node) => node._kind === 'filter' && node._freqEvents.length >= 2);
assert.equal(sweeps.length, 2, 'two swept filters: the mechanism bed and the drawer slide');
[[SPEC.ratchet, 'mechanism bed'], [SPEC.drawerSlide, 'drawer slide']].forEach(([spec, label]) => {
  assert.ok(spec.toCentre < spec.fromCentre, `the ${label} sweep really descends`);
});
sweeps.forEach((node) => {
  const events = node._freqEvents;
  const lo = Math.min(events[0].v, events[events.length - 1].v);
  const hi = Math.max(events[0].v, events[events.length - 1].v);
  const matches = [SPEC.ratchet, SPEC.drawerSlide].some((spec) =>
    Math.abs(hi - spec.fromCentre) < 1e-6 && Math.abs(lo - spec.toCentre) < 1e-6);
  assert.ok(matches, 'each swept filter runs from its designed high centre down to its low centre');
});

// 11d. The "ching": every bell partial is a sine at fundamental x ratio; the
// prime decays with the measured ~0.19 s time constant (a struck bell, not a
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
const byStart = new Map();
bellOscillators.forEach((osc) => {
  const key = osc.startedAt.toFixed(6);
  if (!byStart.has(key)) byStart.set(key, []);
  byStart.get(key).push(osc);
});
assert.equal(byStart.size, BELL_STRIKES, 'the bell is struck exactly ' + BELL_STRIKES + ' time(s)');

// The measured shape: tau falls as the partial rises, and the prime's own time
// constant is the 0.168-0.196 s that real register bells were measured at.
const primePartial = SPEC.bellPartials.find((p) => p.ratio === 1);
assert.ok(primePartial, 'the design names a prime partial');
assert.ok(primePartial.tau >= 0.13 && primePartial.tau <= 0.28,
  'the prime time constant matches the measured 0.17-0.20 s of real register bells');
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
    assert.ok(decayOf(ordered[i]) <= decayOf(ordered[i - 1]) + 1e-9,
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
const masterEdge = audioLog.edges.find(([, target]) => target._kind === 'destination');
assert.ok(masterEdge, 'the master gain connects to the audio destination');
const masterEvents = masterEdge[0]._gainEvents;
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
  const masterEdge = audioLog.edges.find(([, target]) => target._kind === 'destination');
  assert.ok(masterEdge, 'the sound has a master gain connected to the destination');
  const master = masterEdge[0]._gainEvents.map((event) => `${event.kind}@${event.v}t${event.t}`).join(',');
  return { voices, clacks, master };
}

function resetAudioLog() {
  audioLog.oscillators.length = 0;
  audioLog.sources.length = 0;
  audioLog.buffers.length = 0;
  audioLog.gains.length = 0;
  audioLog.edges.length = 0;
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
assert.equal(primes[0].start, 100 + SPEC.bellStrikes[0].at, 'the strike lands where the design says');
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

console.log('Replay feed tests passed successfully!');
