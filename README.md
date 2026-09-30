# POSTSEASONMLBALERTS

**Live MLB alert feed for every tracked event — manager challenges, crew-chief/umpire reviews, boundary calls, ABS pitch challenges, official-scorer pending rulings and official scoring changes — all in one complete "All" feed, with cha-ching cash-register alerts and live tracking.**

A copy of [MLB-Live-PBP](https://buffedlizard55-lab.github.io/MLB-Live-PBP/reviews.html) with two intentional differences: **ABS pitch challenges are included in the "All" feed, alert system, and live tracking** (upstream excludes them from All/alerts during the regular season to limit volume), and the alert sound is a **cash-register cha-ching** with two paths: it plays a real recording from `assets/audio/cha-ching.{mp3,wav,ogg,m4a}` when one is installed, and otherwise a synthesized ~2-second ring-up (a bright percussive "cha" of a key slam, a gear train and two rattling beds, a metal bell struck once for the "ching", and the drawer sliding out and thudding to a stop) — see [`docs/alert-sound.md`](docs/alert-sound.md) and [`assets/audio/README.md`](assets/audio/README.md). Other behavior remains aligned with upstream.

---

## ⚾ Project brief — read this at the start of every work session

> This block is the standing source of truth for what we are building. Re-read it before every session so every change, suggestion and upgrade stays anchored to it.
>
> **Goal.** Copy the MLB-Live-PBP repo and site (https://buffedlizard55-lab.github.io/MLB-Live-PBP/reviews.html). The feed change is that all tracked alerts appear in the All feed, including ABS challenges that upstream excludes during the regular season. A sound customization request asked for a real cash-register cha-ching. The exact recording turned out to be a paid Bandcamp release (the reference YouTube clip says so in its own description), and no free host is reachable from a build environment, so the alert ships as a **slot plus a fallback**: drop a licensed recording into `assets/audio/` — no code changes, via [`sound-lab.html`](sound-lab.html) — and until then a synthesized cha-ching plays. That fallback was built by decoding two real cash-register recordings and measuring them, then verified against them: the "cha" is bright, broadband and full of separate attacks (spectral centroid 5602 Hz against the references' 6219/6033 Hz, flat to within 1.4 dB across 150 Hz-6 kHz, 3 attacks against their 3 and 10), the "ching" is an inharmonic bell on a 2098 Hz prime struck ONCE, and the alert is audible for 1.33 s above -40 dB and to 2.019 s. Alert categories, timing, and other behavior remain unchanged. Full record: [`docs/alert-sound.md`](docs/alert-sound.md).
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

Pages: **Scoreboard** (`index.html`), **Game** (`game.html?gamePk=…` — live PBP, probability props, review tracker), **Replay Feed** (`reviews.html` — the all-games chat-style alert feed with sound + desktop notifications), **Sound Lab** (`sound-lab.html` — audition, measure and install the alert sound).

## Intentional differences vs. MLB-Live-PBP

Upstream keeps ABS pitch challenges out of the "All" feed and out of the audio-alert gate (`shouldAlertForReview` / `visibleInAllFeed` return false only for `typeKey === 'abs'`) so a full regular season of routine ABS challenges doesn't flood the feed. This build includes ABS in All, the Events stat, alerts, and live tracking; it also uses the requested cha-ching cash-register sound for alerts (see [`docs/alert-sound.md`](docs/alert-sound.md)). The dedicated ABS tab, ABS stat and official challenges-remaining counters remain alongside All. Full line-by-line ABS inclusion record: [`docs/abs-inclusion.md`](docs/abs-inclusion.md).

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
game.html             Game page (PBP/reviews)  sound-lab.html    audition + install the alert sound
404.html              not-found                assets/audio/     the recording slot (README + LICENCE)
assets/js|css         site code + styles       data/             persisted feed logs (per date)
tools/                test & verification suite (node, no deps)  docs/   verification records
server.mjs            optional local/dev server + feed-log sync  .github/workflows/ CI (docs/workflows/ = source copies)
```

## Work still needed (next session) & limitations

1. **Live-API verification runs in CI, not here.** `tools/smoke-test.mjs` (live checks against `statsapi.mlb.com`) could not run inside this build sandbox — outbound TLS to `statsapi.mlb.com` is blocked there (flagged, not skipped silently; the same limitation was recorded in `docs/scoring-changes.md`). All fixture-based tests pass. The live smoke is now wired into CI (`.github/workflows/smoke.yml` — every push/PR + nightly) where the network is open; treat any smoke failure as an irregularity for review.
2. **Alert volume is the trade-off we accepted.** Including ABS means roughly 4+ extra cha-chings per game (MLB's own 2025 spring data: avg 4.1 challenges/game). Suggested upgrade: per-category sound toggles and/or a short coalescing window so a burst of ABS challenges raises one alert. Currently one alert per poll max + 2.5s cooldown already bounds it.
3. **Desktop notifications only cover run-at-risk events** (upstream design). Extending them to all alertable events (with batching, already present for run-risk) is the natural next feature.
4. **First-load audio autoplay.** Browsers block `AudioContext` until the first user interaction, so a one-time first-gesture primer (`pointerdown`/`keydown`/`touchstart`) creates the context and starts loading the recording; the cha-ching is silent until one click either way (desktop notifications are not affected).
5. **No audio asset is committed, on purpose.** The cha-ching the request pointed at is a paid Bandcamp release and cannot be copied; the two legally usable recordings found (Pixabay 125042, Pixabay 88639 — the second CC0 underneath) sit behind a JavaScript CDN that a build environment cannot fetch. So `assets/audio/` is a documented slot: install a recording from [`sound-lab.html`](sound-lab.html) or by hand, record its licence in `assets/audio/LICENCE.md`, and commit it. Until then the synthesized fallback plays, and it is measured against real recordings by `tools/render-alert-sound.mjs` (57 checks) and `tools/alert-sound-independent-check.mjs` (15 checks) rather than left unverified.
6. **Feed persistence is per-browser** (`localStorage`, newest 7 dates). The optional `server.mjs` adds multi-browser sync; on static GitHub Pages, cross-device history is not shared.
7. **Historical verification docs** (`docs/verification-report.md` etc.) describe the upstream MLB-Live-PBP baseline; the ABS-inclusion delta is recorded in `docs/abs-inclusion.md` and noted at the top of each historical doc.
8. **Upstream API risk.** The MLB StatsAPI is public but unofficial for third-party use; field shapes and rate limits can change. The test suite is built to fail loudly on drift (see `docs/api-compliance.md`).

## License

See [LICENSE](LICENSE) (copied from upstream MLB-Live-PBP).
