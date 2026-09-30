# The alert sound: a cash-register "cha-ching!"

The site has exactly **one** alert sound. Every tracked event plays it: new
challenges / reviews / boundary calls, official-scorer pending rulings, official
scoring changes, ABS pitch challenges, and the run-at-risk alert (which calls the
same function — see `playRunRiskAlertSound()` in `assets/js/reviews-feed.js`).

That one sound has **two paths**, and both are shipped:

| | Path 1 — the real recording | Path 2 — the synthesized cha-ching |
|---|---|---|
| Source | `assets/audio/cha-ching.{mp3,wav,ogg,m4a}` | `buildCashRegisterChime()` in `assets/js/reviews-feed.js` |
| Committed? | only once a file is installed **and** its licence is recorded | yes — it is code |
| Plays when | a recording is installed and decodes | always otherwise |
| Managed by | `sound-lab.html` (drop, audition, install — no code changes) | `ALERT_SOUND` in the same file |

Path 1 is what the request asked for: an actual cash-register recording. Path 2
exists because the repository cannot fetch one — every free-sound host reachable
from a build environment is either behind a CDN that needs JavaScript, needs a
login, or is blocked outright — so a clone with no audio file must still make a
sound. Path 2 is not a stub: it is measured against a real recording, and the
measurements are in §3 and §7 below.

`playChaChing()` decides between them at play time. Nothing else differs: same
events, same 2.5 s shared cooldown, same toggle, same run-at-risk path.

---

## 1. Why the synthesized build was rebuilt

The first synthesized build was spectrally plausible and dynamically wrong. It
was rejected three times on listening, which is the correct verdict — but
"it sounds wrong" is not debuggable, so the build and a real recording were both
decoded to PCM and measured over the **whole file** rather than in the narrow
windows the original checks used.

That found the defect precisely. The original 40 checks all passed on a build
whose "cha" was **11 dB too quiet** and whose envelope peaked at once and
decayed, where a real one ramps up over ~45 ms and then *holds* a plateau until
the hammer falls:

| Figure (0–0.6 s unless noted) | Real recording | Replaced build | Shipped now |
|---|---|---|---|
| Body level, p90 of 25 ms frames | −6.5 dB | **−17.5 dB** | −8.2 dB |
| Loudest 25 ms frame (0 → strike) | −6.3 dB | **−16.8 dB** | −7.8 dB |
| Peak minus body | 6.5 dB | **12.7 dB** | 4.8 dB |
| Audible above −40 dB | 1.070 s | **0.780 s** | 1.330 s |
| Onset rise (first frame → loudest) | 14.7 dB | **0.0 dB** | 5.2 dB |
| Plateau p95−p50 (2 ms frames) | 1.06 dB | **4.51 dB** | 1.20 dB |
| Plateau median level | −7.2 dB | **−19.7 dB** | −8.2 dB |
| Mechanism RMS, last 50 ms before the strike | −6.7 dB (R1) | **−20.3 dB** | −9.4 dB |

The lesson is recorded here because it cost three rejections: **narrow-window
checks cannot see a dynamics defect.** Every check the replaced build passed was
a ratio or a single-window level; every check it failed was a whole-file figure.
`tools/render-alert-sound.mjs` §1b now exists only to hold those figures, and it
was validated by running it against the replaced build (9 failures, at exactly
the values predicted from the independent measurement) before being trusted on
the new one.

Two other findings from the same work:

- **The reference's low crest factor is a mastering artifact, not an acoustic
  property.** R1 peaks at −0.0 dBFS — it was hard-limited. A check demanding the
  reference's crest *and* a peak below −3 dBFS demands an RMS 3.3 dB lower, i.e.
  it demands the exact defect above. That check was replaced by level-independent
  plateau-texture checks, and the crest is now reported but not asserted.
- **The duty cycle is the body.** An early attempt fixed the attack count by
  chopping the bed into very short bursts; the attacks went 2 → 6 and the body
  fell to −17.5 dB. Overlapping layers, not isolating them, is what gives a
  mechanism both its attacks and its weight.

---

## 2. The two reference recordings

Descriptions alone cannot settle brightness, balance or timing, so real
recordings were decoded and measured. **Neither is shipped** — the site keeps
zero audio assets by default, and the second file's licence is unknown. Both were
used only to take measurements.

| # | Recording | What it is |
| --- | --- | --- |
| **R1** | npm `stripe-play-ka-ching-sound` 1.0.1 (MIT, © Egbert Teeselink), clip `4kVTqUxJYBA.mp3` | the canonical "ka-ching"; 1.081 s @ 48 kHz once decoded |
| **R2** | `assets/chaching.mp3` from the GitHub project `zommerfelds/global-game-jam-2025` | a second register sound effect; 0.575 s @ 44.1 kHz |

Both were decoded with `mpg123-decoder` and analysed with an FFT, a Goertzel
detector and a 2 ms RMS envelope written for the purpose.

### The "cha"

Measured over the mechanism, on the window *before* the bell strikes:

- **Brightness.** Spectral centroid 6219 Hz (R1) and 6033 Hz (R2). Both are
  flat to within 1.0 / 2.7 dB across the low (150–400 Hz), mid (700–1600 Hz) and
  high (2500–6000 Hz) bands — i.e. the rattle is broadband noise from 150 Hz up,
  not a coloured band.
- **Dynamics.** crest 12.9 / 15.9 dB, and 3 / 10 separate attacks. It is a train
  of events, not a continuous tone or a continuous hiss.
- **Level.** The mechanism is at least as loud as the bell in both: the bell
  measures −0.1 dB (R1) and −4.3 dB (R2) relative to it. The "cha" is not a
  prelude; it is the first syllable, at full weight.
- **Envelope.** R1's 2 ms envelope over the first 200 ms: −24 to −21 dB at
  0–20 ms, −18 to −16 dB at 20–32 ms, −15 to −12 dB at 32–44 ms, then **−6 to
  −9 dB held from 44 ms to 200 ms**. Three steps up, then a plateau. That shape
  is the ground truth behind the `envelope` staircases in `ALERT_SOUND.beds`.

### The "ching"

- **R1** rings at **2098 Hz**. In the 0.23–0.30 s window that peak stands
  **24 dB above everything around it** (−16.0 dB against −40.6 dB for its nearest
  neighbour at 2221 Hz), with a cluster of inharmonic partners at
  2221 / 2256 / 2285 / 2320 / 2350 Hz and further modes at 4805 Hz (2.29×) and
  7734 Hz (3.69×). Tracking that 2098 Hz peak in 10 ms steps from 0.25 s to
  0.95 s gives a decay of **−39.7 dB/s, i.e. a time constant of 0.219 s** — a
  struck bell, not a sustained tone, and 20 dB down about a second after the
  strike.
- **R2**'s bell rings at **1523 / 4463 / 5502 Hz** in the tail (0.28–0.50 s), with
  further modes at 7144, 7978 and 8005 Hz — mode ratios **1 : 2.93 : 3.61 : 4.69
  : 5.24**. None of those is a harmonic.

Nothing in either recording shows a second bell strike after the first.

**Timing.** R1's 2098 Hz onset is at **0.185 s** and its peak at 0.237 s. That is
where `bellStrikes[0].at` comes from, and it is why the mechanism's plateau has to
run to 0.185 s rather than to a rounder number.

---

## 3. Path 2 as shipped: the synthesized cha-ching

Everything lives in `ALERT_SOUND` in `assets/js/reviews-feed.js`; the graph is
built by `buildCashRegisterChime(ctx, destination, t0, spec)` and played by
`playCashRegisterChime()`.

| Time | Layer |
| --- | --- |
| 0.000 s | **key clack** — 55 ms broadband slam at 5.2 kHz, Q 0.70, saturated (`drive` 2.6) |
| 0.002 s | **two mechanism beds** — bright 6.2 → 3.0 kHz (Q 0.35, `rattle` 0.45) and body 1.9 → 0.75 kHz (Q 0.50, `rattle` 0.25), each with an explicit staircase `envelope` |
| 0.002 s | **lever body** — two low tones (182 + 112 Hz), tau 0.050 s |
| 0.014–0.158 s | **six gear clicks**, 24–30 ms each, falling 4.5 kHz → 2.2 kHz at Q 2.6–4.2 |
| 0.045–0.565 s | **the drawer rolls** — noise sweeping 3.3 kHz → 700 Hz, peaking at 0.435 s, i.e. *past* the bell |
| 0.182 s | **hammer tick** — 6 ms at 7.2 kHz, 3 ms before the tone blooms |
| **0.185 s** | **the bell is struck once** — 12 inharmonic partials on a 2098 Hz prime |
| 0.185–~1.0 s | the bell rings down; the 0.5× hum tone (1049 Hz, tau 0.76 s) carries the tail |
| 0.585 s | **the drawer hits its stop** — a low thud (152 + 94 Hz) plus a click |
| → 2.05 s | master envelope: hold to 0.90 s, then fade to silence |

Design decisions, each tied to a measurement above:

- **Two beds, not one.** A real mechanism is broadband and one bandpass cannot
  be. Splitting bright from body also halves each one's sweep, so each loses less
  level to its own filter — a wide sweep silently costs ~7 dB as the centre falls.
- **The beds' envelopes are measured staircases.** Three steps up over the first
  46 ms (where all three countable attacks are), then a **hold** to 0.148/0.150 s,
  then a **give-way** to ~0.32 of peak by 0.176/0.181 s. The steps are wider than
  the reference's because they have to survive the master soft-clipper (§4); the
  give-way is not in the reference at all and is there for a reason: with the
  mechanism still at full level when the bell lands, the bell has no arrival and
  the "CHING" is masked. Dropping the beds at the strike is what made the bell's
  attack measurable (+4.8 dB over the same graph with the bell removed).
- **The clicks overlap.** At 24–30 ms, consecutive gear clicks overlap; at the
  replaced build's 11–16 ms they did not. Overlap is what turns a row of ticks
  into a continuous machine, and it is what brings the crest down.
- **The partials are phase-decorrelated.** The Web Audio API starts every
  `OscillatorNode` at phase 0, so twelve partials struck "together" all reach
  their positive peak on the same sample and sum into one spike. That spike — not
  the bell's loudness — was capping the whole alert's level. `bellPhaseSpread` is
  1.5 ms (~3 cycles of the 2098 Hz prime: too short to hear as a spread, long
  enough that the partials no longer add in phase), and each partial's `phase` is
  deliberately irregular, because a real hammer does not phase-lock a bell's modes.
- **The prime's tau is 0.330 s against the 0.219 s measured on R1.** Held longer
  on purpose: R1's file cuts off at 1.08 s with the bell still ringing, and the
  alert has to stay audible for the 1–2 s that was asked for.

Measured output of the shipped graph (`node tools/render-alert-sound.mjs`, 57
checks, all passing):

```
peak                     -3.3 dBFS        plateau p95-p50        1.20 dB
body p90 (0-0.6 s)       -8.2 dB          plateau std dev        1.72 dB
loudest 25 ms frame      -7.8 dB          plateau median         -8.2 dB
peak minus body           4.8 dB          attacks                   3
audible above -40 dB      1.330 s         "cha" centroid        5602 Hz
audible to (-70 dB)       2.019 s         low/mid/high spread    1.4 dB
mechanism RMS            -9.3 dB          bell vs mechanism     -3.1 dB
bell crest                33.0 dB         prime decay         -25.6 dB/s
prime tau                 0.339 s         ring decay          -28.2 dB/s
20 dB down                0.770 s         silent holes            0 ms
```

---

## 4. The master soft-clipper, and why the alert can be loud at all

The body needs to sit near −8 dB while the peak stays under −3 dBFS. Those two
requirements cannot both be met with a gain node: raising the level to fix the
body raises the peaks into clipping. The replaced build's answer was to turn the
whole alert down (master 0.38), which is exactly the defect in §1.

`ALERT_SOUND.softClip` puts a `WaveShaperNode` on the master bus with

```
y = ceiling * tanh(drive * x) / tanh(drive)      drive 1.9, ceiling 0.68
```

4097 points, `oversample: '4x'`. The slope at x = 0 is
`ceiling * drive / tanh(drive)` = **1.35×**, so quiet material is *lifted*, while
material at full input scale is held at `ceiling` = 0.68 = **−3.4 dBFS**. That is
the whole mechanism by which the body got 9.3 dB louder without the peak getting
higher. `4x` oversampling keeps the saturation from aliasing back into the bell
as fizz.

Two implementation notes, both of which cost a full iteration to find:

- **`DynamicsCompressorNode` is a no-op in `web-audio-engine`.** The output is
  byte-identical with and without it, so a limiter built on it cannot be
  verified offline. A `WaveShaperNode` with a static curve is deterministic and
  *is* processed correctly, which is why the design uses one. In a real browser
  both work; the choice is about what can be proven.
- **`web-audio-engine` silently drops a cross-realm `Float32Array`.** Assigning
  `waveshaper.curve` a `Float32Array` created inside a `node:vm` context leaves
  `curve === null` and the node passes audio through untouched — no error, no
  warning. Real browsers accept any `Float32Array`. The render tool therefore
  puts the host's typed arrays into the VM context, and its §0 guard asserts that
  the curve survived the boundary (correct size, monotonic, antisymmetric,
  passes through zero, max |y| = ceiling, slope at 0 > 1, `oversample` as
  designed) before it trusts a single number that comes after it.

---

## 5. Path 1: the real recording

**The slot.** `ALERT_SAMPLE_PATHS` is probed in order; the first candidate that
fetches, is not an HTML error page, and decodes wins:

```
assets/audio/cha-ching.mp3   .wav   .ogg   .m4a
```

A missing asset costs four fast 404s **once per page load** — `alertSampleAttempted`
latches, so later alerts do not re-probe. The winning path is remembered in
`localStorage` (`replayFeedAlertSamplePath`) so a working install costs exactly
one request.

**Never silent.** If no recording is installed, or it has not finished loading
when an alert fires, `playChaChing()` synthesizes *and* keeps loading in the
background, so the next alert uses the real thing.

**Level.** A recording's true peak (across every channel) is normalized to
**−2.0 dBFS**, clamped to a gain of 0.1×–8×. Stock sound effects are mastered hot
— R1 measures −0.0 dBFS — and an alert over a live scoreboard wants headroom for
a laptop speaker. The clamp stops a near-silent file's noise floor from being
roared up.

**Robustness.** `decodeAudioData` is called through a wrapper that accepts both
the promise and the legacy callback form and settles exactly once. Bytes are
copied before decoding because `decodeAudioData` detaches the buffer it is given.
Anything under 512 bytes, or whose first 512 bytes look like HTML/XML/JSON, is
rejected *before* the decoder sees it — some static hosts answer an unknown path
with `index.html` at status **200**.

**Prime on the first gesture.** Creating an `AudioContext` and fetching the
recording both want a user gesture, so a one-time `pointerdown` / `keydown` /
`touchstart` listener calls `primeAlertSound()`. By the time a user reaches the
sound toggle the recording is usually already decoded, which means the very first
cha-ching they hear is the one every later alert will use. `setSoundEnabled(true)`
plays its preview **synchronously** on the gesture that satisfies autoplay policy
and primes the sample alongside it — an earlier version awaited the load first,
which deferred the preview to a microtask and broke the structure test's
synchronous assertions.

**Installing one.** Three ways, in `assets/audio/README.md`:

1. `sound-lab.html` — drop a file, audition it, read how it measures, click
   **Install on this server**. POSTs the raw bytes to `/api/alert-sound`, which
   writes `assets/audio/cha-ching.<ext>` atomically and removes any other
   extension so the newest upload is unambiguously the alert.
2. Copy the file in by hand.
3. Commit it — which requires `assets/audio/LICENCE.md` first (§6).

The server also serves `GET /api/alert-sound` (what is installed, the candidate
list, the size cap) and `DELETE /api/alert-sound` (back to the synthesizer). Audio
MIME types were added to `server.mjs` at the same time: without them a committed
`.mp3` is served as `application/octet-stream` and some browsers refuse to decode
it, silently falling back to the synthesizer.

Uploads are recognised by **container magic bytes** (`RIFF…WAVE`, `OggS`, `fLaC`,
`ID3`, `ftyp`, ADTS sync, WebM) rather than by a byte histogram. The histogram
version was written first and rejected a perfectly valid WAV: the first 512 bytes
of a 16-bit PCM file are the header plus quiet samples, i.e. dense in bytes below
0x09, which any "looks binary?" control-character test reads as "not media".

### The Sound Lab

`sound-lab.html` is a workbench page, not part of the feed. It loads
`assets/js/reviews-feed.js` **for its audio alone** — the module skips its feed
bootstrap when the page has no `#feed-list`, so the lab never polls statsapi.
`reviews.html` is the only page that ships the module and it does have
`#feed-list`, so nothing about the live feed changed.

It plays the alert through the real code path (`ReplayFeed.playAlertSound()`,
cooldown and all), and separately through each path alone
(`playSynthAlertNow()` / `playAlertSampleNow()`, which bypass the cooldown so the
two can be A/B'd back to back). A dropped file is adopted through
`setAlertSampleFromBytes()` — the same function the tests use — and then measured
in-browser.

Those in-browser measurements are the ones `tools/render-alert-sound.mjs` makes,
computed the same way on the same channel: same dB reference and silence floor,
same percentile index rule, same 25 ms / 2 ms / 10 ms frames with timestamps at
the frame centre, same 2048-point Hann FFT at a 1024 hop, same attack definition,
same plateau window (0.05 s → the shipped strike time, read from
`ALERT_SOUND.bellStrikes[0].at` rather than hardcoded). `tools/sound-lab-page-test.mjs`
§E asserts that agreement, so the page's figures cannot silently stop being
comparable to the documented ones.

---

## 6. Licence position

The sound the request pointed at — YouTube `trR5YxZjfes`, channel
*cashregistersound*, "Cash Register Cha-Ching | Sound Effect | (Kaching)", 0:06,
826k views — links in its own description to a **paid Bandcamp release**. It is
not free to copy, and nothing in this repository is ripped from it. There is no
`yt-dlp` or `ffmpeg` in the build environment either, so it could not have been.

What *was* checked, page by page, as legal sources for a real recording:

| Sound | Author | Length | Licence |
|---|---|---|---|
| [Cash Register (Kaching) — Sound Effect](https://pixabay.com/sound-effects/film-special-effects-cash-register-kaching-sound-effect-125042/) | Modestas123123 (Pixabay) | 0:03 | [Pixabay Content Licence](https://pixabay.com/service/license-summary/) |
| [Cash Register Fake](https://pixabay.com/sound-effects/film-special-effects-cash-register-fake-88639/) | freesound_community / CapsLok (Pixabay, from [Freesound 184438](https://freesound.org/people/CapsLok/sounds/184438/)) | 0:02 | Pixabay Content Licence; underlying Freesound recording is **CC0** |
| [Freesound 184438](https://freesound.org/people/CapsLok/sounds/184438/) | CapsLok | 2.195 s | **CC0** (download requires a login) |

Pixabay Content Licence, per the summary linked above: free for commercial use,
**no attribution required**, may not be sold or redistributed standalone as your
own. No account is needed to download a sound effect. The first of these is the
closest freely hosted match to the reference video — same class of stock SFX,
same title pattern, ~624k plays and ~300k downloads. Neither is *the* video's
sound; nothing freely hosted is.

Pixabay's CDN URLs are not present in the page HTML (the player is
JavaScript-driven), so a build environment cannot download them non-interactively.
That is the reason the recording is a **slot** rather than a committed file: two
clicks in a browser, then drop it on the Sound Lab.

**This repository previously shipped zero audio assets.** Committing one changes
what the repository redistributes, so `assets/audio/README.md` requires an
`assets/audio/LICENCE.md` recording file, title, author, source URL, retrieval
date, licence, whether attribution is required and whether commercial use is
permitted — filled in with what is actually true of the file installed, not copied
from the example. If a licence does require attribution, it belongs there and in
the site's `README.md`.

The two reference recordings in §2 are **measurement references only**. R1's npm
package is MIT but its clip is a YouTube rip (`4kVTqUxJYBA`), and R2's licence is
unlabelled. Neither may be shipped, and neither is.

---

## 7. Verification

Four tools, each checking something the others cannot. All four were
**mutation-tested**: the code or the design was deliberately broken and the tool
was confirmed to fail, because a check that cannot fail is not a check.

### 7a. The structure test — `tools/reviews-feed-test.mjs` (runs in CI, no dependencies)

331 assertions over 1520 lines, of which **158** are the alert sound: 89 in
§11 (the synthesized graph), 21 in §14 (run-at-risk must build the *same* graph)
and 48 in §16 (the real-recording path). It loads the module in a `node:vm` with a stub `AudioContext` and asserts
the *scheduled graph*: every layer at its designed time, the bed envelopes'
staircases and give-ways, both sweeps descending, the rattle actually modulating
the buffer, all 12 partials at fundamental × ratio with no exact harmonic, decay
time constants falling as partials rise, one strike only, the master envelope's
hold and fade, and the whole soft-clip curve (size, monotonic, antisymmetric,
through zero, max |y| = ceiling).

§16 covers path 1, which had no coverage at all before: a fresh clone (all four
candidates 404 → probe resolves null → the alert is still the complete
synthesized graph), a 200 HTML error page (rejected before the decoder, with a
*working* decoder so the guard is what's under test), an installed recording
(adopted, one request, gain = target ÷ peak, one buffer source and **no**
synthesizer graph), the clamps, stereo normalization, a <50 ms stub refused, the
shared toggle and cooldown, `setAlertSampleFromBytes` with no network request,
undecodable bytes falling back to synthesis, and `clearAlertSample()` re-arming
the probe.

Mutation-tested: neutering `looksLikeHtml()` fails the HTML checks; making
`playChaChing()` ignore `alertSample` fails the routing check; removing the peak
normalization fails the gain checks.

Two traps found while writing it, both worth knowing:

- **Cross-realm values are not equal to host values.** `assert.deepEqual` on an
  array built inside the VM fails against a host array with identical contents,
  because `deepStrictEqual` compares prototypes. Same family as the
  `Float32Array` bug in §4.
- **`new Uint8Array(Array.from(str))` is not the bytes of `str`.** Each character
  coerces to `NaN` and becomes `0`, which made an "is this an HTML page?" test
  pass for entirely the wrong reason. Encode by `charCodeAt`.

### 7b. The rendered-PCM check — `tools/render-alert-sound.mjs` (optional dependency)

```sh
npm install --no-save web-audio-engine
node tools/render-alert-sound.mjs alert-sound.wav
```

Renders the shipped graph through a real Web Audio implementation, driven by the
public path a user gesture runs (`setSoundEnabled(true)` → `playAlertSound()` →
`buildCashRegisterChime()`), writes a listenable WAV, and measures the PCM:
**57 checks**, all passing. §0 first proves the harness is measuring the shipped
graph at all (the master bus really ends in the soft-clipper, and the curve
survived the realm boundary). `web-audio-engine` is deliberately not a dependency
of the site or of CI; when it is absent the tool says so and exits 0.

Mutation-tested two ways. Against the **replaced build** it fails 9 checks, at
exactly the figures §1 predicts from independent measurement. Against a design
mutated to `tau: 1.500` (a sustained tone) it fails 3, and at `tau: 0.020` (a
tick) it fails 7.

### 7c. The independent re-measurement — `tools/alert-sound-independent-check.mjs`

```sh
node tools/alert-sound-independent-check.mjs alert-sound.wav
```

Re-measures the same PCM with **fully separate code**: own RIFF parser written
from the spec, own Goertzel detector, own envelope clustering — nothing shared
with 7b, so the two implementations cross-check each other. **15 checks**, all
passing.

It reads the strike time and the prime's tau out of `assets/js/reviews-feed.js`
rather than hardcoding them, because hardcoding had already drifted: the strike
default was 0.170 s against a shipped 0.185 s, and the decay band demanded
steeper than −28 dB/s when the shipped tau of 0.330 s makes a *perfect*
exponential −26.3 dB/s — no build with that design could ever have passed. Both
bands are now derived from the design, with slack justified in-file by a 60 ms
scan of the 2098 Hz band that shows where the drawer slide's peak at ~0.435 s
lifts the late window (the local rate dips to −7.6 dB/s across 0.35–0.41 s for
exactly that reason) and where the master fade after 0.90 s steepens it again
(−35 to −43 dB/s). Still mutation-tested: `tau: 1.500` fails 3 checks, `tau:
0.020` fails 4.

### 7d. The Sound Lab page — `tools/sound-lab-page-test.mjs` (runs in CI, no dependencies)

No browser is available in CI, so this proves what can be proven without one:
**61 checks**. The inline script parses; all 17 element ids the script touches
exist; all 6 loaded files exist; all 10 `ReplayFeed` members it calls are really
exported; the page has no `#feed-list` (so it cannot start polling); and §E pins
the DSP agreement described in §5. Mutation-tested: changing the percentile index
rule, the FFT size, the FFT hop, Hann → Hamming, the DC-bin skip, the attack
comparison window, the 25 ms frame length, the plateau start, or a reference
figure each fails exactly the check that pins it.

---

## 8. What changed, side by side

Every number measured on rendered PCM with the **same** current tool, so the
columns are directly comparable. "References" are R1 / R2 from §2.

| Measurement | references | replaced build | shipped now |
| --- | --- | --- | --- |
| Peak | −0.0 dBFS | −4.7 dBFS | **−3.3 dBFS** |
| Body level p90 | −6.5 dB | −17.5 dB | **−8.2 dB** |
| Loudest 25 ms frame | −6.3 dB | −16.8 dB | **−7.8 dB** |
| Peak minus body | 6.5 dB | 12.7 dB | **4.8 dB** |
| Audible above −40 dB | 1.070 s | 0.780 s | **1.330 s** |
| Onset rise | 14.7 dB | 0.0 dB | **5.2 dB** |
| Plateau p95−p50 | 1.06 dB | 4.51 dB | **1.20 dB** |
| Plateau median | −7.2 dB | −19.7 dB | **−8.2 dB** |
| Mechanism RMS (0 → strike) | −8.7 dB (R1) | −18.5 dB | **−9.3 dB** |
| Mechanism RMS, last 50 ms | −6.7 dB (R1) | −20.3 dB | **−9.4 dB** |
| Bell vs mechanism | −0.1 / −4.3 dB | −1.5 dB | **−3.1 dB** |
| "cha" spectral centroid | 6219 / 6033 Hz | 5729 Hz | **5602 Hz** |
| low/mid/high spread | 1.0 / 2.7 dB | 2.7 dB | **1.4 dB** |
| Attacks | 3 / 10 | 6 | **3** |
| Bell prime | 2098 Hz | 2093 Hz | **2098 Hz** |
| Bell strikes | 1 | 1 | **1** |
| Render-tool checks passed | — | 40/40 (of the old set) | **57/57** |

The replaced build passing 40/40 of its own checks while sounding wrong is the
result that motivated §1 and §7b's whole-file section.

Everything else about the alert — which events fire it, the 2.5 s cooldown, the
sound toggle, the run-at-risk path sharing one sound — is unchanged by this work.

---

## Sources

- Sound Effects catalogue, *Cash Registers* category — clip names and durations
  ("CASH REGISTER CHA-CHING", "Cash Register Key With Bell And Drawer Opens",
  "Antique: Drawer Opens With Bell"):
  <https://www.audiomicro.com/sound-effects/bars-and-restaurants/cash-registers>
- *Cash Register Soundboard* — the "cha" as the gears turning and the
  spring-loaded drawer popping open, and the bell as an anti-theft alert:
  <https://soundboardmax.com/cash-register-soundboard/>
- *Cash Register – Sound Effect* — a sound designer's walkthrough of building the
  cha-ching from household objects:
  <https://www.echosfx.com/free-sound-effects/cash-register-sound-effect>
- *"Cha-ching!": why the cash register came to ring*, Sound Studies 10:1 (2024)
  — the bell as a surveillance mechanism:
  <https://www.tandfonline.com/doi/full/10.1080/20551940.2024.2307721>
- **The reference video**, and why it cannot be copied: YouTube `trR5YxZjfes`,
  channel *cashregistersound*, description linking to a paid Bandcamp release.
- **Legally usable recordings** a real cha-ching can be taken from (§6):
  Pixabay 125042 and Pixabay 88639, and the Pixabay Content Licence summary
  <https://pixabay.com/service/license-summary/>.
- **Measured reference recordings** (analysed as references only, never shipped):
  npm `stripe-play-ka-ching-sound` 1.0.1 (MIT), clip `4kVTqUxJYBA.mp3`;
  `assets/chaching.mp3` from `zommerfelds/global-game-jam-2025` on GitHub
  (licence unknown — used for measurement only).
