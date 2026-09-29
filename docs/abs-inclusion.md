# Change record — ABS included in the All feed, alerts and live tracking

**Date:** 2026-09-29 · **Scope:** the single deliberate behavioral difference between this repo (POSTSEASONMLBALERTS) and upstream MLB-Live-PBP.

## Requirement

> "All alerts appear in the All feed, currently the ABS is excluded because during the regular
> season, it would be too many alerts. I want everything that the site tracks to appear in the
> all. It should almost be exactly the same except that ABS is included in the alert system and
> live tracking."

Upstream MLB-Live-PBP excludes exactly one category from the All feed and from the new-event
chime gate: `typeKey === 'abs'` (ABS pitch challenges). Everything else already flowed through.
This change removes that exclusion everywhere it existed; no other behavior is touched.

## Line-by-line changes

### `assets/js/reviews-feed.js`

| Location | Before | After |
| --- | --- | --- |
| `shouldAlertForReview()` | `return review.typeKey !== 'abs';` — routine ABS challenges stayed silent | `return true;` for any valid `typeKey` — **every tracked category alerts, ABS included**. Defensive gate unchanged: `null` / `{}` / non-string `typeKey` still never alert. |
| `visibleInAllFeed()` | `return !review \|\| review.typeKey !== 'abs';` — ABS rows hidden from All | `return true;` — **every tracked entry appears in All, ABS included**. Fail-open semantics for malformed entries preserved (still visible). |
| ingest fallback (inline mirror of `shouldAlertForReview`) | `e.review && e.review.typeKey !== 'abs'` | `e.review && typeof e.review.typeKey === 'string'` — mirrors the new gate |
| comments at the audio-alert state, `maybeAlertNow()`, `renderStats()` ("Events" stat), `renderTabs()` (All tab count), `matchesFilter()` | documented "every category except ABS" | updated to "every tracked category, ABS included (POSTSEASON build)" |

The Events stat and the `All (n)` tab count both derive from `visibleInAllFeed()`, so they now
count ABS rows — consistent with what the section renders. The dedicated ABS tab, `ABS Challenges`
stat and official challenges-remaining counters are unchanged and remain alongside All.

### `reviews.html`

- Sound-toggle tooltip: "(not ABS)" → "every tracked event … and ABS pitch challenges".
- The matching dynamic tooltip in `reviews-feed.js` (`updateSoundToggleUI()`) updated too.

### Live tracking — verified already inclusive (no change needed)

- Game page (`game.js`): ABS challenges (`playEvents[].reviewDetails`, code `MJ`) already feed the
  live review banner, play rows, review tab and 250ms in-review polling (`feedToken` includes them).
- Replay Feed LIVE REVIEW strip and Under Review tab: gate is `inProgress && typeKey !== 'pending_scoring'` — ABS already included.
- Run-at-risk gate (`shouldRunRiskAlert` / `runsRemovableFromReview`): already type-independent (ABS eligible).

### Tests updated to pin the new behavior

| Test | Change |
| --- | --- |
| `tools/reviews-feed-test.mjs` §10 | `shouldAlertForReview({typeKey:'abs'})` now **true** (was false); junk-input negatives unchanged |
| `tools/reviews-feed-test.mjs` §10b | `visibleInAllFeed({typeKey:'abs'})` now **true** (was false); fail-open negatives unchanged |
| `tools/reviews-feed-test.mjs` §12b | ABS chime gate re-pinned to **true**; run-at-risk gate still data-driven (ABS with no credited run = no run-risk alert) |
| `tools/replay-feed-render-test.mjs` §1, §4e, §8–§12 | All-section row counts 2→3 (and 3→4 once the scoring-change row lands); assert the captured ABS row **is** rendered in All (was: must not be); Events stat and All tab counts +1 |
| `tools/scoring-change-test.mjs` §11 | assertion message updated (behavior for scoring changes unchanged) |

## Verification (Pass 1–3)

1. **Pass 1 — implementation + tests.** Full suite: `hit-model-test`, `review-test`,
   `reviews-feed-test`, `replay-feed-render-test`, `review-probe-test`, `review-status-test`,
   `review-watcher-test`, `feed-log-persistence-test`, `cross-browser-persistence-test`,
   `scoring-change-test`, `official-scoring-test`, `count-model-derivation` — **all pass**.
2. **Pass 2 — review.** Grepped the whole tree for residual exclusion wording
   ("not ABS", "except ABS", "sectioned out", "must not contain ABS", `typeKey !== 'abs'`);
   remaining hits are intentional history references or ABS-context *providers* in `reviews.js`
   (`absContextLines` returns lines only for ABS rows — correct). Fixed every stale comment,
   tooltip and test message found.
3. **Pass 3 — re-check vs. requirement.** "All alerts appear in the All feed" ✓ (`visibleInAllFeed`).
   "Everything the site tracks appears in the All" ✓ (all 8 categories render in All). "ABS in the
   alert system" ✓ (`shouldAlertForReview`, chime + run-at-risk path). "ABS in live tracking" ✓
   (verified already live on the game page and the feed's live surfaces; now also in All/alerts).
   "Almost exactly the same otherwise" ✓ — no other behavior changed (asserted by the unchanged
   portions of the suite).

**Flagged irregularity (environment, not code):** the live-API check `tools/smoke-test.mjs` could
not reach `statsapi.mlb.com` from the build sandbox (TLS blocked — `curl` → `SSL_ERROR_SYSCALL`).
All fixture-based tests pass; run `node tools/smoke-test.mjs` from a network-open environment or
via `docs/workflows/smoke.yml` to re-verify against the live API.

## Note on historical docs

`docs/verification-report.md`, `docs/official-scoring-resolved.md` and
`docs/VERIFICATION-OFFICIAL-SCORING-RESOLVED.md` document the **upstream baseline** behavior
(ABS excluded from All/alerts) as verified on 2026-08/09. They are kept as-is as historical
records; this file documents the deliberate post-baseline change.
