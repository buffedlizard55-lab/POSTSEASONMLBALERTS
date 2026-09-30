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

## 1. What a cash-register "cha-ching" actually is

Research (below) converges on the same three physical layers:

| Layer | What it is | What it sounds like |
| --- | --- | --- |
| **"cha"** | the key/lever mechanism, gears and ratchet | a short burst of small mechanical clicks |
| **"ching"** | the register bell — a small, hard metal bell struck by a hammer as the drawer opens | a bright, *inharmonic* metallic ring, ~2 kHz, ringing for about half a second |
| **drawer** | the drawer sliding out on its rollers and hitting its stop | a "shhk" of movement plus a low thud |

Notes from the sources:

- Catalogue descriptions for the classic effect name the exact three layers:
  *"Cash Register Key With Bell And Drawer Opens"*, *"Antique: Drawer Opens With
  Bell"*, and the clip lengths for these "CHA-CHING" effects are typically
  **2 seconds** (audiomicro cash-register category).
- Anatomy write-ups describe the sound as *"a two-part harmony: the
  high-frequency shimmer of a bell and the mid-range crunch of a mechanical
  drawer"*, and explain *why* it exists: the bell was a security feature that
  rang on every drawer opening so the owner heard each sale. The drawer's
  "thud" is a spring-loaded metal drawer sliding open on steel rollers.
- The same history is documented academically in *"Cha-ching!": why the cash
  register came to ring* (Sound Studies 10:1, 2024), whose abstract confirms the
  bell was originally a surveillance mechanism.
- The layering is also how the effect is *made* today: a "cha-ching" can be
  built from household items as long as the three layers are there (bell +
  mechanism + drawer).

### The measured reference clip

To pin down pitch and timing rather than guessing, one freely redistributable
reference was downloaded and analysed (it is **not** shipped — the site keeps
zero audio assets): the clip bundled in the npm package
`stripe-play-ka-ching-sound` (MIT), which plays a ka-ching when a Stripe charge
succeeds. Measured with an FFT/band analyser:

| Measurement | Result |
| --- | --- |
| Length | 1.081 s |
| Bell prime | a strong pair at **2039 Hz / 2098 Hz** (beating, ~59 Hz apart) |
| Strong upper partials | **4805 Hz** and **7734 Hz** ≈ 2.29x and 3.68x the prime → inharmonic, metallic |
| Bell ring decay | ~0.605 s to −20 dB |
| Low band | dense mechanical content ~150–800 Hz, i.e. the drawer/gear layer |
| Mechanical events | energy bursts before and after the bell, not just under it |

Two conclusions went into the design: the bell prime sits **around 2.1 kHz**
(an octave above the C6 chime the previous build used), and the partials are
**inharmonic** with strong 2.2x–3.7x content — that is what makes it read as a
struck metal bell instead of a doorbell.

---

## 2. The design as shipped

Everything lives in `ALERT_SOUND` in `assets/js/reviews-feed.js`; the graph is
built by `buildCashRegisterChime(ctx, destination, t0, spec)` and played by
`playCashRegisterChime()`.

| Time | Layer |
| --- | --- |
| 0.000–0.100 s | four lever/key clicks (band-passed noise bursts) + a low body thump → **"cha"** |
| 0.115–0.400 s | drawer slide: noise whose band sweeps 2600 → 700 Hz |
| 0.162 s | hammer tick, then… |
| 0.165 s | **bell strike 1** |
| 0.309 s | hammer tick, then… |
| 0.312 s | **bell strike 2** (brighter upper partials, a touch softer) |
| 0.400 s | drawer hits its stop: low double thud + click |
| → 1.60 s | bell ring-out |
| → 1.95 s | master fade to silence — the whole alert is **~2 seconds** |

Design decisions worth knowing:

- **One bell pitch, struck twice.** Two hits on the same bell is what a
  double-struck register bell does ("ching-ching"). The second tap is *not*
  detuned: a detuned pair produced a measurable slow warble (envelope residual
  2.5 dB vs 0.6 dB for the same-pitch version), so both hits share
  `bellFundamental = 2093 Hz` (C7, matching the reference).
- **The 0.147 s gap is deliberate.** At 0.155 s the two hits partially cancelled
  each other's 4584 Hz partial (−19 dB relative to the prime); at 0.147 s the
  partials reinforce instead (−5.7 dB).
- **Inharmonic partials with frequency-dependent decay.** 11 partials per strike
  (0.5x hum, a 0.972/1.000/1.013x cluster around the prime, then 1.30x–5.50x),
  each with its own decay constant; higher partials die faster, the hum note
  outlasts everything. That is the mechanism behind "metal".
- **A hammer tick per strike** (9 ms bright noise burst) gives each hit its
  transient definition.
- **Level:** master gain 0.21 → the rendered peak is about **−8 dBFS**, loud
  enough to be an alert, with no clipping anywhere.
- **No assets, no dependencies, no network.** Fully synthesized with the Web
  Audio API, so the alert can never fail to load and there is nothing to license.

---

## 3. Verification

Two independent checks back this up. Both are re-runnable.

### 3a. The structure test (runs in CI, no dependencies)

```bash
node tools/reviews-feed-test.mjs
```

Sections 11 and 14 drive the real public API against a recording AudioContext
stub and check the scheduled graph against `ALERT_SOUND` itself (node counts are
*derived* from the design data, so the test cannot silently drift from the
sound): the mechanism layers and their exact times, the swept drawer filter, the
bell partials at fundamental x ratio, the decay ordering, the rebuilt master
envelope, the run-at-risk path building the identical graph, and the shared
2.5 s cooldown.

### 3b. The rendered-PCM check (optional dependency)

```bash
npm install --no-save web-audio-engine
node tools/render-alert-sound.mjs alert-sound.wav   # writes a listenable WAV
```

This loads the shipped module in a VM whose `AudioContext` is a **real Web Audio
implementation rendering to PCM**, enables the sound toggle exactly like a user
click does, renders it offline, writes a WAV you can play, and then measures the
PCM. Latest run, on the shipped code:

```
1) the alert as a whole
  PASS  rings for at least 1.5 s (request: 1-2 s)   [audible to 1.941 s]
  PASS  does not clip                               [peak -8.4 dBFS]
  PASS  sits at a sensible alert level              [peak -8.4 dBFS]
2) the "cha" mechanism
  PASS  lever/keys are audible before the bell      [peak -20.2 dBFS]
  PASS  the mechanism sits under the bell           [10.0 dB below]
  PASS  the drawer slide is present in the gap      [-36.3 dB RMS]
3) the register bell
  PASS  bell prime at 2093 Hz                       [-22.7 dB]
  PASS  partial 0.5x   (1047 Hz) rings              [-10.6 dB below the prime]
  PASS  partial 0.972x (2034 Hz) rings              [-0.7 dB below the prime]
  PASS  partial 1x     (2093 Hz) rings              [0.0 dB below the prime]
  PASS  partial 1.013x (2120 Hz) rings              [-7.0 dB below the prime]
  PASS  partial 1.3x   (2721 Hz) rings              [-4.2 dB below the prime]
  PASS  partial 1.59x  (3328 Hz) rings              [-10.0 dB below the prime]
  PASS  partial 2.19x  (4584 Hz) rings              [-5.7 dB below the prime]
  PASS  partial 2.42x  (5065 Hz) rings              [-22.0 dB below the prime]
  PASS  partial 2.83x  (5923 Hz) rings              [-17.5 dB below the prime]
  PASS  partial 3.68x  (7702 Hz) rings              [-16.9 dB below the prime]
  PASS  partial 5.5x   (11512 Hz) rings             [-23.2 dB below the prime]
4) the bell is struck twice (A/B against the same graph minus the 2nd tap)
  PASS  the second tap changes the sound at 0.312 s [+3.6 dB vs single strike]
  PASS  a sharp bell attack is detectable           [at 0.167, 0.169, 0.171 s]
5) the ring
  PASS  the ring keeps decaying (no flat tone)      [-13.1 dB/s]
  PASS  the ring decays smoothly (no slow warble)   [residual 0.62 dB]
  PASS  still ringing in the last quarter second    [-43.1 dB RMS]
  PASS  no silent hole inside the alert             [0 ms below -60 dB]

24/24 checks passed
```

The tool exits 0 with a "not installed" notice when `web-audio-engine` is
absent, so the CI smoke suite (which installs nothing) is never affected.

A separate band analysis of the same rendered WAV agrees on every point:
audible to 1.94 s, peak −8.4 dBFS, bell prime and all 11 partials present,
ring decay −12.7 dB/s with a 0.67 dB residual, a re-excitation of the ring at
the second tap, and no gap longer than 0 ms inside the sound. That cross-check
is committed and re-runnable:

```bash
node tools/alert-sound-independent-check.mjs alert-sound.wav
```

It shares **no code** with the render tool (own WAV parser from the RIFF spec,
own Hann-windowed Goertzel detector, own clustering) and re-measures 10
independent facts: the 1–2 s duration, no clipping, mechanism-before-bell
order, the bell window louder than the mechanism, the +3.8 dB re-excitation at
the second tap, the bell prime in the ~2.1 kHz region, inharmonic partials,
and the upper partials dying faster than the prime — the struck-metal
signature. Latest run: 10/10.

### 3c. What the previous sound was

For the record, the build before this one played a 1.6-second two-note sine
chime (C6 → E6, four partials each) with three short noise clacks — a chime, not
a cash register. Everything else about the alert (which events fire it, the
2.5 s cooldown, the sound toggle, the run-at-risk path) is unchanged by this
work.

---

## Sources

- Sound Effects catalogue, *Cash Registers* category — clip names and durations
  ("CASH REGISTER CHA-CHING", "Cash Register Key With Bell And Drawer Opens",
  "Antique: Drawer Opens With Bell"): <https://www.audiomicro.com/sound-effects/bars-and-restaurants/cash-registers>
- *Cash Soundboard* anatomy notes — bell + drawer as a two-part harmony, bell as
  an anti-theft alert: <https://soundboardmax.com/cash-soundboard/>
- *Cash Register Soundboard* history notes — "the 'cha' sound is the noise of
  the heavy-duty internal gears turning and the spring-loaded drawer popping
  open": <https://soundboardmax.com/cash-register-soundboard/>
- *Cash Register – Sound Effect* (sound-design breakdown of the cha-ching):
  <https://www.echosfx.com/free-sound-effects/cash-register-sound-effect>
- *"Cha-ching!": why the cash register came to ring*, Sound Studies 10:1 (2024)
  — the bell as a surveillance mechanism: <https://www.tandfonline.com/doi/full/10.1080/20551940.2024.2307721>
- Measured reference clip: npm `stripe-play-ka-ching-sound` (MIT), clip
  `4kVTqUxJYBA.mp3` — analysed as a reference only, never shipped.
