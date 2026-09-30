# The alert sound: a cha-ching! cash-register ring-up

The site has exactly **one** alert sound. Every tracked event plays it: new
challenges / reviews / boundary calls, official-scorer pending rulings, official
scoring changes, ABS pitch challenges, and the run-at-risk alert (which calls the
same function, see `playRunRiskAlertSound()` in `assets/js/reviews-feed.js`).

This document records what the sound is, where the design came from, and how the
shipped code was verified — because the alert is *synthesized* in the browser
(there is no audio file to listen to in the repository), so the only honest way
to check it is to render the real graph and measure the result.

---

## 1. Why the previous build was rebuilt

The build this one replaces was already a "cash register", and it passed its own
43-check render suite. It still did not sound like one. So the first job was to
find out, by measurement, *where* it diverged from a real cash register.

Two real cash-register recordings were decoded to PCM and analysed (section 2),
and the same measurements were then run on the rendered output of the build being
replaced. The divergence was not in the bell — it was in the "cha":

| measured on the mechanism, before the bell strikes | reference 1 | reference 2 | replaced build |
| --- | --- | --- | --- |
| **spectral centroid** | 6219 Hz | 6033 Hz | **3270 Hz** |
| **low / mid / high band spread** | 1.0 dB | 2.7 dB | **4.2 dB** |
| **peak-to-RMS crest** | 12.9 dB | 15.9 dB | 15.6 dB |
| **separate attacks** (4 ms rises ≥ 6 dB) | 3 | 10 | **2** |
| bell vs mechanism (RMS) | −0.1 dB | −4.3 dB | −0.7 dB |

The centroid is the headline number. A real cash register "cha" is a bright,
broadband, mechanical rattle whose energy centres around **6.1 kHz**; the
replaced build's centred at **3.3 kHz** — an octave lower. Combined with only two
detectable attacks, that is a dark, smooth band of noise: a hiss with a rumble
under it. It is not a machine working. Everything else about that build (one bell
strike, prime near 2.1 kHz, the drawer opening across the bell) measured fine and
was kept.

One caution worth recording: the envelope *standard deviation* looks like an
obvious discriminator (the references measure 5.5 dB and 8.1 dB against the
replaced build's 2.9 dB) but it is not one. Almost all of that gap is the
references' ramp up from silence at the start of the file. Measured over the
steady part only, reference 1 varies by 1.9 dB — smoother than the replaced
build's 2.8 dB. It is not used as a criterion.

---

## 2. The two reference recordings

Descriptions alone cannot settle brightness, balance or timing, so real
recordings were decoded and measured. **Neither is shipped** — the site keeps zero
audio assets, and the second file's licence is unknown. Both were used only to
take measurements.

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

### The "ching"

- **R1** rings at **2098 Hz**. In the 0.23–0.30 s window that peak stands
  **24 dB above everything around it** (−16.0 dB against −40.6 dB for its nearest
  neighbour at 2221 Hz), with a cluster of inharmonic partners at
  2221 / 2256 / 2285 / 2320 / 2350 Hz and further modes at 4805 Hz (2.29× ) and
  7734 Hz (3.69× ). Tracking that 2098 Hz peak in 10 ms steps from 0.25 s to
  0.95 s gives a decay of **−39.7 dB/s, i.e. a time constant of 0.219 s** — a
  struck bell, not a sustained tone, and 20 dB down about a second after the
  strike.
- **R2**'s bell rings at **1523 / 4463 / 5502 Hz** in the tail (0.28–0.50 s), with
  further modes at 7144, 7978 and 8005 Hz — mode ratios **1 : 2.93 : 3.61 : 4.69
  : 5.24**. None of those is a harmonic.

Nothing in either recording shows a second bell strike after the first.

---

## 3. The design as shipped

Everything lives in `ALERT_SOUND` in `assets/js/reviews-feed.js`; the graph is
built by `buildCashRegisterChime(ctx, destination, t0, spec)` and played by
`playCashRegisterChime()`.

| Time | Layer |
| --- | --- |
| 0.000–0.026 s | **key clack** — the loudest and brightest click (6.2 kHz); the syllable's attack |
| 0.004–0.154 s | **mechanism bed** — wide, bright noise (bandpass sweeping 6.5 kHz → 2.4 kHz at Q 0.26) **chopped into uneven bursts** by `rattleEnvelope()` |
| 0.002 s | **lever body** — a quiet low knock (200 + 120 Hz) that sags in pitch |
| 0.018–0.154 s | **six gear clicks**, 11–16 ms each, falling 4.6 kHz → 2.15 kHz at Q 3.1–4.6 so each one rings metal |
| 0.030–0.430 s | **the drawer rolls** — noise sweeping 3.5 kHz → 700 Hz, starting under the mechanism and continuing past the bell |
| 0.167 s | **hammer tick** — a 5 ms bright noise burst at 7.2 kHz |
| **0.170 s** | **the bell is struck** — 11 inharmonic partials on a 2093 Hz prime |
| 0.170–~1.0 s | the bell rings down; the 0.5× hum tone carries the tail |
| 0.455 s | **the drawer hits its stop** — a low thud (148 + 92 Hz) plus a click |
| → 1.95 s | master fade to silence; the alert is audible for **~1.73 s** |

Design decisions, each tied to a measurement above:

- **The bed is a rattle, not a band.** `rattleEnvelope()` multiplies the bed by a
  train of uneven bursts (~9 ms apart, each dying in 3.5 ms, random levels). This
  is the single change that turns the "cha" from a hiss into a machine: measured
  on the rendered PCM it takes the mechanism from 2 attacks to 6.
- **The clicks carry the level, the bed fills in.** The bed is deliberately
  quieter relative to the clicks than in the replaced build (2.40 against 1.45,
  but the clicks are now 2.2–3.1 against 1.1–2.3), so the transients survive
  instead of being smoothed away. The result is a crest of 13.7 dB, right
  between the references' 12.9 and 15.9.
- **Brightness comes from three places**: the clicks ride 2.15–6.2 kHz, the bed
  sweeps 6.5 → 2.4 kHz with a very low Q, and the noise generator's smoothing was
  opened up (one-pole coefficient 0.55 → 0.30, i.e. a cutoff near 4.6 kHz →
  near 9.2 kHz). Together they move the centroid from 3270 Hz to 5729 Hz.
- **The bell keeps R1's prime** (2093 Hz, inside the measured 2098 Hz) **and R2's
  mode ratios** (2.93 / 3.61 / 4.69 / 5.24× ), transposed onto it, plus the 2.29×
  and 3.69× modes measured directly on R1. Every ratio is inharmonic.
- **The prime's tau is 0.28 s**, against the 0.219 s measured on R1, held a
  little longer so the ring carries the 1–2 second alert that was asked for. The
  rendered sound measures tau 0.268 s and is 20 dB down 0.62 s after the strike.
- **Partial time constants fall as the partials rise** (0.460 s for the 0.5× hum
  down to 0.030 s for the 5.24× air mode), so the bright ones die first — that
  spread is what reads as struck metal.
- **Level:** master gain 0.38 → the rendered peak is **−4.7 dBFS**, loud enough
  for an alert with no clipping anywhere.
- **No assets, no dependencies, no network.** Fully synthesized with the Web
  Audio API, so the alert can never fail to load and there is nothing to license.

---

## 4. Verification

Three independent checks back this up. All three are re-runnable.

### 4a. The structure test (runs in CI, no dependencies)

```bash
node tools/reviews-feed-test.mjs
```

Sections 11 and 14 drive the real public API against a recording AudioContext
stub and check the scheduled graph against `ALERT_SOUND` itself — node counts
are *derived* from the design data, so the test cannot silently drift from the
sound. It verifies: the number of noise sources and oscillators, that every
mechanical layer is a band-passed noise burst with a non-silent buffer, the
exact scheduled time of the key clack / each gear click / the mechanism bed /
the drawer / the hammer tick / the drawer stop, that both swept filters run from
their designed high centre down to their low one, **that the mechanism bed's own
noise buffer is chopped into bursts** (its chunked level has a relative standard
deviation above 0.25 and a max/min ratio above 2), **that the beds stay bright**,
that each bell partial sits at fundamental × ratio and decays no slower than the
partial below it, that the bell is struck exactly once with a tick just before
it, the master envelope's length and hold point, that the run-at-risk alert
builds a byte-identical graph, and the shared 2.5 s cooldown. Latest run:
**passes**.

### 4b. The rendered-PCM check (optional dependency)

```bash
npm install --no-save web-audio-engine
node tools/render-alert-sound.mjs alert-sound.wav   # writes a listenable WAV
```

This loads the shipped module in a VM whose `AudioContext` is a **real Web Audio
implementation rendering to PCM**, enables the sound toggle exactly as a user
click does, renders it offline, writes a WAV you can play, and then measures the
PCM. Every threshold in the tool is a number taken from the reference recordings
in section 2, quoted in the tool's header.

The module's `Math.random()` is seeded from inside the VM, so the render is
byte-reproducible and the A/B renders below compare *the same noise* with one
layer removed rather than two different noise fields.

Latest run, on the shipped code — **40/40**:

```
1) the alert as a whole
  PASS  lasts 1-2 seconds as requested        [audible to 1.727 s]
  PASS  does not clip                         [peak -4.7 dBFS]
  PASS  sits at a sensible alert level        [peak -4.7 dBFS]

2) the "cha" mechanism (the layer the replaced build got wrong)
  PASS  the mechanism is loud enough to be a real syllable       [-18.5 dB RMS over 0-0.17 s]
  PASS  the mechanism is at least as loud as the bell            [bell is -1.5 dB vs the mechanism]
  PASS  the "cha" is as bright as a real one                     [centroid 5729 Hz (refs 6033 / 6219)]
  PASS  the "cha" has audible low-frequency content              [12.0 dB]
  PASS  the "cha" has audible mid-frequency content              [11.6 dB]
  PASS  the "cha" has audible high-frequency content             [14.3 dB]
  PASS  the "cha" is broadband across low/mid/high               [2.7 dB spread (refs 1.0 and 2.7)]
  PASS  the "cha" is peaky like a mechanism                      [crest 13.7 dB (refs 12.9 and 15.9)]
  PASS  the "cha" breaks into separate attacks                   [6 attacks (refs 3 and 10; old build 2)]
  PASS  the "cha" is noise-like, not a tone                      [crest 10.8 dB]
  PASS  the mechanism is still running when the bell is struck   [-20.3 dB RMS]

3) the register bell
  PASS  bell prime at 2093 Hz                                    [-18.5 dB]
  PASS  the prime is in the measured register-bell band          [2093 Hz]
  PASS  partial 0.5x (1047 Hz) rings                             [-21.9 dB below the prime]
  PASS  partial 1x (2093 Hz) rings                               [0.0 dB below the prime]
  PASS  partial 1.061x (2221 Hz) rings                           [-17.9 dB below the prime]
  PASS  partial 1.187x (2484 Hz) rings                           [-16.0 dB below the prime]
  PASS  partial 1.502x (3144 Hz) rings                           [-16.3 dB below the prime]
  PASS  partial 2.291x (4795 Hz) rings                           [-12.5 dB below the prime]
  PASS  partial 2.526x (5287 Hz) rings                           [-17.1 dB below the prime]
  PASS  partial 2.93x (6132 Hz) rings                            [-19.5 dB below the prime]
  PASS  partial 3.61x (7556 Hz) rings                            [-28.0 dB below the prime]
  PASS  partial 4.69x (9816 Hz) rings                            [-28.2 dB below the prime]
  PASS  partial 5.24x (10967 Hz) rings                           [-31.4 dB below the prime]
  PASS  no upper partial is an exact harmonic
  PASS  the bell is dominated by its prime — a struck tone       [crest 21.3 dB]
  PASS  the prime rings down like a struck bell                  [-32.4 dB/s]
  PASS  the prime time constant matches the measured 0.22 s      [tau 0.268 s]
  PASS  the prime is 20 dB down within about a second            [0.620 s after the strike]
  PASS  the bright 2.291x partial dies faster than the prime     [-32.0 dB vs -9.9 dB]

4) the bell is struck ONCE, with a hammer tick (seeded A/B renders)
  PASS  the bell layer is clearly audible over the mechanism     [+4.0 dB vs no-bell graph]
  PASS  the hammer tick lands just before the tone               [+4.6 dB]
  PASS  there is no second bell strike                           [largest rise +0.0 dB]
  PASS  a sharp bell attack is detectable at the strike          [at 0.167, 0.169, 0.173 s]

5) the ring
  PASS  the ring keeps decaying (no flat tone)                   [-37.4 dB/s]
  PASS  the ring decays smoothly, without a slow warble          [residual 0.95 dB]
  PASS  no silent hole inside the alert                          [0 ms below -60 dB]
```

The tool exits 0 with a "not installed" notice when `web-audio-engine` is absent,
so the CI smoke suite (which installs nothing) is never affected.

### 4c. The independent re-measurement

```bash
node tools/alert-sound-independent-check.mjs alert-sound.wav 0.170
```

This shares **no code** with the render tool: its own WAV parser written from the
RIFF spec, its own Hann-windowed Goertzel detector, its own averaged-FFT
spectrum, its own peak clustering. It is handed a WAV and a strike time and
re-measures 15 independent facts — the 1–2 s duration, no clipping, the
mechanism's level, that the bell and mechanism sit level with each other, **the
mechanism's brightness, broadbandness and attack count**, the bell prime in the
~2.1 kHz region, inharmonic partials, that the prime never jumps back up (one
strike), that it keeps falling all the way down the ring, the decay rate and time
constant, and the upper partials dying faster than the prime. Latest run:
**15/15**.

---

## 5. What changed, side by side

Every number below is measured on the rendered PCM of each build.

| Measurement | references | replaced build | now |
| --- | --- | --- | --- |
| "cha" spectral centroid | 6219 / 6033 Hz | **3270 Hz** | **5729 Hz** |
| "cha" low/mid/high spread | 1.0 / 2.7 dB | **4.2 dB** | **2.7 dB** |
| "cha" attacks | 3 / 10 | **2** | **6** |
| "cha" crest | 12.9 / 15.9 dB | 15.6 dB | 13.7 dB |
| bell vs mechanism | −0.1 / −4.3 dB | −0.7 dB | −1.5 dB |
| bell prime | 2098 Hz | 2093 Hz | 2093 Hz |
| bell prime tau | 0.219 s | 0.191 s | 0.268 s |
| bell strikes | 1 | 1 | 1 |
| audible length | 1.08 / 0.58 s | 1.72 s | **1.73 s** |

Everything else about the alert (which events fire it, the 2.5 s cooldown, the
sound toggle, the run-at-risk path) is unchanged by this work.

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
- **Measured reference recordings** (analysed as references only, never shipped):
  npm `stripe-play-ka-ching-sound` 1.0.1 (MIT), clip `4kVTqUxJYBA.mp3`;
  `assets/chaching.mp3` from `zommerfelds/global-game-jam-2025` on GitHub
  (licence unknown — used for measurement only).
