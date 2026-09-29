# POSTSEASONMLBALERTS

**Live MLB alert feed for every tracked event — manager challenges, crew-chief/umpire reviews, boundary calls, ABS pitch challenges, official-scorer pending rulings and official scoring changes — all in one complete "All" feed, with chime alerts and live tracking.**

A copy of [MLB-Live-PBP](https://buffedlizard55-lab.github.io/MLB-Live-PBP/reviews.html) with exactly one behavioral change: **ABS pitch challenges are included in the "All" feed, the alert system, and live tracking** (upstream excludes them from All/alerts during the regular season to limit volume). Everything else is deliberately identical.

---

## ⚾ Project brief — read this at the start of every work session

> This block is the standing source of truth for what we are building. Re-read it before every session so every change, suggestion and upgrade stays anchored to it.
>
> **Goal.** Copy the MLB-Live-PBP repo and site (https://buffedlizard55-lab.github.io/MLB-Live-PBP/reviews.html). The only change: all alerts appear in the All feed — currently the ABS is excluded because during the regular season it would be too many alerts. Everything that the site tracks must appear in the All feed. It should be almost exactly the same, except ABS is included in the alert system and live tracking.
>
> **Why.** It should solve the problem of having to manually check everything ourselves — one up-to-date, current feed that shows what is happening across the whole slate without hunting.
>
> **How we work.** Keep the Core Values and "Own the Outcome" as a focal point when building, developing, researching, suggesting upgrades, and implementing work. Work line by line, verifying from official verified trusted sources, and provide links for manual review. There should be no manual input — work autonomously to complete tasks. Flag any irregularities for review. **No hallucinations. Verify line by line.**
>
> **Site.** Create a GitHub Page for this repo with clean UI, user friendly, simple and easy to use. Organized and clean. It should include all relevant information in an easy to read format with official verified links as sources for review. Work line by line, verify everything, no hallucinations.
>
> **Delivery.** Open a pull request and merge it onto main. Make suggestions for what work still needs to be done and any limitations in the way of a successful project, to be worked on in this session or the next.
>
> **Process.** Run every task through multiple passes:
> - **Pass 1** — implement the task completely and verify the result.
> - **Pass 2** — review the work for bugs, missing requirements, incorrect assumptions and edge cases. Fix everything found.
> - **Pass 3** — re-check the entire implementation against the original request. Improve accuracy, reliability, completeness and code quality. Fix any remaining issues.
>
> Do not stop after the first pass. Each pass must build on the previous one. Before finishing, verify that the final result fully satisfies the original request. Work line by line, verify everything, no hallucinations.

## 🧭 Core values

**Own the Outcome.** We own results end to end — not just our individual slice of the work. When problems arise and we have the means to act, we do so without waiting for permission or assignment. We treat failure and success as signals and use them to improve. We stay accountable to the final outcome.

**No hallucinations.** Every claim, field and link is verified line by line against official verified sources (linked below). Anything that cannot be verified is flagged as an irregularity for review — never guessed, never corrected silently, never hidden.

---

## What the site does

Static site (GitHub Pages) that polls the **official MLB StatsAPI** and surfaces, live and in one place:

| Tracked | Where it appears | Source field (official) |
| --- | --- | --- |
| Manager challenges | All feed + Challenges tab + alerts | `play.reviewDetails` (codes `MA`/`MF`/…), `gameData.review` counters |
| Crew-chief / umpire reviews | All feed + Reviews tab + alerts | `play.reviewDetails`, game status `IH` ("Instant Replay") |
| Boundary calls | All feed + Boundary Calls tab + alerts | `play.reviewDetails` |
| **ABS pitch challenges** | **All feed + ABS tab + alerts + live tracking** | `playEvents[].reviewDetails` (code `MJ`), `gameData.absChallenges` counters |
| "Under review" live status | All feed + Under Review tab + live strip | `gameData.status` codes `M*`/`N*`/`IH` from `GET /api/v1/gameStatus` |
| Runs at risk (overturn could remove a run) | All feed + Runs at Risk tab + banner + desktop alert | runs credited to the reviewed event in `runners[]` |
| Official-scorer pending rulings | All feed + Scoring Pending tab + alerts | event types `os_ruling_pending_primary` / `os_ruling_pending_prior` |
| Official scoring changes (hit ↔ error etc.) | All feed + Scoring Changes tab + alerts | poll-to-poll diff of `result.eventType` / `result.isOut` / `count.outs` / error movements |

Everything above is **observed from official payloads only** — nothing is predicted, inferred from score deltas, or zero-filled when a counter is absent. Irregularities (e.g. a used-challenge counter moving backwards) are flagged on the affected rows for review, never corrected.

Pages: **Scoreboard** (`index.html`), **Game** (`game.html?gamePk=…` — live PBP, probability props, review tracker), **Replay Feed** (`reviews.html` — the all-games chat-style alert feed with sound + desktop notifications).

## The one change vs. MLB-Live-PBP

Upstream keeps ABS pitch challenges out of the "All" feed and out of the audio-alert gate (`shouldAlertForReview` / `visibleInAllFeed` return false only for `typeKey === 'abs'`) so a full regular season of routine ABS challenges doesn't flood the feed. This build changes exactly that: **ABS is treated like every other tracked category** — visible in All, counted in the Events stat and All tab, and it triggers the same raindrop-chime alert and live tracking as everything else. The dedicated ABS tab, ABS stat and official challenges-remaining counters remain alongside All. Full line-by-line change record: [`docs/abs-inclusion.md`](docs/abs-inclusion.md).

## Sources (all verified live 2026-09-29)

| Official source | Link | Used for |
| --- | --- | --- |
| MLB StatsAPI (data host) | https://statsapi.mlb.com | All live data (schedule, feed/live, playByPlay) |
| Official event-type registry | https://statsapi.mlb.com/api/v1/eventTypes | `os_ruling_pending_primary` / `os_ruling_pending_prior` ("Official Scorer Ruling Pending") |
| Official game-status registry | https://statsapi.mlb.com/api/v1/gameStatus | review-status codes `M*`/`N*`/`IH` ("Instant Replay", "Manager challenge: …") |
| MLB official scoring changes log | https://www.mlb.com/official-information/scoring-changes | how official scoring changes are made (Official Scorer / Elias / player-club review) |
| MLB glossary — Replay Review | https://www.mlb.com/glossary/rules/replay-review | reviewable calls, crew-chief review rules |
| MLB glossary — Manager Challenge | https://www.mlb.com/glossary/rules/manager-challenge | challenge counts and retention rules (postseason: two per club) |
| MLB — ABS Challenge System explainer | https://www.mlb.com/news/abs-challenge-system-mlb-2026 | ABS rules (2 per team, retained on success, in use during the postseason) |
| MLB Statcast — ABS Challenges leaderboard | https://baseballsavant.mlb.com/leaderboard/abs-challenges | official ABS challenge tracking/definitions |

Not affiliated with MLB or MLB Advanced Media. Unofficial fan project.

## Run locally & test

```bash
# static preview (the whole repo root is the site)
node server.mjs            # or: python3 -m http.server 8080

# test suite (pure/fixtures — no network)
node tools/reviews-feed-test.mjs
node tools/replay-feed-render-test.mjs
node tools/review-test.mjs
node tools/scoring-change-test.mjs
node tools/official-scoring-test.mjs
# …the full list is in docs/workflows/smoke.yml; tools/smoke-test.mjs is the
# live-API check run nightly by CI (needs network access to statsapi.mlb.com)
```

## Repo layout

```
index.html            Scoreboard page          reviews.html      Replay Feed (all-games alerts)
game.html             Game page (PBP/reviews)  404.html          not-found
assets/js|css         site code + styles       data/             persisted feed logs (per date)
tools/                test & verification suite (node, no deps)  docs/   verification records
server.mjs            optional local/dev server + feed-log sync  .github/workflows/ CI (docs/workflows/ = source copies)
```

## Work still needed (next session) & limitations

1. **Live-API verification runs in CI, not here.** `tools/smoke-test.mjs` (live checks against `statsapi.mlb.com`) could not run inside this build sandbox — outbound TLS to `statsapi.mlb.com` is blocked there (flagged, not skipped silently; the same limitation was recorded in `docs/scoring-changes.md`). All fixture-based tests pass. The live smoke is now wired into CI (`.github/workflows/smoke.yml` — every push/PR + nightly) where the network is open; treat any smoke failure as an irregularity for review.
2. **Alert volume is the trade-off we accepted.** Including ABS means roughly 4+ extra chimes per game (MLB's own 2025 spring data: avg 4.1 challenges/game). Suggested upgrade: per-category sound toggles and/or a short coalescing window so a burst of ABS challenges raises one chime. Currently one chime per poll max + 2.5s cooldown already bounds it.
3. **Desktop notifications only cover run-at-risk events** (upstream design). Extending them to all alertable events (with batching, already present for run-risk) is the natural next feature.
4. **First-load audio autoplay.** Browsers block `AudioContext` until the first user interaction; the chime is silent until one click (desktop notifications are not affected).
5. **Feed persistence is per-browser** (`localStorage`, newest 7 dates). The optional `server.mjs` adds multi-browser sync; on static GitHub Pages, cross-device history is not shared.
6. **Historical verification docs** (`docs/verification-report.md` etc.) describe the upstream MLB-Live-PBP baseline; the ABS-inclusion delta is recorded in `docs/abs-inclusion.md` and noted at the top of each historical doc.
7. **Upstream API risk.** The MLB StatsAPI is public but unofficial for third-party use; field shapes and rate limits can change. The test suite is built to fail loudly on drift (see `docs/api-compliance.md`).

## License

See [LICENSE](LICENSE) (copied from upstream MLB-Live-PBP).
